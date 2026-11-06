import { useState } from 'react'
import { Check } from 'lucide-react'
import type { RemoteEntry } from '@shared/types'
import { Button, Checkbox, Dialog, Field, Input } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { octalDigits, octalToRwx } from './mode-utils'

/** Rename a single remote entry. */
export function RenameDialog({
  entry,
  connectionId,
  onClose,
  onDone
}: {
  entry: RemoteEntry | null
  connectionId: string
  onClose: () => void
  onDone: () => void
}) {
  const [name, setName] = useState(entry?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parent = entry ? entry.path.slice(0, entry.path.lastIndexOf('/')) || '/' : '/'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!entry || !name.trim() || busy) return
    if (name === entry.name) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await window.sshvault.sftpRename({
        connectionId,
        from: entry.path,
        to: `${parent.replace(/\/$/, '')}/${name.trim()}`
      })
      onDone()
      onClose()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={!!entry}
      onOpenChange={(open) => !open && onClose()}
      title="Rename"
      description={entry ? entry.path : undefined}
      width="max-w-sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="New name" error={error ?? undefined}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            invalid={!!error}
            autoFocus
            onFocus={(e) => {
              // Select the stem but not the extension, like a file manager.
              const dot = e.target.value.lastIndexOf('.')
              e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length)
            }}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!name.trim()}>
            <Check size={15} />
            Rename
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

const BIT_LABELS = [
  ['r', 'Read'],
  ['w', 'Write'],
  ['x', 'Execute']
] as const

/**
 * Permissions editor. Checkboxes for owner/group/other rather than a raw octal
 * field, because that's what people actually reason about — with the octal
 * shown live so it still matches `chmod 644` habits.
 */
export function ChmodDialog({
  entry,
  connectionId,
  onClose,
  onDone
}: {
  entry: RemoteEntry | null
  connectionId: string
  onClose: () => void
  onDone: () => void
}) {
  const initial = (entry?.permissions ?? 0o644) & 0o777
  const [mode, setMode] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (shift: number, bit: number) => {
    setMode((m) => (m & (bit << shift) ? m & ~(bit << shift) : m | (bit << shift)))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!entry || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.sshvault.sftpChmod({ connectionId, target: entry.path, mode })
      onDone()
      onClose()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={!!entry}
      onOpenChange={(open) => !open && onClose()}
      title="Permissions"
      description={entry ? entry.name : undefined}
      width="max-w-sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="rounded-xl border border-line bg-inset p-4">
          <div className="mb-3 flex items-center justify-between">
            <code className="font-mono text-[15px] tracking-wider text-accent">
              {octalToRwx(mode)}
            </code>
            <code className="font-mono text-[13px] text-muted">
              {octalDigits(mode)}
            </code>
          </div>
          <div className="grid grid-cols-4 gap-2 text-[11px]">
            <span />
            {BIT_LABELS.map(([ch, label]) => (
              <span key={ch} className="text-center font-medium text-faint" title={label}>
                {ch}
              </span>
            ))}
            {(
              [
                ['Owner', 6],
                ['Group', 3],
                ['Other', 0]
              ] as const
            ).flatMap(([label, shift]) => {
              const cells = [
                <span key={`${label}-l`} className="py-1 text-muted">
                  {label}
                </span>
              ]
              BIT_LABELS.forEach(([ch], i) => {
                const bit = 4 >> i
                const on = !!(mode & (bit << shift))
                cells.push(
                  <Checkbox
                    key={`${label}-${ch}`}
                    checked={on}
                    onCheckedChange={() => toggle(shift, bit)}
                    size="compact"
                    aria-label={`${label} ${ch}`}
                    labelClassName="justify-center"
                  />
                )
              })
              return cells
            })}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[
            ['644', 0o644],
            ['600', 0o600],
            ['755', 0o755],
            ['700', 0o700]
          ].map(([label, m]) => (
            <Button
              key={label as string}
              variant="outline"
              onClick={() => setMode(m as number)}
              className="h-auto min-h-0 rounded-md px-2 py-1 font-mono text-[11px] font-normal text-muted hover:border-accent/60 hover:text-accent"
            >
              {label}
            </Button>
          ))}
        </div>
        {error && (
          <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Apply
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
