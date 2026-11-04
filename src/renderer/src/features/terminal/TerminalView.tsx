import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { FolderClosed, Pencil, RefreshCw, X } from 'lucide-react'
import { FilesPanel } from '../files/FilesPanel'
import { Button } from '../../components/ui'
import { serverById } from '../../stores/vault'
import {
  registerTerminalWriter,
  sessionPorts,
  unregisterTerminalWriter,
  useSessions,
  type SessionTab
} from '../../stores/sessions'
import { useUi } from '../../stores/ui'

const STATUS_META: Record<string, { label: string; color: string }> = {
  connecting: { label: 'Connecting…', color: 'var(--warn)' },
  connected: { label: 'Connected', color: 'var(--ok)' },
  elevated: { label: 'Root', color: 'var(--ok)' },
  'elevated-unverified': { label: 'Root (unverified)', color: 'var(--ok)' },
  'elevated-no-prompt': { label: 'Root (no prompt)', color: 'var(--ok)' },
  'elevate-failed': { label: 'Sudo failed', color: 'var(--warn)' },
  'hostkey-unknown': { label: 'Verify host key', color: 'var(--warn)' },
  'hostkey-changed': { label: 'Host key changed', color: 'var(--danger)' },
  'auth-failed': { label: 'Login failed', color: 'var(--danger)' },
  closed: { label: 'Disconnected', color: 'var(--faint)' },
  error: { label: 'Error', color: 'var(--danger)' }
}

function terminalColors() {
  const cs = getComputedStyle(document.documentElement)
  return {
    background: cs.getPropertyValue('--term-bg').trim() || '#0c111a',
    foreground: cs.getPropertyValue('--term-fg').trim() || '#d5dde8',
    cursor: cs.getPropertyValue('--accent').trim() || '#2dd4bf',
    cursorAccent: '#04211d',
    selectionBackground: 'rgba(45, 212, 191, 0.25)'
  }
}

