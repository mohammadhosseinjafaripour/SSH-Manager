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
  X
} from 'lucide-react'
import type { ConflictPolicy, RemoteEntry, TransferProgress } from '@shared/types'
import { Button, IconButton, Select } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { ChmodDialog, RenameDialog } from './RenameDialog'
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

type SortKey = 'name' | 'size' | 'modifiedAt'

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

  const header = (key: SortKey, label: string) => (
    <button
      onClick={() => {
        if (sortKey === key) setSortAsc((v) => !v)
        else {
          setSortKey(key)
          setSortAsc(true)
        }
      }}
      className={`text-left text-[11px] font-semibold uppercase tracking-wider transition-colors duration-150 hover:text-fg ${
        sortKey === key ? 'text-accent' : 'text-faint'
      }`}
    >
      {label}
      {sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''}
    </button>
  )

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
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void refresh(cwd)
          }}
          spellCheck={false}
          aria-label="Remote path"
          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-inset px-2 font-mono text-[11.5px] text-fg focus:border-accent"
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
          <button onClick={() => setError(null)} aria-label="Dismiss error">
            <X size={12} />
          </button>
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

      {/* selection actions */}
      {selected.size > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-panel-2 px-3 py-1.5">
          <span className="text-[11.5px] text-muted">{selected.size} selected</span>
          <div className="ml-auto flex gap-1.5">
            {selected.size === 1 && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const only = entries.find((e) => selected.has(e.path))
                    if (only) setRenameTarget(only)
                  }}
                >
                  <Pencil size={12} />
                  Rename
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const only = entries.find((e) => selected.has(e.path))
                    if (only) setChmodTarget(only)
                  }}
                >
                  <Shield size={12} />
                  Permissions
                </Button>
              </>
            )}
            <Button size="sm" variant="secondary" onClick={() => void downloadSelected()} loading={busy}>
              <Download size={12} />
              Download
            </Button>
            <Button size="sm" variant="danger" onClick={() => void deleteSelected()} loading={busy}>
              <Trash2 size={12} />
              Delete
            </Button>
          </div>
        </div>
      )}

      {/* column headers */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-3 py-1.5">
        <span className="w-4" />
        <span className="flex-1">{header('name', 'Name')}</span>
        <span className="w-20 text-right font-mono text-[11px] font-semibold uppercase tracking-wider text-faint">
          Mode
        </span>
        <span className="w-16 text-right">{header('size', 'Size')}</span>
        <span className="w-24 text-right">{header('modifiedAt', 'Modified')}</span>
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
                    onClick={() => toggle(entry.path)}
                    onDoubleClick={() => {
                      if (entry.kind === 'dir') setCwd(entry.path)
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
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(entry.path)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select ${entry.name}`}
                      className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                    />
                    {entry.kind === 'dir' ? (
                      <FolderClosed size={14} className="shrink-0 text-accent" />
                    ) : (
                      <FileIcon size={14} className="shrink-0 text-faint" />
                    )}
                    <span className="flex-1 truncate">{entry.name}</span>
                    <span
                      className="w-20 shrink-0 text-right font-mono text-[10.5px] text-faint"
                      title={`chmod ${(entry.permissions & 0o777).toString(8).padStart(3, '0')}`}
                    >
                      {octalToRwx(entry.permissions)}
                    </span>
                    <span className="w-16 shrink-0 text-right tabular-nums text-faint">
                      {entry.kind === 'dir' ? '—' : formatBytes(entry.size)}
                    </span>
                    <span className="w-24 shrink-0 text-right text-[11px] text-faint">
                      {new Date(entry.modifiedAt).toLocaleDateString()}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* footer */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1.5">
        <Button size="sm" variant="ghost" onClick={() => void newFolder()} disabled={!connectionId}>
          <FolderPlus size={13} />
          New folder
        </Button>
        <span className="ml-auto text-[11px] text-faint">
          {entries.length} item{entries.length === 1 ? '' : 's'}
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
            <button
              onClick={() => {
                setPendingUpload(null)
                setConflicts([])
              }}
              className="mt-3 w-full text-center text-[11.5px] text-faint hover:text-muted"
            >
              Cancel upload
            </button>
          </div>
        </div>
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
