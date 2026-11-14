import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, KeyRound, ShieldCheck } from 'lucide-react'
import { masterPasswordIssues } from '@shared/schemas'
import { Button, Dialog, Field, PasswordInput } from './ui'
import { friendlyError } from '../lib/errors'

/**
 * Change the master password.
 *
 * The gate is the *current* password: it proves the person at the keyboard
 * owns the vault before anything is re-encrypted. The new password is entered
 * twice with a live strength check, and every field has a show/hide toggle so
 * a long password can be typed and verified by eye instead of by memory.
 *
 * What stays true after a change: servers and sessions are untouched (the
 * vault is re-sealed, not rebuilt), and a live SSH session keeps running.
 * What is dropped: the Windows Hello enrollment, because it wraps the old key
 * by design — Settings offers a one-click re-enable.
 */
export function ChangePasswordDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const issues = useMemo(() => masterPasswordIssues(next), [next])
  const sameAsCurrent = next.length > 0 && next === current
  const mismatch = confirm.length > 0 && next !== confirm
  const canSubmit =
    current.length > 0 && next.length > 0 && issues.length === 0 && !sameAsCurrent && !mismatch

  const reset = () => {
    setCurrent('')
    setNext('')
    setConfirm('')
    setError(null)
    setDone(false)
    setBusy(false)
  }

  const close = (o: boolean) => {
    if (!o) reset()
    onOpenChange(o)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.sshvault.vaultChangePassword({
        currentPassword: current,
        nextPassword: next
      })
      // Do not keep any of the three strings in component state after success.
      setCurrent('')
      setNext('')
      setConfirm('')
      setDone(true)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Change master password"
      description="This password protects every credential in your vault."
      width="max-w-md"
    >
      {done ? (
        <div className="mt-5 flex flex-col items-center gap-3 py-4 text-center">
          <CheckCircle2 size={28} className="text-ok" />
          <p className="text-[13px] text-fg">Master password changed</p>
          <p className="max-w-sm text-[12.5px] leading-relaxed text-muted">
            The vault is now encrypted under the new password. Open sessions keep running; the
            next unlock needs the new password.
          </p>
          <Button onClick={() => close(false)}>Done</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-5 flex flex-col gap-4">
          <Field
            label="Current password"
            hint="Confirms it's really you before anything is re-encrypted."
          >
            <PasswordInput
              value={current}
              onChange={setCurrent}
              placeholder="Your current master password"
              autoComplete="current-password"
              invalid={!!error}
            />
          </Field>

          <Field label="New password">
            <PasswordInput
              value={next}
              onChange={setNext}
              placeholder="At least 10 characters"
              autoComplete="new-password"
              invalid={sameAsCurrent}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-inset">
              <div
                className="h-full rounded-full transition-all duration-200"
                style={{
                  width: next ? `${Math.max(12, 100 - (issues.length / 3) * 88)}%` : '0%',
                  background: issues.length === 0 ? 'var(--ok)' : 'var(--warn)'
                }}
              />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {['At least 10 characters', 'Mix upper and lower case', 'Include a digit'].map(
                (rule) => {
                  const ok = next.length > 0 && !issues.includes(rule)
                  return (
                    <span
                      key={rule}
                      className={`flex items-center gap-1 text-[12px] ${ok ? 'text-ok' : 'text-faint'}`}
                    >
                      <ShieldCheck size={12} />
                      {rule}
                    </span>
                  )
                }
              )}
            </div>
            {sameAsCurrent && (
              <p className="text-[12px] text-warn">
                The new password must be different from the current one.
              </p>
            )}
          </div>

          <Field
            label="Confirm new password"
            error={mismatch ? 'Passwords do not match' : undefined}
          >
            <PasswordInput
              value={confirm}
              onChange={setConfirm}
              placeholder="Repeat the new password"
              autoComplete="new-password"
              invalid={mismatch}
            />
          </Field>

          <p className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>
              There is no recovery: if this password is forgotten, the vault cannot be opened.
              Windows Hello unlock will be turned off (re-enable it afterwards in one click).
            </span>
          </p>

          {error && (
            <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!canSubmit}>
              <KeyRound size={15} />
              Change password
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