export function TerminalPane({ tab, isActive }: { tab: SessionTab; isActive: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const server = serverById(tab.serverId)
  const openServerForm = useUi((s) => s.openServerForm)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalColors()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)

    const port = sessionPorts.get(tab.sessionId)
    let lastActivitySent = 0

    const safeFit = () => {
      try {
        if (host.offsetWidth > 0 && host.offsetHeight > 0) {
          fit.fit()
          port?.send({ type: 'resize', cols: term.cols, rows: term.rows })
        }
      } catch {
        /* fit during teardown */
      }
    }
    fitRef.current = safeFit
    safeFit()

    registerTerminalWriter(tab.sessionId, (data) => term.write(data))

    term.onData((data) => {
      port?.send({ type: 'input', data })
      const now = Date.now()
      if (now - lastActivitySent > 1000) {
        lastActivitySent = now
        port?.send({ type: 'activity' })
      }
    })

    // PuTTY-style: selecting text copies it.
    term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel).catch(() => undefined)
    })

    /**
     * Clipboard. Inside the terminal, Ctrl+Shift+C copies the selection and
     * Ctrl+Shift+V pastes; plain Ctrl+C keeps sending SIGINT to the remote
     * shell, which is what a terminal user expects. Both are intercepted here
     * (xterm's key handler) because the browser default for Ctrl+V would never
     * reach the PTY.
     */
    const paste = async () => {
      try {
        const text = await navigator.clipboard.readText()
        if (!text) return
        // Bracketed paste stops multi-line pastes from executing every line
        // immediately (and lets vim/readline treat it as one paste).
        port?.send({ type: 'input', data: `\x1b[200~${text}\x1b[201~` })
      } catch {
        /* clipboard permission denied */
      }
    }

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
        const sel = term.getSelection()
        if (sel) void navigator.clipboard.writeText(sel).catch(() => undefined)
        return false
      }
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') {
        void paste()
        return false
      }
      // Windows Terminal convention: Ctrl+Insert / Shift+Insert.
      if (ev.ctrlKey && ev.code === 'Insert') {
        const sel = term.getSelection()
        if (sel) void navigator.clipboard.writeText(sel).catch(() => undefined)
        return false
      }
      if (ev.shiftKey && ev.code === 'Insert') {
        void paste()
        return false
      }
      return true
    })

    // Right-click: copy when there's a selection, otherwise paste (PuTTY-like).
    const onContext = (e: MouseEvent) => {
      e.preventDefault()
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel).catch(() => undefined)
      else void paste()
    }
    host.addEventListener('contextmenu', onContext)

    const observer = new ResizeObserver(safeFit)
    observer.observe(host)

    // Re-theme live terminals when the app theme flips.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = terminalColors()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    if (isActive) term.focus()

    return () => {
      observer.disconnect()
      themeObserver.disconnect()
      host.removeEventListener('contextmenu', onContext)
      unregisterTerminalWriter(tab.sessionId)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.sessionId])

  // Refit when the pane becomes visible again (xterm can't size hidden DOM).
  useEffect(() => {
    if (isActive) {
      const t = setTimeout(() => fitRef.current?.(), 20)
      return () => clearTimeout(t)
    }
  }, [isActive])

  const meta = STATUS_META[tab.status] ?? STATUS_META.connected
  const showConnecting = tab.status === 'connecting' || tab.status === 'hostkey-unknown' || tab.status === 'hostkey-changed'
  const showFailure =
    tab.status === 'auth-failed' || tab.status === 'error' || tab.status === 'closed'

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={hostRef} className="h-full w-full bg-[var(--term-bg)]" />

      {/* Fades in/out instead of popping, so switching tabs and connecting
          feel continuous rather than flickering. `visibility` (not just
          opacity) keeps stale status text out of the accessibility tree and
          out of any screenshot/DOM reading once connected. */}
      <div
        className={`absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg/70 backdrop-blur-[1px] transition-[opacity,visibility] duration-200 ease-out ${
          showConnecting
            ? 'visible opacity-100'
            : 'invisible opacity-0 delay-200'
        }`}
        aria-hidden={!showConnecting}
      >
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
        <span className="text-[13px] text-muted">
          Connecting to <span className="font-mono text-fg">{tab.name}</span>…
        </span>
        <span className="text-[11.5px] text-faint">
          {tab.status === 'hostkey-unknown'
            ? 'Waiting for you to verify the host key'
            : tab.status === 'hostkey-changed'
              ? 'Host key changed — connection blocked'
              : 'Establishing secure channel'}
        </span>
      </div>

      {showFailure && (
        <div className="banner-in absolute inset-x-0 top-3 mx-auto w-fit max-w-[90%]">
          <div className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-2.5 shadow-xl">
            <span className="text-[13px] text-fg">
              <span style={{ color: meta.color }} className="font-medium">
                {meta.label}
              </span>
              {tab.detail ? <span className="text-muted"> — {tab.detail}</span> : null}
            </span>
            <div className="flex items-center gap-1.5">
              {server && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => openServerForm(server)}
                >
                  <Pencil size={13} />
                  Edit
                </Button>
              )}
              <Button size="sm" onClick={() => void useSessions.getState().reconnect(tab.sessionId)}>
                <RefreshCw size={13} />
                Reconnect
              </Button>
              <Button size="sm" variant="ghost" onClick={() => useSessions.getState().closeTab(tab.sessionId)}>
                <X size={13} />
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {tab.status === 'elevate-failed' && tab.detail && (
        <div className="absolute inset-x-0 bottom-3 mx-auto flex w-fit max-w-[90%] items-center gap-3 rounded-lg border border-warn/40 bg-warn-soft px-3 py-1.5 text-[12.5px] text-warn shadow-lg">
          <span>Auto-sudo: {tab.detail}</span>
          <button
            onClick={() => sessionPorts.get(tab.sessionId)?.send({ type: 'input', data: 'stty echo\r' })}
            className="shrink-0 rounded border border-warn/50 px-2 py-0.5 text-[11.5px] font-medium transition-colors duration-150 hover:bg-warn/20"
            title="If typing is invisible, this restores terminal echo"
          >
            Restore echo
          </button>
        </div>
      )}
    </div>
  )
}

