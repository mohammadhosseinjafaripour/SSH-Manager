import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowUp,
  Download,
  File as FileIcon,
  FolderClosed,
  FolderPlus,
  Home,
  Loader2,
  Pencil,
  RefreshCw,
  Shield,
  Trash2,
  Upload,
  X,
  Columns3
} from 'lucide-react'
import type { ConflictPolicy, RemoteEntry, TransferProgress } from '@shared/types'
import { Button, Checkbox, IconButton, Input, Select } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { ChmodDialog, RenameDialog } from './RenameDialog'
import { COLUMNS, ColumnResizer, useColumnState } from './columns'
import { octalToRwx } from './mode-utils'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function parentOf(dir: string): string {
  if (dir === '/' || !dir) return '/'
  const trimmed = dir.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}

type SortKey = 'name' | 'size' | 'modified'

/**
 * Remote file browser over SFTP: navigate, upload (picker or drag & drop),
 * download, create folders and delete. Transfers show a live progress bar.
 */
export function FilesPanel({
  serverId,
  onClose
}: {
  serverId: string
  onClose: () => void
}) {
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [cwd, setCwd] = useState('/')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState<TransferProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const [renameTarget, setRenameTarget] = useState<RemoteEntry | null>(null)
  const [chmodTarget, setChmodTarget] = useState<RemoteEntry | null>(null)
  const [menu, setMenu] = useState<{ entry: RemoteEntry; x: number; y: number } | null>(null)
  const cols = useColumnState()
  const [colMenuOpen, setColMenuOpen] = useState(false)
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>('overwrite')
  const [pendingUpload, setPendingUpload] = useState<{ localPaths: string[] } | null>(null)
  const [conflicts, setConflicts] = useState<string[]>([])
  const dragDepth = useRef(0)

  // ---- connect + navigate --------------------------------------------------

  useEffect(() => {
    let cancelled = false
    // setLoading(true) is intentionally avoided here: state is already
    // `loading` on mount, and setting it synchronously in an effect triggers
    // a cascading render. Only the async result updates state.
    window.sshvault
      .sftpOpen({ serverId })
      .then(({ connectionId: id, homeDir }) => {
        if (cancelled) {
          void window.sshvault.sftpClose({ connectionId: id })
          return
        }
        setConnectionId(id)
        setCwd(homeDir || '/')
      })
      .catch((err) => {
        if (!cancelled) setError(friendlyError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [serverId])

  // Close the SFTP connection when the panel unmounts.
  useEffect(() => {
    return () => {
      if (connectionId) void window.sshvault.sftpClose({ connectionId }).catch(() => undefined)
    }
  }, [connectionId])

  /**
   * Loads a directory. Every state update happens after an await, so calling
   * this from an effect never triggers a cascading synchronous render.
   */
  const refresh = useCallback(
    async (dir: string) => {
      if (!connectionId) return
      try {
        const list = await window.sshvault.sftpList({ connectionId, dir })
        setEntries(list)
        setSelected(new Set())
        setError(null)
      } catch (err) {
        setError(friendlyError(err))
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [connectionId]
  )

  // Load on connect and whenever the path changes. The fetch is inlined so the
  // only state writes happen in the promise continuation (never synchronously
  // during the effect), which keeps renders from cascading.
  useEffect(() => {
    if (!connectionId || !cwd) return
    let cancelled = false
    const currentConnection = connectionId
    window.sshvault
      .sftpList({ connectionId: currentConnection, dir: cwd })
      .then((list) => {
        if (cancelled) return
        setEntries(list)
        setSelected(new Set())
        setMenu(null)
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setError(friendlyError(err))
        setEntries([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [connectionId, cwd])

  // Progress events (shared channel: only one transfer runs at a time).
  useEffect(() => {
    return window.sshvault.onTransferProgress((p) => {
      setProgress(p.done ? null : p)
      if (p.done) void refresh(cwd)
    })
  }, [cwd, refresh])

  // ---- operations ----------------------------------------------------------

  const uploadPicked = async () => {
    if (!connectionId || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.sshvault.sftpPickAndUpload({
        connectionId,
        remoteDir: cwd,
        conflictPolicy
      })
      if (r.ok) await refresh(cwd)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const uploadDropped = async (localPaths: string[]) => {
    if (!connectionId || localPaths.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.sshvault.sftpUpload({
        connectionId,
        remoteDir: cwd,
        localPaths,
        conflictPolicy
      })
      await refresh(cwd)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  /**
   * Before uploading dropped items, ask the server which names already exist.
   * If any do, show the conflict prompt instead of silently overwriting.
   * (The native picker resolves its file list inside the main process, so it
   * uses the policy currently selected in the toolbar.)
   */
  const beginDrop = async (localPaths: string[], names: string[]) => {
    if (!connectionId || busy) return
    try {
      const { existing } = await window.sshvault.sftpCheckConflicts({
        connectionId,
        remoteDir: cwd,
        names
      })
      if (existing.length === 0) {
        await uploadDropped(localPaths)
        return
      }
      setConflicts(existing)
      setPendingUpload({ localPaths })
    } catch {
      // Conflict probing is best-effort: fall through to a normal upload.
      await uploadDropped(localPaths)
    }
  }

  const resolveConflict = async (policy: ConflictPolicy) => {
    setConflictPolicy(policy)
    const intent = pendingUpload
    setPendingUpload(null)
    setConflicts([])
    if (!intent) return
    setBusy(true)
    setError(null)
    try {
      await window.sshvault.sftpUpload({
        connectionId: connectionId!,
        remoteDir: cwd,
        localPaths: intent.localPaths,
        conflictPolicy: policy
      })
      await refresh(cwd)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const downloadSelected = async () => {
    if (!connectionId || selected.size === 0 || busy) return
    const chosen = entries.filter((e) => selected.has(e.path))
    setBusy(true)
    setError(null)
    try {
      const r = await window.sshvault.sftpDownload({
        connectionId,
        remotePaths: chosen.map((e) => e.path),
        kinds: chosen.map((e) => e.kind)
      })
      if (!r.ok) return
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const deleteSelected = async () => {
    if (!connectionId || selected.size === 0 || busy) return
    const chosen = entries.filter((e) => selected.has(e.path))
    const names = chosen.map((e) => e.name).join(', ')
    if (!window.confirm(`Delete ${names} from the server? This cannot be undone.`)) return
    setBusy(true)
    setError(null)
    try {
      for (const entry of chosen) {
        await window.sshvault.sftpDelete({
          connectionId,
          target: entry.path,
          kind: entry.kind
        })
      }
      await refresh(cwd)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  const newFolder = async () => {
    if (!connectionId || busy) return
    const name = window.prompt('New folder name')
    if (!name) return
    setBusy(true)
    try {
      await window.sshvault.sftpMkdir({ connectionId, dir: `${cwd.replace(/\/+$/, '')}/${name}` })
      await refresh(cwd)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  // ---- drag & drop ---------------------------------------------------------

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current++
    if (e.dataTransfer.types.includes('Files')) setDragOver(true)
  }
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragOver(false)
  }
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length === 0) return
    const paths = await window.sshvault.resolveDroppedPaths({
      files: files.map((f) => ({ path: (f as File & { path?: string }).path }))
    })
    // Names are known for dropped items, so we can detect conflicts precisely.
    await beginDrop(
      paths,
      files.map((f) => f.name)
    )
  }

  // ---- rendering -----------------------------------------------------------

  const sorted = [...entries].sort((a, b) => {
    if (a.kind === 'dir' && b.kind !== 'dir') return -1
    if (b.kind === 'dir' && a.kind !== 'dir') return 1
    const cmp =
      sortKey === 'name'
        ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        : sortKey === 'size'
          ? a.size - b.size
          : a.modifiedAt.localeCompare(b.modifiedAt)
    return sortAsc ? cmp : -cmp
  })

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div
      className="relative flex h-full flex-col bg-panel"
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
    >
      {/* header */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-3">
        <FolderClosed size={15} className="shrink-0 text-accent" />
        <span className="mr-1 text-[13px] font-medium">Files</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton label="Go to home directory" onClick={() => setCwd('/')} disabled={!connectionId}>
            <Home size={14} />
          </IconButton>
          <IconButton
            label="Parent folder"
            onClick={() => setCwd((d) => parentOf(d))}
            disabled={!connectionId || cwd === '/'}
          >
            <ArrowUp size={14} />
          </IconButton>
          <IconButton
            label="Refresh"
            onClick={() => void refresh(cwd)}
            disabled={!connectionId || loading}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </IconButton>
          <div className="mx-1 h-5 w-px bg-line" />
          <IconButton label="Close files" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
      </div>

      {/* path bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-3 py-2">
        <Input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void refresh(cwd)
          }}
          spellCheck={false}
          aria-label="Remote path"
          className="min-w-0 flex-1"
          classNames={{
            field: 'h-7 rounded-md',
            input: 'px-2 font-mono text-[11.5px]'
          }}
        />
        <Select
          ariaLabel="Upload conflict policy"
          value={conflictPolicy}
          onValueChange={(v) => setConflictPolicy(v as ConflictPolicy)}
          options={[
            { value: 'overwrite', label: 'Overwrite' },
            { value: 'rename', label: 'Keep both' },
            { value: 'skip', label: 'Skip existing' }
          ]}
        />
        <Button size="sm" variant="secondary" onClick={() => void uploadPicked()} loading={busy}>
          <Upload size={13} />
          Upload
        </Button>
      </div>

      {/* error */}
      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <IconButton
            label="Dismiss error"
            onClick={() => setError(null)}
            className="h-5 w-5 shrink-0 text-danger hover:bg-danger-soft hover:text-danger"
          >
            <X size={12} />
          </IconButton>
        </div>
      )}

      {/* progress */}
      {(progress || (busy && !progress)) && (
        <div className="shrink-0 border-b border-line-soft px-3 py-2">
          <div className="mb-1 flex items-center justify-between text-[11.5px] text-muted">
            <span className="flex items-center gap-1.5 truncate">
              <Loader2 size={11} className="animate-spin" />
              {progress?.currentFile || 'Transferring…'}
            </span>
            <span className="shrink-0 tabular-nums">
              {progress && progress.total > 0
                ? `${Math.round((progress.transferred / progress.total) * 100)}%`
                : ''}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-inset">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-150"
              style={{
                width:
                  progress && progress.total > 0
                    ? `${Math.min(100, (progress.transferred / progress.total) * 100)}%`
                    : '30%'
              }}
            />
          </div>
        </div>
      )}

      {/* Column headers. Each column is resizable by dragging its edge, and the
          visible set is configurable from the menu. Name keeps a minimum width
          so long filenames can never collapse into a single-letter ellipsis. */}
      <div className="relative flex shrink-0 items-center gap-1 border-b border-line-soft px-2 py-1.5">
        <span className="w-4 shrink-0" />
        {COLUMNS.filter((c) => cols.state.visible[c.key]).map((col) => (
          <div
            key={col.key}
            className={`flex items-center ${
              col.flexible ? "min-w-[80px] flex-1" : "shrink-0"
            } ${col.align === "right" ? "justify-end" : "justify-start"}`}
            style={col.flexible ? undefined : { width: cols.widthOf(col.key) }}
          >
            <Button
              variant="ghost"
              onClick={() => {
                if (col.key !== "mode") {
                  if (sortKey === col.key) setSortAsc((v) => !v)
                  else {
                    setSortKey(col.key)
                    setSortAsc(true)
                  }
                }
              }}
              className={`h-auto min-h-0 shrink truncate rounded-none p-0 text-[11px] font-semibold uppercase tracking-wider hover:bg-transparent ${
                sortKey === col.key ? "text-accent" : "text-faint"
              }`}
            >
              {col.label}
              {sortKey === col.key ? (sortAsc ? " ↑" : " ↓") : ""}
            </Button>
            <ColumnResizer
              currentWidth={cols.widthOf(col.key)}
              onResize={(w) => cols.setWidth(col.key, w)}
            />
          </div>
        ))}

        <IconButton
          label="Column settings"
          onClick={() => setColMenuOpen((v) => !v)}
          className="ml-auto h-6 w-6 shrink-0 text-faint hover:bg-panel-2 hover:text-fg"
        >
          <Columns3 size={13} />
        </IconButton>
        {colMenuOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setColMenuOpen(false)} />
            <div className="absolute right-1 top-full z-40 mt-1 w-44 rounded-lg border border-line bg-panel p-1 shadow-2xl">
              <p className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
                Columns
              </p>
              {COLUMNS.map((col) => (
                <Checkbox
                  key={col.key}
                  checked={cols.state.visible[col.key]}
                  onCheckedChange={() => cols.toggleColumn(col.key)}
                  label={col.label}
                  size="compact"
                  labelClassName="w-full gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-muted hover:bg-panel-2 hover:text-fg"
                />
              ))}
              <div className="my-1 h-px bg-line-soft" />
              <Button
                variant="ghost"
                onClick={() => {
                  cols.resetWidths()
                  setColMenuOpen(false)
                }}
                className="h-auto min-h-0 w-full justify-start rounded-md px-2 py-1.5 text-left text-[12px] font-normal text-muted hover:bg-panel-2 hover:text-fg"
              >
                Reset widths
              </Button>
            </div>
          </>
        )}
      </div>

      {/* listing */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && entries.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 size={18} className="animate-spin text-accent" />
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <FolderClosed size={24} className="text-faint" />
            <p className="text-[12.5px] text-muted">This folder is empty</p>
            <Button size="sm" variant="secondary" onClick={() => void uploadPicked()}>
              <Upload size={13} />
              Upload something
            </Button>
          </div>
        ) : (
          <ul role="listbox" aria-label="Remote files" className="py-1">
            {sorted.map((entry) => {
              const isSelected = selected.has(entry.path)
              return (
                <li key={entry.path}>
                  <div
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={0}
                    onClick={(e) => {
                      // Modifier-click extends the selection instead of replacing it.
                      if (e.ctrlKey || e.metaKey) {
                        toggle(entry.path)
                        return
                      }
                      setSelected(new Set([entry.path]))
                    }}
                    onDoubleClick={() => {
                      if (entry.kind === 'dir') setCwd(entry.path)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      // Right-click selects the row it targets, then opens the menu.
                      if (!isSelected) setSelected(new Set([entry.path]))
                      setMenu({ entry, x: e.clientX, y: e.clientY })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        if (entry.kind === 'dir') setCwd(entry.path)
                        else toggle(entry.path)
                      }
                    }}
                    className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12.5px] transition-colors duration-100 ${
                      isSelected ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-panel-2 hover:text-fg'
                    }`}
                  >
                    <span onClick={(e) => e.stopPropagation()} className="contents">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggle(entry.path)}
                        size="compact"
                        aria-label={`Select ${entry.name}`}
                      />
                    </span>
                    {entry.kind === 'dir' ? (
                      <FolderClosed size={14} className="shrink-0 text-accent" />
                    ) : (
                      <FileIcon size={14} className="shrink-0 text-faint" />
                    )}
                    {/* Name column: min width so it never collapses. */}
                    {cols.state.visible.name && (
                      <span className="min-w-[80px] flex-1 truncate" title={entry.name}>
                        {entry.name}
                      </span>
                    )}
                    {/* Mode: fixed width, only when enabled. */}
                    {cols.state.visible.mode && (
                      <span
                        className="shrink-0 text-right font-mono text-[10.5px] text-faint"
                        style={{ width: cols.widthOf("mode") }}
                        title={`chmod ${(entry.permissions & 0o777).toString(8).padStart(3, "0")}`}
                      >
                        {octalToRwx(entry.permissions)}
                      </span>
                    )}
                    {/* Size */}
                    {cols.state.visible.size && (
                      <span
                        className="shrink-0 overflow-hidden text-right tabular-nums text-faint"
                        style={{ width: cols.widthOf("size") }}
                      >
                        {entry.kind === "dir" ? "—" : formatBytes(entry.size)}
                      </span>
                    )}
                    {/* Modified */}
                    {cols.state.visible.modified && (
                      <span
                        className="shrink-0 overflow-hidden text-right text-[11px] text-faint"
                        style={{ width: cols.widthOf("modified") }}
                      >
                        {new Date(entry.modifiedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/*
        Fixed-height action bar. Deliberately ALWAYS rendered: inserting it on
        first selection would shift the list downward mid-double-click, which
        made folders almost impossible to open. Actions are disabled instead of
        hidden, so the row geometry never changes.
      */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-t border-line px-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void newFolder()}
          disabled={!connectionId}
          title="Create a folder here"
        >
          <FolderPlus size={13} />
          <span className="hidden xl:inline">New folder</span>
        </Button>

        <div className="mx-1 h-4 w-px bg-line" />

        <Button
          size="sm"
          variant="ghost"
          onClick={() => void downloadSelected()}
          loading={busy}
          disabled={selected.size === 0}
          title={selected.size ? `Download ${selected.size} item(s)` : 'Select items to download'}
          aria-label="Download selected"
          className="px-2"
        >
          <Download size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void deleteSelected()}
          disabled={selected.size === 0}
          title={selected.size ? `Delete ${selected.size} item(s)` : 'Select items to delete'}
          aria-label="Delete selected"
          className="px-2 text-danger/90 hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 size={14} />
        </Button>

        <span className="ml-auto truncate text-[11px] text-faint">
          {selected.size > 0
            ? `${selected.size} of ${entries.length} selected`
            : `${entries.length} item${entries.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {/* upload conflict prompt */}
      {pendingUpload && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg/85 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-5 shadow-2xl">
            <div className="mb-1 flex items-center gap-2">
              <AlertCircle size={16} className="text-warn" />
              <h3 className="text-[13.5px] font-semibold text-fg">
                {conflicts.length} file{conflicts.length === 1 ? '' : 's'} already exist
              </h3>
            </div>
            <p className="mb-3 max-h-24 overflow-y-auto text-[12px] leading-relaxed text-muted">
              {conflicts.slice(0, 6).join(', ')}
              {conflicts.length > 6 ? ` and ${conflicts.length - 6} more` : ''}
            </p>
            <div className="flex flex-col gap-1.5">
              <Button size="sm" onClick={() => void resolveConflict('overwrite')}>
                Overwrite existing files
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void resolveConflict('rename')}>
                Keep both (rename new copies)
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void resolveConflict('skip')}>
                Skip files that exist
              </Button>
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setPendingUpload(null)
                setConflicts([])
              }}
              className="mt-3 h-auto min-h-0 w-full justify-center p-0 text-[11.5px] font-normal text-faint hover:bg-transparent hover:text-muted"
            >
              Cancel upload
            </Button>
          </div>
        </div>
      )}

      {menu && (
        <RowContextMenu
          menu={menu}
          selectionCount={selected.size}
          onClose={() => setMenu(null)}
          onOpen={() => {
            if (menu.entry.kind === 'dir') setCwd(menu.entry.path)
            setMenu(null)
          }}
          onRename={() => {
            setRenameTarget(menu.entry)
            setMenu(null)
          }}
          onChmod={() => {
            setChmodTarget(menu.entry)
            setMenu(null)
          }}
          onDownload={() => {
            void downloadSelected()
            setMenu(null)
          }}
          onDelete={() => {
            void deleteSelected()
            setMenu(null)
          }}
        />
      )}

      <RenameDialog
        entry={renameTarget}
        connectionId={connectionId ?? ''}
        onClose={() => setRenameTarget(null)}
        onDone={() => void refresh(cwd)}
      />
      <ChmodDialog
        entry={chmodTarget}
        connectionId={connectionId ?? ''}
        onClose={() => setChmodTarget(null)}
        onDone={() => void refresh(cwd)}
      />

      {/* drag overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-accent bg-bg/85 backdrop-blur-[2px]">
          <Upload size={26} className="text-accent" />
          <p className="text-[13px] font-medium text-fg">Drop to upload to {cwd}</p>
          <p className="text-[11.5px] text-muted">Files and folders are both supported</p>
        </div>
      )}
    </div>
  )
}

/**
 * Right-click menu for a file/folder row. Keeps destructive and per-item
 * actions out of the header, so the list layout never shifts mid-click.
 * Positioned at the pointer and flipped when it would overflow the viewport.
 */
function RowContextMenu({
  menu,
  selectionCount,
  onClose,
  onOpen,
  onRename,
  onChmod,
  onDownload,
  onDelete
}: {
  menu: { entry: RemoteEntry; x: number; y: number }
  selectionCount: number
  onClose: () => void
  onOpen: () => void
  onRename: () => void
  onChmod: () => void
  onDownload: () => void
  onDelete: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })

  // Clamp inside the window after measuring the real menu size.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      x: Math.min(menu.x, window.innerWidth - rect.width - 8),
      y: Math.min(menu.y, window.innerHeight - rect.height - 8)
    })
  }, [menu.x, menu.y])

  // Any outside click, Escape or scroll dismisses the menu.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const item = (
    label: string,
    icon: React.ReactNode,
    action: () => void,
    opts: { danger?: boolean; disabled?: boolean } = {}
  ) => (
    <Button
      variant="ghost"
      onClick={action}
      disabled={opts.disabled}
      className={`h-auto min-h-0 w-full justify-start gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] font-normal hover:bg-panel-2 ${
        opts.danger
          ? 'text-danger hover:bg-danger-soft'
          : 'text-muted hover:text-fg'
      }`}
    >
      {icon}
      {label}
    </Button>
  )

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 w-44 rounded-lg border border-line bg-panel p-1 shadow-2xl"
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.entry.kind === 'dir' && (
        <>
          {item('Open', <FolderClosed size={13} />, onOpen)}
          <div className="my-1 h-px bg-line-soft" />
        </>
      )}
      {item(
        selectionCount > 1 ? `Download ${selectionCount} items` : 'Download',
        <Download size={13} />,
        onDownload
      )}
      {item('Rename', <Pencil size={13} />, onRename, {
        disabled: selectionCount > 1
      })}
      {item('Permissions', <Shield size={13} />, onChmod, {
        disabled: selectionCount > 1
      })}
      <div className="my-1 h-px bg-line-soft" />
      {item(
        selectionCount > 1 ? `Delete ${selectionCount} items` : 'Delete',
        <Trash2 size={13} />,
        onDelete,
        { danger: true }
      )}
    </div>
  )
}
