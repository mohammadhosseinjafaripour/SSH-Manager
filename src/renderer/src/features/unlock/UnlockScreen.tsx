import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Fingerprint, KeyRound, ShieldCheck, TerminalSquare } from 'lucide-react'
import { masterPasswordIssues } from '@shared/schemas'
import { Button, Field, PasswordInput } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { useVault } from '../../stores/vault'
import { VaultTools } from './VaultTools'

function Logo() {
  return (
    <div className="mb-6 flex flex-col items-center gap-3">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <TerminalSquare size={26} />
      </div>
      <div className="text-center">
        <h1 className="text-lg font-semibold tracking-tight">SSH Vault</h1>
        <p className="mt-0.5 text-[13px] text-muted">Your encrypted gateway to every server</p>
      </div>
    </div>
  )
}

export function UnlockScreen() {
  const phase = useVault((s) => s.phase)
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-bg">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(600px 300px at 50% 20%, var(--accent-soft), transparent 70%)'
        }}
      />
      {phase === 'setup' ? <SetupCard /> : <UnlockCard />}
    </div>
  )
}

function UnlockCard() {
  const unlock = useVault((s) => s.unlock)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shake, setShake] = useState(false)
  const [showTools, setShowTools] = useState(false)
  // Windows Hello: enrolled users get a one-tap unlock; the password field
  // stays as the always-available fallback.
  const [hello, setHello] = useState<{ supported: boolean; enabled: boolean } | null>(null)
  const [helloBusy, setHelloBusy] = useState(false)

  useEffect(() => {
    void window.sshvault
      .helloStatus()
      .then(setHello)
      .catch(() => setHello(null))
  }, [])

  const unlockWithHello = async () => {
    if (helloBusy) return
    setHelloBusy(true)
    setError(null)
    try {
      await useVault.getState().unlockHello()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setHelloBusy(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      await unlock(password)
    } catch (err) {
      setError(friendlyError(err))
      setShake(true)
      setTimeout(() => setShake(false), 350)
    } finally {
      setBusy(false)
    }
  }

  if (showTools) {
    return (
      <div className="relative z-10 w-full max-w-md px-4">
        <VaultTools onBack={() => setShowTools(false)} />
      </div>
    )
  }

  return (
    <div
      className={`relative z-10 w-full max-w-sm rounded-2xl border border-line bg-panel p-8 shadow-2xl ${
        shake ? 'shake' : ''
      }`}
    >
      <Logo />
      <form onSubmit={submit} className="flex flex-col gap-4">
        {hello?.enabled && hello.supported && (
          <>
            <Button
              type="button"
              onClick={() => void unlockWithHello()}
              loading={helloBusy}
              className="w-full"
            >
              <Fingerprint size={16} />
              Unlock with Windows Hello
            </Button>
            <div className="flex items-center gap-3 py-1" aria-hidden="true">
              <span className="h-px flex-1 bg-line" />
              <span className="text-[11px] uppercase tracking-wider text-faint">or</span>
              <span className="h-px flex-1 bg-line" />
            </div>
          </>
        )}
        <Field label="Master password" htmlFor="master-password">
          <PasswordInput
            value={password}
            onChange={setPassword}
            placeholder="Enter your master password"
            autoComplete="current-password"
            invalid={!!error}
          />
        </Field>
        {error && (
          <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] leading-relaxed text-danger">
            {error}
          </p>
        )}
        <Button type="submit" loading={busy} disabled={!password} className="w-full">
          <KeyRound size={15} />
          Unlock vault
        </Button>
        <Button
          variant="ghost"
          onClick={() => setShowTools(true)}
          className="mx-auto h-auto min-h-0 p-0 text-[12px] font-normal text-faint hover:bg-transparent hover:text-muted"
        >
          Vault tools — restore a backup
        </Button>
      </form>
    </div>
  )
}

function SetupCard() {
  const create = useVault((s) => s.create)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const issues = useMemo(() => masterPasswordIssues(password), [password])
  const confirmed = password && confirm && password === confirm
  const canSubmit = password && confirmed && issues.length === 0

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    setError(null)
    try {
      await create(password)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative z-10 w-full max-w-md rounded-2xl border border-line bg-panel p-8 shadow-2xl">
      <Logo />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Create a master password" htmlFor="new-master-password">
          <PasswordInput
            value={password}
            onChange={setPassword}
            placeholder="This one password protects every server credential"
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-inset">
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{
                width: password
                  ? `${Math.max(12, 100 - (issues.length / 3) * 88)}%`
                  : '0%',
                background: issues.length === 0 ? 'var(--ok)' : 'var(--warn)'
              }}
            />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {['At least 10 characters', 'Mix upper and lower case', 'Include a digit'].map(
              (rule) => {
                const ok = !issues.includes(rule)
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
        </div>

        <Field
          label="Confirm password"
          htmlFor="confirm-master-password"
          error={confirm && password !== confirm ? 'Passwords do not match' : undefined}
        >
          <PasswordInput value={confirm} onChange={setConfirm} placeholder="Repeat the password" />
        </Field>

        <p className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          If you forget this password it cannot be recovered — your vault is encrypted with it and
          no copy exists anywhere else.
        </p>

        {error && (
          <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}

        <Button type="submit" loading={busy} disabled={!canSubmit} className="w-full">
          Create vault
        </Button>
      </form>
    </div>
  )
}
