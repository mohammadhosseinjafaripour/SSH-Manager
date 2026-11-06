import { useMemo } from 'react'
import {
  Activity,
  ArrowRight,
  ArrowUpFromLine,
  Pencil,
  Play,
  Plus,
  Search,
  Server,
  Trash2,
  X
} from 'lucide-react'
import type { ServerView } from '@shared/types'
import { Button, IconButton, Input, StatusDot, Tag } from '../../components/ui'
import { relativeTime } from '../../lib/format'
import { useSessions } from '../../stores/sessions'
import { useUi, type HealthState } from '../../stores/ui'
import { useVault } from '../../stores/vault'

function matches(server: ServerView, query: string, tag: string | null): boolean {
  if (tag && !server.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return false
  if (!query) return true
  const q = query.toLowerCase()
  return (
    server.name.toLowerCase().includes(q) ||
    server.host.toLowerCase().includes(q) ||
    server.username.toLowerCase().includes(q) ||
    server.tags.some((t) => t.toLowerCase().includes(q))
  )
}

export function ServersView() {
  const servers = useVault((s) => s.servers)
  const { search, activeTag, setSearch, openServerForm } = useUi()
  const open = useSessions((s) => s.open)
  const select = useSessions((s) => s.select)
  const tabs = useSessions((s) => s.tabs)
  const health = useUi((s) => s.health)
  const setHealth = useUi((s) => s.setHealth)

  /** Probes every server in parallel (main process bounds concurrency to 8). */
  const checkHealth = async () => {
    if (health.running || servers.length === 0) return
    setHealth({ ...health, running: true })
    try {
      const results = await window.sshvault.healthCheck({
        serverIds: servers.map((s) => s.id)
      })
      const map: HealthState['results'] = {}
      for (const r of results) {
        map[r.serverId] = { status: r.status, latencyMs: r.latencyMs, detail: r.detail }
      }
      setHealth({ running: false, checkedAt: new Date().toISOString(), results: map })
    } catch {
      setHealth({ ...health, running: false })
    }
  }

  const healthFor = (id: string) => health.results[id]

  const filtered = useMemo(
    () => servers.filter((s) => matches(s, search.trim(), activeTag)),
    [servers, search, activeTag]
  )

  /**
   * Clicking a server with an open session jumps to that tab instead of
   * opening a duplicate — with several servers you can always get back to
   * the session you were using.
   */
  const connect = (server: ServerView) => {
    const existing = tabs.find(
      (t) => t.serverId === server.id && !['closed', 'error'].includes(t.status)
    )
    if (existing) {
      select(existing.sessionId)
      return
    }
    void open(server).catch(() => undefined)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <div className="relative w-full max-w-md">
            <Input
              id="servers-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search servers, hosts, tags…"
              leftIcon={<Search size={15} />}
              classNames={{
                // beUI's field defaults to a transparent pill; the server list
                // uses a filled rounded rectangle with the app's own border.
                field: 'rounded-lg border-line bg-inset',
                // Room for the clear button / shortcut hint overlay.
                input: 'pr-16'
              }}
            />
          {search ? (
            <IconButton
              label="Clear search"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 h-7 w-7 -translate-y-1/2 text-faint hover:text-fg"
            >
              <X size={14} />
            </IconButton>
          ) : (
            <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-faint">
              Ctrl+Shift+F
            </kbd>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {health.checkedAt && (
            <span className="hidden text-[11.5px] text-faint sm:inline">
              checked {relativeTime(health.checkedAt)}
            </span>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void checkHealth()}
            loading={health.running}
            disabled={servers.length === 0}
            title="Test every server at once"
          >
            <Activity size={14} />
            {health.running ? 'Checking…' : 'Check all'}
          </Button>
          <Button size="sm" onClick={() => openServerForm(null)}>
            <Plus size={15} />
            Add server
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {servers.length === 0 ? (
          <EmptyState onAdd={() => openServerForm(null)} />
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
            <Search size={28} className="text-faint" />
            <p className="text-sm">No servers match “{search}”</p>
          </div>
        ) : (
          <ul id="server-list" className="flex flex-col gap-1.5" role="listbox" aria-label="Servers">
            {filtered.map((server) => {
              const liveTabs = tabs.filter((t) => t.serverId === server.id && !['closed', 'error'].includes(t.status))
              return (
                <li key={server.id}>
                  <div
                    role="option"
                    aria-selected={false}
                    tabIndex={0}
                    onClick={() => connect(server)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        connect(server)
                      }
                    }}
                    className="group flex cursor-pointer items-center gap-4 rounded-xl border border-line-soft bg-panel px-4 py-3.5 transition-all duration-150 hover:border-accent/50 hover:bg-panel-2"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-inset text-muted transition-colors duration-150 group-hover:text-accent">
                      <Server size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] font-medium text-fg">{server.name}</span>
                        {liveTabs.length > 0 && (
                          <span
                            className="flex shrink-0 items-center gap-1 rounded-full border border-ok/40 bg-[color-mix(in_srgb,var(--ok)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ok"
                            title={`${liveTabs.length} open session${liveTabs.length > 1 ? 's' : ''} — click to switch`}
                          >
                            <StatusDot color="var(--ok)" />
                            Live
                          </span>
                        )}
                        {(() => {
                          const h = healthFor(server.id)
                          if (!h) return null
                          const meta =
                            h.status === 'online'
                              ? { color: 'var(--ok)', label: h.latencyMs ? `${h.latencyMs}ms` : 'up' }
                              : h.status === 'auth-failed'
                                ? { color: 'var(--warn)', label: 'auth failed' }
                                : h.status === 'hostkey-changed'
                                  ? { color: 'var(--danger)', label: 'key changed' }
                                  : { color: 'var(--danger)', label: 'down' }
                          return (
                            <span
                              className="flex shrink-0 items-center gap-1 rounded-full border border-line bg-inset px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted"
                              title={h.detail ?? meta.label}
                            >
                              <StatusDot color={meta.color} />
                              {meta.label}
                            </span>
                          )
                        })()}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[12px] text-muted/90">
                        {server.username}@{server.host}
                        {server.port !== 22 ? (
                          <span className="text-muted/70">:{server.port}</span>
                        ) : null}
                        {server.elevate.enabled && (
                          <span className="ml-2 rounded border border-line bg-inset px-1 py-px font-sans text-[10px] tracking-wide text-accent">
                            AUTO-SUDO
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
                      {server.tags.slice(0, 3).map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </div>
                    <span className="ml-auto w-24 shrink-0 text-right text-[12px] text-muted/80">
                      {relativeTime(server.lastConnectedAt)}
                    </span>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                      <IconButton
                        label={`Edit ${server.name}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          openServerForm(server)
                        }}
                      >
                        <Pencil size={15} />
                      </IconButton>
                      <IconButton
                        label={`Delete ${server.name}`}
                        className="hover:text-danger"
                        onClick={(e) => {
                          e.stopPropagation()
                          useUi.getState().openDelete(server)
                        }}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </div>
                    <Button
                      size="sm"
                      variant={liveTabs.length > 0 ? 'primary' : 'secondary'}
                      className="shrink-0"
                      onClick={(e) => {
                        e.stopPropagation()
                        connect(server)
                      }}
                    >
                      {liveTabs.length > 0 ? <ArrowRight size={13} /> : <Play size={13} />}
                      {liveTabs.length > 0 ? 'Switch' : 'Connect'}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 py-16 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <Server size={28} />
      </div>
      <div>
        <h2 className="text-[15px] font-semibold text-fg">Add your first server</h2>
        <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-muted">
          Store its name, address and password in the encrypted vault — then connect with a single
          click, every time.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={onAdd}>
          <Plus size={15} />
          Add server
        </Button>
        <Button variant="secondary" onClick={() => useUi.getState().openTransfer('import')}>
          <ArrowUpFromLine size={15} />
          Import from file
        </Button>
      </div>
    </div>
  )
}
