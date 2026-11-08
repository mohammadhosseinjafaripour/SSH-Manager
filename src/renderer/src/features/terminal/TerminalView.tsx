import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FolderClosed,
  Pencil,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { FilesPanel } from '../files/FilesPanel'
import { Button, IconButton, Input } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { serverById, useVault } from '../../stores/vault'
import { useInlineCompletion } from './useInlineCompletion'
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

/**
 * Terminal search. Uses xterm's search addon, so it walks the real scrollback
 * buffer rather than the DOM, and highlights every match.
 */
function SearchBar({ search, onClose }: { search: SearchAddon | null; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [hits, setHits] = useState<{ index: number; count: number }>({ index: 0, count: 0 })
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    if (!search) return
    const sub = search.onDidChangeResults((e) =>
      setHits({ index: e.resultIndex, count: e.resultCount })
    )
    return () => sub.dispose()
  }, [search])

  const run = (dir: 'next' | 'prev') => {
    if (!query) return
    const opts = { caseSensitive, wholeWord, incremental: true }
    if (dir === 'next') search?.findNext(query, opts)
    else search?.findPrevious(query, opts)
  }

  return (
    <div className="banner-in absolute right-3 top-2 z-20 flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2 py-1.5 shadow-xl">
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          if (e.target.value) {
            search?.findNext(e.target.value, { caseSensitive, wholeWord, incremental: true })
          } else {
            search?.clearDecorations()
            setHits({ index: 0, count: 0 })
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            run(e.shiftKey ? 'prev' : 'next')
          } else if (e.key === 'Escape') {
            e.preventDefault()
            search?.clearDecorations()
            onClose()
          }
        }}
        placeholder="Find in terminal…"
        aria-label="Find in terminal"
        leftIcon={<Search size={13} />}
        className="w-44"
        classNames={{
          field: 'h-6 border-transparent bg-transparent',
          input: 'pl-7 text-[12.5px]',
          leftIcon: 'left-2'
        }}
      />
      <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-faint">
        {query ? `${hits.count === 0 ? 0 : hits.index + 1}/${hits.count}` : ''}
      </span>
      <IconButton
        label="Previous match"
        onClick={() => run('prev')}
        disabled={!query}
        className="h-6 w-6 text-muted hover:bg-panel-2 hover:text-fg"
      >
        <ChevronUp size={13} />
      </IconButton>
      <IconButton
        label="Next match"
        onClick={() => run('next')}
        disabled={!query}
        className="h-6 w-6 text-muted hover:bg-panel-2 hover:text-fg"
      >
        <ChevronDown size={13} />
      </IconButton>
      <Button
        variant="ghost"
        onClick={() => {
          const next = !caseSensitive
          setCaseSensitive(next)
          if (query) search?.findNext(query, { caseSensitive: next, wholeWord, incremental: true })
        }}
        title="Match case"
        aria-pressed={caseSensitive}
        className={`h-auto min-h-0 rounded px-1.5 py-0.5 font-mono text-[10.5px] font-normal hover:bg-transparent ${
          caseSensitive ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
        }`}
      >
        Aa
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          const next = !wholeWord
          setWholeWord(next)
          if (query) search?.findNext(query, { caseSensitive, wholeWord: next, incremental: true })
        }}
        title="Whole word"
        aria-pressed={wholeWord}
        className={`h-auto min-h-0 rounded px-1.5 py-0.5 font-mono text-[10.5px] font-normal hover:bg-transparent ${
          wholeWord ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
        }`}
      >
        ab
      </Button>
      <IconButton
        label="Close search"
        onClick={() => {
          search?.clearDecorations()
          onClose()
        }}
        className="h-6 w-6 text-faint hover:bg-panel-2 hover:text-fg"
      >
        <X size={13} />
      </IconButton>
    </div>
  )
}

