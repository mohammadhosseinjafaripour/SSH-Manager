import { useEffect } from 'react'
import { Lock, Plus, Server, Settings, Tags, TerminalSquare } from 'lucide-react'
import { useUi } from './stores/ui'
import { useVault } from './stores/vault'
import { useSessions } from './stores/sessions'
import { applyTheme, watchSystemTheme } from './lib/theme'
import { UnlockScreen } from './features/unlock/UnlockScreen'
import { ServersView } from './features/servers/ServersView'
import { ServerFormModal } from './features/servers/ServerFormModal'
import { DeleteServerModal } from './features/servers/DeleteServerModal'
import { TerminalView } from './features/terminal/TerminalView'
import { HostKeyDialog } from './components/HostKeyDialog'
import { KiDialog } from './components/KiDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { TransferDialog } from './components/TransferDialog'
import { Spinner } from './components/ui'

function isTerminalFocused(): boolean {
  const el = document.activeElement
  return !!el && !!el.closest('.xterm')
}

function focusSearch(): void {
  const el = document.getElementById('servers-search') as HTMLInputElement | null
  if (el) {
    el.focus()
    el.select()
  }
}

function useGlobalEffects(): void {
  const phase = useVault((s) => s.phase)
  const settings = useVault((s) => s.settings)

  // One-time bridge wiring: session ports + auto-lock notifications.
  useEffect(() => {
    const offPort = window.sshvault.onSessionPort((sessionId, port) => {
      useSessions.getState().registerPort(sessionId, port)
    })
    const offLocked = window.sshvault.onLocked(() => {
      useVault.getState().applyLocked()
    })
    return () => {
      offPort()
      offLocked()
    }
  }, [])

  // Boot: check vault existence, apply stored theme.
  useEffect(() => {
    void useVault.getState().init()
  }, [])

  useEffect(() => {
    if (phase === 'unlocked') applyTheme(settings.theme)
    else applyTheme('dark')
  }, [phase, settings.theme])

  useEffect(
    () =>
      watchSystemTheme(() => {
        if (useVault.getState().phase === 'unlocked') applyTheme(useVault.getState().settings.theme)
      }),
    []
  )

  // User activity anywhere in the app postpones auto-lock.
  useEffect(() => {
    if (phase !== 'unlocked') return
    let last = 0
    const ping = () => {
      const now = Date.now()
      if (now - last < 5000) return
      last = now
      void window.sshvault.vaultActivity().catch(() => undefined)
    }
    window.addEventListener('pointerdown', ping)
    window.addEventListener('keydown', ping)
    return () => {
      window.removeEventListener('pointerdown', ping)
      window.removeEventListener('keydown', ping)
    }
  }, [phase])

  // Context-aware shortcuts: inside the terminal only Ctrl+Shift+* may act,
  // so plain Ctrl+L / Ctrl+W / Ctrl+N still reach the remote shell.
  useEffect(() => {
    if (phase !== 'unlocked') return
    const onKey = (e: KeyboardEvent) => {
      const inTerminal = isTerminalFocused()
      const sessions = useSessions.getState()
      const ui = useUi.getState()

      if (e.ctrlKey && e.shiftKey && e.key === 'Tab') {
        e.preventDefault()
        sessions.cycle(-1)
        return
      }
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        sessions.cycle(1)
        return
      }
      if (e.ctrlKey && e.shiftKey) {
        const k = e.code
        if (k === 'KeyL') {
          e.preventDefault()
          void window.sshvault.vaultLock().then(() => useVault.getState().applyLocked())
        } else if (k === 'KeyW') {
          e.preventDefault()
          if (sessions.active !== 'servers') sessions.closeTab(sessions.active)
        } else if (k === 'KeyF') {
          e.preventDefault()
          sessions.select('servers')
          focusSearch()
        } else if (k === 'KeyN') {
          e.preventDefault()
          ui.openServerForm(null)
        }
        return
      }
      if (!inTerminal && e.ctrlKey && !e.shiftKey && !e.altKey) {
        const k = e.code
        if (k === 'KeyF') {
          e.preventDefault()
          sessions.select('servers')
          focusSearch()
        } else if (k === 'KeyN') {
          e.preventDefault()
          ui.openServerForm(null)
        } else if (k === 'KeyL') {
          e.preventDefault()
          void window.sshvault.vaultLock().then(() => useVault.getState().applyLocked())
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase])
}

function Sidebar() {
  const servers = useVault((s) => s.servers)
  const { activeTag, setActiveTag, openServerForm, setSettingsOpen } = useUi()
  const select = useSessions((s) => s.select)

  const tags = Array.from(new Set(servers.flatMap((s) => s.tags))).sort((a, b) =>
    a.localeCompare(b)
  )

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-2.5 px-5 pb-2 pt-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <TerminalSquare size={18} />
        </div>
        <div>
          <div className="text-[14px] font-semibold leading-tight tracking-tight">SSH Vault</div>
          <div className="text-[11px] text-faint">
            {servers.length} {servers.length === 1 ? 'server' : 'servers'}
          </div>
        </div>
      </div>

      <nav className="mt-4 flex flex-1 flex-col gap-0.5 overflow-y-auto px-3">
        <SidebarItem
          icon={<Server size={15} />}
          label="All servers"
          active={activeTag === null}
          onClick={() => {
            setActiveTag(null)
            select('servers')
          }}
        />
        {tags.length > 0 && (
          <div className="mt-3 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">
            Tags
          </div>
        )}
        {tags.map((tag) => (
          <SidebarItem
            key={tag}
            icon={<Tags size={14} />}
            label={tag}
            active={activeTag?.toLowerCase() === tag.toLowerCase()}
            onClick={() => {
              setActiveTag(activeTag?.toLowerCase() === tag.toLowerCase() ? null : tag)
              select('servers')
            }}
          />
        ))}
      </nav>

      <div className="flex flex-col gap-1 border-t border-line p-3">
        <button
          onClick={() => openServerForm(null)}
          className="flex h-9 items-center justify-center gap-2 rounded-lg border border-accent/40 px-3 text-[13px] font-medium text-accent transition-colors duration-150 hover:border-accent hover:bg-accent-soft"
        >
          <Plus size={15} />
          Add server
        </button>
        <div className="flex gap-1">
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex h-9 flex-1 items-center gap-2 rounded-lg px-3 text-[13px] text-muted transition-colors duration-150 hover:bg-panel-2 hover:text-fg"
          >
            <Settings size={15} />
            Settings
          </button>
          <button
            onClick={() => void window.sshvault.vaultLock().then(() => useVault.getState().applyLocked())}
            className="flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] text-muted transition-colors duration-150 hover:bg-panel-2 hover:text-fg"
            title="Lock now (Ctrl+Shift+L)"
          >
            <Lock size={15} />
            Lock
          </button>
        </div>
      </div>
    </aside>
  )
}

function SidebarItem({
  icon,
  label,
  active,
  onClick
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex h-9 items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors duration-150 ${
        active ? 'bg-panel-2 font-medium text-fg' : 'text-muted hover:bg-panel-2/60 hover:text-fg'
      }`}
    >
      <span className={active ? 'text-accent' : 'text-faint'}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

function MainLayout() {
  const active = useSessions((s) => s.active)
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1">
        {active === 'servers' ? <ServersView /> : <TerminalView />}
      </main>
    </div>
  )
}

export default function App() {
  const phase = useVault((s) => s.phase)
  useGlobalEffects()

  if (phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-bg">
        <Spinner size={22} />
      </div>
    )
  }

  if (phase === 'setup' || phase === 'locked') {
    return <UnlockScreen />
  }

  return (
    <>
      <MainLayout />
      <ServerFormModal />
      <DeleteServerModal />
      <HostKeyDialog />
      <KiDialog />
      <SettingsDialog />
      <TransferDialog />
    </>
  )
}
