import { useEffect, useState } from 'react'
import { ArrowLeft, HardDriveDownload } from 'lucide-react'
import type { VaultBackupInfo } from '@shared/types'
import { Button, Field, PasswordInput, RadioGroup, RadioGroupItem } from '../../components/ui'
import { friendlyError } from '../../lib/errors'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * Deliberate backup-restore flow (reached only by explicit action, never
 * offered automatically after a failed unlock). Every candidate backup is
 * decrypted and integrity-checked with the master password before anything
 * on disk is touched.
 */
export function VaultTools({ onBack }: { onBack: () => void }) {
  const [backups, setBackups] = useState<VaultBackupInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    window.sshvault
      .vaultBackups()
      .then((list) => {
        setBackups(list)
        setSelected(list[0]?.file ?? null)
      })
      .catch(() => setBackups([]))
  }, [])

  const restore = async () => {
    if (!selected || !password || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.sshvault.vaultRestoreBackup(selected, password)
      setDone(true)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-panel p-8 shadow-2xl">
      <div className="mb-6">
        <h1 className="text-base font-semibold">Vault tools</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          Restore an earlier good copy of the vault. The backup is decrypted and verified with your
          master password first; the current file is kept next to it, never deleted.
        </p>
      </div>

      {backups.length === 0 ? (
        <p className="rounded-lg border border-line bg-inset px-3 py-4 text-[13px] text-muted">
          No backups exist yet. Backups are created automatically each time the vault is saved.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <RadioGroup
              value={selected ?? ''}
              onValueChange={setSelected}
              aria-label="Backup to restore"
            >
              {backups.map((b) => (
                <RadioGroupItem
                  key={b.file}
                  value={b.file}
                  label={b.file}
                  className={`w-full justify-between rounded-lg border px-3 py-2.5 text-[13px] transition-colors duration-150 ${
                    selected === b.file
                      ? 'border-accent bg-accent-soft text-fg'
                      : 'border-line bg-inset text-muted hover:border-accent/50'
                  }`}
                  trailing={
                    <span className="text-faint">
                      {new Date(b.modifiedAt).toLocaleString()} · {formatSize(b.sizeBytes)}
                    </span>
                  }
                />
              ))}
            </RadioGroup>
          </div>

          <Field
            label="Master password (must match the backup)"
            htmlFor="restore-password"
            error={error ?? undefined}
          >
            <PasswordInput
              value={password}
              onChange={setPassword}
              placeholder="Enter the master password for the selected backup"
              invalid={!!error}
            />
          </Field>

          {done && (
            <p className="rounded-lg border border-ok/30 bg-[color-mix(in_srgb,var(--ok)_10%,transparent)] px-3 py-2 text-[13px] text-ok">
              Backup verified and restored. Go back and unlock with its master password.
            </p>
          )}

          <div className="flex justify-between">
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft size={15} />
              Back to unlock
            </Button>
            <Button
              variant="danger"
              onClick={restore}
              loading={busy}
              disabled={!selected || !password}
            >
              <HardDriveDownload size={15} />
              Verify &amp; restore
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