export function TerminalPane({ tab, isActive }: { tab: SessionTab; isActive: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  // The addon lives in state (not a ref) because it is read during render when
  // the search bar mounts; a ref read there would be unsafe under concurrent
  // rendering.
  const [search, setSearch] = useState<SearchAddon | null>(null)
  const autocompleteOn = useVault((st) => st.settings.autocomplete !== false)
  const completion = useInlineCompletion({ serverId: tab.serverId, enabled: autocompleteOn })
  // Where to paint the ghost: the cursor cell, measured from the renderer's
  // own dimensions (cell size = screen width / cols).
  const [cursorPos, setCursorPos] = useState<{ left: number; top: number } | null>(null)
  // Visibility lives in the store so the toolbar button, the keyboard shortcut
  // and the pane all agree without effects or ref reads.
  const searchOpen = useSessions((s) => s.searchFor) === tab.sessionId
  const closeSearch = useSessions((s) => s.closeSearch)
  const requestSearch = useSessions((s) => s.requestSearch)

  // ---- drag & drop upload onto the terminal -------------------------------
  // Independent of the Files panel: drops go to the server's home directory
  // over a short-lived SFTP connection, so a plain terminal works too.
  const canDrop =
    tab.status === 'connected' ||
    tab.status === 'elevated' ||
    tab.status === 'elevated-unverified' ||
    tab.status === 'elevated-no-prompt'
  const [dropState, setDropState] = useState<'idle' | 'over' | 'busy' | 'done' | 'error'>('idle')
  const [dropMsg, setDropMsg] = useState<string>('')
  const dropDepth = useRef(0)
  const dropTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (dropTimer.current) clearTimeout(dropTimer.current)
    }
  }, [])

  const finishDrop = (state: 'done' | 'error', msg: string) => {
    setDropState(state)
    setDropMsg(msg)
    dropTimer.current = setTimeout(() => setDropState('idle'), 3500)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dropDepth.current = 0
    if (!canDrop) {
      finishDrop('error', 'Connect to the server first')
      return
    }
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length === 0) return
    // File.path no longer exists in Electron — the preload resolves each File
    // to its absolute path while the drop event still owns the objects.
    const paths = files.map((f) => window.sshvault.pathForFile(f)).filter(Boolean)
    if (paths.length === 0) {
      finishDrop('error', 'Could not read the dropped files')
      return
    }
    setDropState('busy')
    setDropMsg(`Uploading ${paths.length} item${paths.length === 1 ? '' : 's'}…`)
    try {
      const res = await window.sshvault.sftpUploadToServer({
        serverId: tab.serverId,
        localPaths: paths
      })
      finishDrop('done', `Uploaded ${res.uploaded} item(s) to ${res.remoteDir}`)
    } catch (err) {
      finishDrop('error', friendlyError(err))
    }
  }

  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dropDepth.current++
    if (canDrop) setDropState('over')
  }
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    dropDepth.current = Math.max(0, dropDepth.current - 1)
    if (dropDepth.current === 0 && dropState === 'over') setDropState('idle')
  }
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = canDrop ? 'copy' : 'none'
    }
  }
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
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    setSearch(searchAddon)
    term.open(host)

    /** Repositions the ghost overlay on the cursor cell. */
    const syncCursor = () => {
      try {
        const buf = term.buffer.active
        const screenEl = host.querySelector('.xterm-screen') as HTMLElement | null
        if (!buf || !screenEl) return
        const rect = screenEl.getBoundingClientRect()
        const cellW = rect.width / Math.max(1, term.cols)
        const cellH = rect.height / Math.max(1, term.rows)
        setCursorPos({
          left: rect.left + buf.cursorX * cellW,
          top: rect.top + buf.cursorY * cellH
        })
      } catch {
        // Terminal not laid out yet; the next cursor move retries.
      }
    }
    term.onCursorMove(syncCursor)
    term.onResize(syncCursor)
    syncCursor()

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
      // Tab accepts the ghost suggestion when one is showing; otherwise Tab
      // falls through to the remote shell's own completion.
      if (ev.code === 'Tab' && !ev.ctrlKey && !ev.altKey && completion.ghost) {
        const accepted = completion.accept()
        if (accepted) {
          port?.send({ type: 'input', data: accepted })
          completion.feed(accepted)
        }
        return false
      }
      // Up/Down cycle through the candidate list while a suggestion is showing.
      // When there is no suggestion they fall through to shell history.
      if ((ev.code === 'ArrowUp' || ev.code === 'ArrowDown') && !ev.ctrlKey && !ev.altKey) {
        const moved = completion.cycle(ev.code === 'ArrowDown' ? 1 : -1)
        if (moved) return false
      }
      // Right arrow accepts just the next word/segment, like fish/zsh.
      if (ev.code === 'ArrowRight' && !ev.ctrlKey && !ev.altKey && completion.ghost) {
        const part = completion.acceptWord()
        if (part) {
          port?.send({ type: 'input', data: part })
          completion.feed(part)
        }
        return false
      }
      // Esc dismisses the suggestion without touching the shell.
      if (ev.code === 'Escape' && completion.ghost) {
        completion.clear()
        return false
      }
      // Ctrl+Shift+F opens the in-terminal search (plain Ctrl+F still reaches
      // the remote shell, e.g. readline's forward-char).
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyF') {
        requestSearch(tab.sessionId)
        return false
      }
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
    <div
      className="relative h-full w-full overflow-hidden"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => void handleDrop(e)}
    >
      <div ref={hostRef} className="h-full w-full bg-[var(--term-bg)]" />

      {/* Drop-to-upload overlay (terminal-level, independent of the Files panel) */}
      {(dropState === 'over' || dropState === 'busy' || dropState === 'done' || dropState === 'error') && (
        <div
          className={`pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 backdrop-blur-[2px] ${
            dropState === 'error'
              ? 'bg-danger/10'
              : dropState === 'done'
                ? 'bg-[color-mix(in_srgb,var(--ok)_12%,transparent)]'
                : 'bg-bg/80'
          }`}
        >
          {dropState === 'over' && (
            <>
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border-2 border-dashed border-accent text-accent">
                <ArrowDownToLine size={24} />
              </div>
              <p className="text-[13px] font-medium text-fg">Drop to upload</p>
              <p className="text-[11.5px] text-muted">Files and folders go to your home directory</p>
            </>
          )}
          {dropState === 'busy' && (
            <>
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
              <p className="text-[13px] text-muted">{dropMsg}</p>
            </>
          )}
          {dropState === 'done' && (
            <>
              <CheckCircle2 size={26} className="text-ok" />
              <p className="text-[13px] text-ok">{dropMsg}</p>
            </>
          )}
          {dropState === 'error' && (
            <>
              <AlertTriangle size={26} className="text-danger" />
              <p className="max-w-[80%] text-center text-[13px] text-danger">{dropMsg}</p>
            </>
          )}
        </div>
      )}

      {/* Inline completion ghost text. Rendered as an overlay, never written
          into the terminal buffer — a wrong guess can never corrupt the PTY. */}
      {completion.ghost && cursorPos && (
        <div
          className="pointer-events-none absolute z-20 whitespace-pre font-mono text-[13px] leading-[1.25] text-muted/55"
          style={{ left: cursorPos.left, top: cursorPos.top }}
          aria-hidden="true"
        >
          {completion.ghost.text}
          {completion.ghost.hint && (
            <span className="ml-2 text-[10.5px] text-faint/70">{completion.ghost.hint}</span>
          )}
          {completion.suggestions.length > 1 && (
            <span className="ml-1.5 text-[10px] tabular-nums text-faint/60">
              {completion.activeIndex + 1}/{completion.suggestions.length}
            </span>
          )}
          <span className="ml-1.5 rounded border border-line/70 px-1 text-[9px] uppercase tracking-wide text-faint/60">
            {completion.suggestions.length > 1 ? 'tab · ↑↓' : 'tab'}
          </span>
        </div>
      )}
      {searchOpen && search && (
        <SearchBar search={search} onClose={closeSearch} />
      )}

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
          <Button
            variant="outline"
            onClick={() => sessionPorts.get(tab.sessionId)?.send({ type: 'input', data: 'stty echo\r' })}
            className="h-auto min-h-0 shrink-0 rounded border-warn/50 px-2 py-0.5 text-[11.5px] font-medium text-warn hover:bg-warn/20"
            title="If typing is invisible, this restores terminal echo"
          >
            Restore echo
          </Button>
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
  // Panel width is user-resizable (filenames were unreadable at a fixed 360px)
  // and persisted so the choice survives restarts.
  const [filesWidth, setFilesWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('sshvault-files-width'))
    return Number.isFinite(saved) && saved >= 320 ? saved : 420
  })
  useEffect(() => {
    localStorage.setItem('sshvault-files-width', String(filesWidth))
  }, [filesWidth])
  const dragState = useRef<{ startX: number; startW: number } | null>(null)

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
        <Button
          variant="ghost"
          onClick={() => select('servers')}
          className={`h-8 shrink-0 gap-2 rounded-lg px-3 text-[13px] ${
            active === 'servers'
              ? 'bg-panel-2 font-medium text-fg hover:bg-panel-2'
              : 'font-medium text-muted hover:bg-panel-2/60 hover:text-fg'
          }`}
        >
          Servers
        </Button>
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
                <IconButton
                  label={`Close ${t.name} tab`}
                  className="h-5 w-5 text-faint opacity-0 hover:bg-transparent hover:text-danger group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(t.sessionId)
                  }}
                >
                  <X size={13} />
                </IconButton>
              </div>
            )
          })}
        </div>

        <IconButton
          label="Find in terminal (Ctrl+Shift+F)"
          onClick={() => useSessions.getState().requestSearch(active)}
          disabled={!activeTab}
          className="h-8 w-8 shrink-0 text-muted hover:bg-panel-2 hover:text-fg"
        >
          <Search size={14} />
        </IconButton>

        <Button
          variant="ghost"
          onClick={() => setFilesOpen((v) => !v)}
          disabled={!filesUsable}
          title={filesUsable ? 'Browse and transfer files (SFTP)' : 'Connect first to transfer files'}
          aria-pressed={filesOpen}
          className={`h-8 shrink-0 gap-1.5 rounded-lg px-2.5 text-[12.5px] font-normal ${
            filesOpen ? 'bg-accent-soft text-accent hover:bg-accent-soft' : 'text-muted hover:bg-panel-2 hover:text-fg'
          }`}
        >
          <FolderClosed size={14} />
          Files
        </Button>

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
          <>
          <span
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize files panel"
            title="Drag to resize"
            onPointerDown={(e) => {
              e.preventDefault()
              dragState.current = { startX: e.clientX, startW: filesWidth }
              ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
            }}
            onPointerMove={(e) => {
              const d = dragState.current
              if (!d) return
              // Dragging left widens the panel (it is anchored on the right).
              const next = d.startW - (e.clientX - d.startX)
              setFilesWidth(Math.min(900, Math.max(320, next)))
            }}
            onPointerUp={(e) => {
              dragState.current = null
              ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
            }}
            className="w-[3px] shrink-0 cursor-col-resize bg-transparent transition-colors duration-150 hover:bg-accent/50"
          />
          <aside
            className="shrink-0 border-l border-line"
            style={{ width: filesWidth }}
          >
            <FilesPanel
              key={activeTab.serverId}
              serverId={activeTab.serverId}
              onClose={() => setFilesOpen(false)}
            />
          </aside>
          </>
        )}
      </div>
    </div>
  )
}