export function TerminalView() {
  const tabs = useSessions((s) => s.tabs)
  const active = useSessions((s) => s.active)
  const select = useSessions((s) => s.select)
  const closeTab = useSessions((s) => s.closeTab)
  const stripRef = useRef<HTMLDivElement>(null)
  const [filesOpen, setFilesOpen] = useState(false)

  const activeTab = tabs.find((t) => t.sessionId === active)
  const filesUsable =
    !!activeTab && (activeTab.status === 'connected' || activeTab.status.startsWith('elevated'))

  // The Files panel belongs to a specific terminal tab. Deriving this instead
  // of syncing it in an effect avoids a cascading render, and guarantees the
  // panel can never be open while the server list is showing.
  const filesVisible = filesOpen && active !== 'servers'

  // Keep the active tab visible when tabs overflow the strip.
  useEffect(() => {
    const strip = stripRef.current
    if (!strip || active === 'servers') return
    const el = strip.querySelector<HTMLElement>(`[data-tab="${active}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [active, tabs.length])

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
        <button
          onClick={() => select('servers')}
          className={`flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition-colors duration-150 ${
            active === 'servers' ? 'bg-panel-2 text-fg' : 'text-muted hover:bg-panel-2/60 hover:text-fg'
          }`}
        >
          Servers
        </button>
        <div className="mx-1 h-5 w-px shrink-0 bg-line" />

        {/* Scrollable tab strip: many sessions stay reachable instead of
            being clipped off the right edge. */}
        <div
          ref={stripRef}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((t) => {
            const meta = STATUS_META[t.status] ?? STATUS_META.connected
            const isActive = active === t.sessionId
            return (
              <div
                key={t.sessionId}
                data-tab={t.sessionId}
                className={`group flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3 text-[13px] transition-colors duration-150 ${
                  isActive ? 'bg-panel-2 text-fg' : 'text-muted hover:bg-panel-2/60 hover:text-fg'
                }`}
                onClick={() => select(t.sessionId)}
                title={`${t.name} — ${meta.label}`}
              >
                <span
                  className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
                  style={{
                    background: meta.color,
                    animation:
                      t.status === 'connecting' ? 'pulse-dot 1.6s ease-in-out infinite' : undefined
                  }}
                />
                <span className="max-w-40 truncate">{t.name}</span>
                {meta.label === 'Root' || t.status.startsWith('elevated') ? (
                  <span className="rounded border border-accent/40 px-1 text-[10px] font-semibold tracking-wide text-accent">
                    ROOT
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={`Close ${t.name} tab`}
                  className="rounded p-0.5 text-faint opacity-0 transition-opacity duration-150 hover:text-danger group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(t.sessionId)
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            )
          })}
        </div>

        <button
          type="button"
          onClick={() => setFilesOpen((v) => !v)}
          disabled={!filesUsable}
          title={filesUsable ? 'Browse and transfer files (SFTP)' : 'Connect first to transfer files'}
          aria-pressed={filesOpen}
          className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] transition-colors duration-150 disabled:opacity-40 ${
            filesOpen ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-panel-2 hover:text-fg'
          }`}
        >
          <FolderClosed size={14} />
          Files
        </button>

        {tabs.length > 1 && (
          <span className="shrink-0 pr-1 text-[11px] tabular-nums text-faint" title="Open sessions">
            {tabs.length}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {tabs.map((t) => (
            <div
              key={t.sessionId}
              className="absolute inset-0"
              style={{ visibility: active === t.sessionId ? 'visible' : 'hidden' }}
            >
              <TerminalPane tab={t} isActive={active === t.sessionId} />
            </div>
          ))}
        </div>

        {filesVisible && activeTab && (
          <aside className="w-[360px] shrink-0 border-l border-line">
            <FilesPanel
              key={activeTab.serverId}
              serverId={activeTab.serverId}
              onClose={() => setFilesOpen(false)}
            />
          </aside>
        )}
      </div>
    </div>
  )
}
