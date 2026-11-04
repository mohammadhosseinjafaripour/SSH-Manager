import { create } from 'zustand'
import type { MainPortMessage, ServerView, SessionPort, SessionStatus } from '@shared/types'
import { useUi } from './ui'
import { serverById } from './vault'

/**
 * Ports and terminal writers live in module registries, not zustand state:
 * they are non-serializable handles carrying high-frequency terminal traffic.
 */
export const sessionPorts = new Map<string, SessionPort>()
export const terminalWriters = new Map<string, (data: string) => void>()

/**
 * Output that arrived before xterm mounted. The SSH banner/motd can reach us
 * in the same tick the session opens, while the terminal component is still
 * rendering — without this buffer those first bytes were silently dropped.
 */
const pendingOutput = new Map<string, string[]>()

export interface SessionTab {
  sessionId: string
  serverId: string
  name: string
  status: SessionStatus
  detail?: string
}

function dispatchPortMessage(sessionId: string, msg: MainPortMessage): void {
  switch (msg.type) {
    case 'data': {
      const write = terminalWriters.get(sessionId)
      if (write) {
        write(msg.data)
      } else {
        // Terminal not mounted yet — hold the bytes and flush on registration.
        const buf = pendingOutput.get(sessionId)
        if (buf) buf.push(msg.data)
        else pendingOutput.set(sessionId, [msg.data])
      }
      return
    }
    case 'status':
      useSessions.getState().setStatus(sessionId, msg.status, msg.detail)
      return
    case 'hostkey': {
      const tab = useSessions.getState().tabs.find((t) => t.sessionId === sessionId)
      const server = tab ? serverById(tab.serverId) : undefined
      useUi.getState().openHostKey({
        sessionId,
        serverId: tab?.serverId ?? '',
        serverName: server?.name ?? 'this server',
        kind: msg.kind,
        fingerprint: msg.fingerprint,
        pinnedFingerprint: msg.pinnedFingerprint
      })
      return
    }
    case 'ki':
      useUi.getState().openKi({ sessionId, name: msg.name, instruction: msg.instruction, prompts: msg.prompts })
      return
  }
}

/** Guards against wiring the same port twice (duplicate data delivery). */
const wiredPorts = new Set<string>()

function wirePort(sessionId: string, port: SessionPort): void {
  if (wiredPorts.has(sessionId)) return
  wiredPorts.add(sessionId)
  port.onMessage((msg) => dispatchPortMessage(sessionId, msg))
}

interface SessionsState {
  tabs: SessionTab[]
  active: string | 'servers'
  open: (server: ServerView) => Promise<void>
  select: (which: string | 'servers') => void
  cycle: (direction: 1 | -1) => void
  closeTab: (sessionId: string) => void
  setStatus: (sessionId: string, status: SessionStatus, detail?: string) => void
  registerPort: (sessionId: string, port: SessionPort) => void
  reconnect: (sessionId: string) => Promise<void>
}

export const useSessions = create<SessionsState>((set, get) => ({
  tabs: [],
  active: 'servers',

  open: async (server) => {
    const { sessionId } = await window.sshvault.sessionOpen(server.id)
    set((s) => ({
      tabs: [...s.tabs, { sessionId, serverId: server.id, name: server.name, status: 'connecting' }],
      active: sessionId
    }))
    // The port may already have been delivered (onSessionPort wired it) or may
    // arrive later (registerPort wires it). Both paths converge here; only
    // wire once to avoid duplicate listeners.
    const port = sessionPorts.get(sessionId)
    if (port && !wiredPorts.has(sessionId)) wirePort(sessionId, port)
  },

  select: (which) => set({ active: which }),

  cycle: (direction) => {
    const { tabs, active } = get()
    if (tabs.length === 0) return
    const ids = ['servers', ...tabs.map((t) => t.sessionId)]
    const idx = ids.indexOf(active)
    const next = (idx + direction + ids.length) % ids.length
    set({ active: ids[next] })
  },

  closeTab: (sessionId) => {
    sessionPorts.get(sessionId)?.close()
    sessionPorts.delete(sessionId)
    terminalWriters.delete(sessionId)
    wiredPorts.delete(sessionId)
    void window.sshvault.sessionClose(sessionId).catch(() => undefined)
    const ui = useUi.getState()
    if (ui.hostkey?.sessionId === sessionId) ui.closeHostKey()
    if (ui.ki?.sessionId === sessionId) ui.closeKi()
    set((s) => {
      const tabs = s.tabs.filter((t) => t.sessionId !== sessionId)
      const active =
        s.active === sessionId
          ? (tabs[tabs.findIndex((t) => t.sessionId === sessionId) - 1]?.sessionId ??
            tabs[tabs.length - 1]?.sessionId ??
            'servers')
          : s.active
      return { tabs, active }
    })
  },

  setStatus: (sessionId, status, detail) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.sessionId === sessionId ? { ...t, status, detail } : t))
    }))
    if (status === 'closed' || status === 'error' || status === 'auth-failed') {
      const ui = useUi.getState()
      if (ui.ki?.sessionId === sessionId) ui.closeKi()
    }
  },

  registerPort: (sessionId, port) => {
    sessionPorts.set(sessionId, port)
    wirePort(sessionId, port)
  },

  reconnect: async (sessionId) => {
    const tab = get().tabs.find((t) => t.sessionId === sessionId)
    const server = tab ? serverById(tab.serverId) : undefined
    if (!server) return
    get().closeTab(sessionId)
    await get().open(server)
  }
}))

/** Terminal data pump without React re-renders. */
export function registerTerminalWriter(sessionId: string, write: (data: string) => void): void {
  terminalWriters.set(sessionId, write)
  // Flush anything that arrived while the terminal was mounting.
  const buffered = pendingOutput.get(sessionId)
  if (buffered) {
    pendingOutput.delete(sessionId)
    for (const chunk of buffered) write(chunk)
  }
}

export function unregisterTerminalWriter(sessionId: string): void {
  terminalWriters.delete(sessionId)
  pendingOutput.delete(sessionId)
}
