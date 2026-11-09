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

export interface SessionPane {
  sessionId: string
  serverId: string
  name: string
  status: SessionStatus
  detail?: string
}

/**
 * A tab holds one or more panes (split view). Each pane is a full session;
 * the tab groups them side by side and carries the broadcast flag: with
 * broadcast on, typing into any pane goes to every pane in the tab.
 */
export interface SessionTab {
  id: string
  panes: SessionPane[]
  activePane: string
  broadcast: boolean
}

function freshTab(server: ServerView, sessionId: string): SessionTab {
  return {
    id: crypto.randomUUID(),
    panes: [
      { sessionId, serverId: server.id, name: server.name, status: 'connecting' as const }
    ],
    activePane: sessionId,
    broadcast: false
  }
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
    case 'notice':
      useSessions.getState().pushNotice(sessionId)
      return
    case 'hostkey': {
      const pane = paneBySession(sessionId)
      const server = pane ? serverById(pane.serverId) : undefined
      useUi.getState().openHostKey({
        sessionId,
        serverId: pane?.serverId ?? '',
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

function paneBySession(sessionId: string): SessionPane | undefined {
  for (const t of useSessions.getState().tabs) {
    const p = t.panes.find((x) => x.sessionId === sessionId)
    if (p) return p
  }
  return undefined
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
  /** Which session's terminal has the search bar open (null = closed). */
  searchFor: string | null
  /** Opens a server in a new tab with a single pane. */
  open: (server: ServerView) => Promise<void>
  /** Splits the given tab: opens the server as an additional pane in it. */
  split: (tabId: string, server: ServerView) => Promise<void>
  /** Focuses a pane inside its tab (also activates the tab). */
  focusPane: (tabId: string, sessionId: string) => void
  select: (which: string | 'servers') => void
  cycle: (direction: 1 | -1) => void
  closeTab: (tabId: string) => void
  closePane: (sessionId: string) => void
  /** Reopens a pane's session in place, keeping its position in the tab. */
  reconnectPane: (sessionId: string) => Promise<void>
  toggleBroadcast: (tabId: string) => void
  setStatus: (sessionId: string, status: SessionStatus, detail?: string) => void
  pushNotice: (sessionId: string) => void
  /** Asks the given session's terminal pane to open its search bar. */
  requestSearch: (sessionId: string | 'servers') => void
  closeSearch: () => void
  registerPort: (sessionId: string, port: SessionPort) => void
  reconnect: (sessionId: string) => Promise<void>
}

export const useSessions = create<SessionsState>((set, get) => ({
  tabs: [],
  active: 'servers',
  searchFor: null,

  open: async (server) => {
    const { sessionId } = await window.sshvault.sessionOpen(server.id)
    const tab = freshTab(server, sessionId)
    set((s) => ({ tabs: [...s.tabs, tab], active: tab.id }))
    // The port may already have been delivered (onSessionPort wired it) or may
    // arrive later (registerPort wires it). Both paths converge here; only
    // wire once to avoid duplicate listeners.
    const port = sessionPorts.get(sessionId)
    if (port && !wiredPorts.has(sessionId)) wirePort(sessionId, port)
  },

  split: async (tabId, server) => {
    const { sessionId } = await window.sshvault.sessionOpen(server.id)
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              panes: [
                ...t.panes,
                { sessionId, serverId: server.id, name: server.name, status: 'connecting' as const }
              ],
              activePane: sessionId
            }
          : t
      ),
      active: tabId
    }))
    const port = sessionPorts.get(sessionId)
    if (port && !wiredPorts.has(sessionId)) wirePort(sessionId, port)
  },

  focusPane: (tabId, sessionId) =>
    set((s) => ({
      active: tabId,
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, activePane: sessionId } : t))
    })),

  select: (which) => set({ active: which }),

  cycle: (direction) => {
    const { tabs, active } = get()
    if (tabs.length === 0) return
    const ids = ['servers', ...tabs.map((t) => t.id)]
    const idx = ids.indexOf(active)
    const next = (idx + direction + ids.length) % ids.length
    set({ active: ids[next] })
  },

  closeTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    for (const pane of tab.panes) teardownPane(pane.sessionId)
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === tabId)
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const active =
        s.active === tabId
          ? (tabs[Math.max(0, idx - 1)]?.id ?? tabs[tabs.length - 1]?.id ?? 'servers')
          : s.active
      return { tabs, active }
    })
  },

  closePane: (sessionId) => {
    teardownPane(sessionId)
    set((s) => {
      const tab = s.tabs.find((t) => t.panes.some((p) => p.sessionId === sessionId))
      if (!tab) return {}
      const panes = tab.panes.filter((p) => p.sessionId !== sessionId)
      if (panes.length === 0) {
        const idx = s.tabs.findIndex((t) => t.id === tab.id)
        const tabs = s.tabs.filter((t) => t.id !== tab.id)
        const active =
          s.active === tab.id
            ? (tabs[Math.max(0, idx - 1)]?.id ?? tabs[tabs.length - 1]?.id ?? 'servers')
            : s.active
        return { tabs, active }
      }
      return {
        tabs: s.tabs.map((t) =>
          t.id === tab.id
            ? { ...t, panes, activePane: t.activePane === sessionId ? panes[0].sessionId : t.activePane }
            : t
        )
      }
    })
  },

  reconnectPane: async (sessionId) => {
    const state = get()
    const tab = state.tabs.find((t) => t.panes.some((p) => p.sessionId === sessionId))
    const pane = tab?.panes.find((p) => p.sessionId === sessionId)
    const server = pane ? serverById(pane.serverId) : undefined
    if (!tab || !server) return
    teardownPane(sessionId)
    const { sessionId: fresh } = await window.sshvault.sessionOpen(server.id)
    // Same tab, same position — only the session underneath is replaced.
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id
          ? {
              ...t,
              panes: t.panes.map((p) =>
                p.sessionId === sessionId
                  ? { sessionId: fresh, serverId: server.id, name: server.name, status: 'connecting' as const }
                  : p
              ),
              activePane: t.activePane === sessionId ? fresh : t.activePane
            }
          : t
      )
    }))
    const port = sessionPorts.get(fresh)
    if (port && !wiredPorts.has(fresh)) wirePort(fresh, port)
  },

  toggleBroadcast: (tabId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, broadcast: !t.broadcast } : t))
    })),

  setStatus: (sessionId, status, detail) => {
    set((s) => ({
      tabs: s.tabs.map((t) => ({
        ...t,
        panes: t.panes.map((p) => (p.sessionId === sessionId ? { ...p, status, detail } : p))
      }))
    }))
    if (status === 'closed' || status === 'error' || status === 'auth-failed') {
      const ui = useUi.getState()
      if (ui.ki?.sessionId === sessionId) ui.closeKi()
    }
  },

  pushNotice: (sessionId) => {
    const w = terminalWriters.get(sessionId)
    w?.('\r\n\x1b[38;5;42m● connection restored — previous output kept above\x1b[0m\r\n')
  },

  requestSearch: (sessionId) => {
    if (sessionId === 'servers') return
    set({ searchFor: sessionId })
  },

  closeSearch: () => set({ searchFor: null }),

  registerPort: (sessionId, port) => {
    sessionPorts.set(sessionId, port)
    wirePort(sessionId, port)
  },

  reconnect: async (sessionId) => {
    await get().reconnectPane(sessionId)
  }
}))

/** Drops every renderer-side handle for a pane's session. */
function teardownPane(sessionId: string): void {
  sessionPorts.get(sessionId)?.close()
  sessionPorts.delete(sessionId)
  terminalWriters.delete(sessionId)
  wiredPorts.delete(sessionId)
  const ui = useUi.getState()
  if (ui.hostkey?.sessionId === sessionId) ui.closeHostKey()
  if (ui.ki?.sessionId === sessionId) ui.closeKi()
  void window.sshvault.sessionClose(sessionId).catch(() => undefined)
}

/** Terminal data pump without React re-renderers. */
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
