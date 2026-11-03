import { useState } from 'react'
import { AlertTriangle, Fingerprint, ShieldAlert, ShieldQuestion } from 'lucide-react'
import { Button, Dialog, Input, Spinner } from './ui'
import { friendlyError } from '../lib/errors'
import { sessionPorts, useSessions } from '../stores/sessions'
import { useUi } from '../stores/ui'

/**
 * First-seen key: classic TOFU accept/refuse.
 * Changed key: hard refuse — the only path forward is replacing the pin after
 * out-of-band verification, confirmed by typing the server name.
 */
export function HostKeyDialog() {
  const hostkey = useUi((s) => s.hostkey)
  const closeHostKey = useUi((s) => s.closeHostKey)
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!hostkey) return null
  const isChanged = hostkey.kind === 'changed'

  const decide = (accept: boolean) => {
    sessionPorts.get(hostkey.sessionId)?.send({ type: 'hostkey-decision', accept })
    closeHostKey()
  }

  const replacePin = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.sshvault.hostkeyReplacePin({
        serverId: hostkey.serverId,
        receivedFingerprint: hostkey.fingerprint,
        confirmation
      })
      closeHostKey()
      setConfirmation('')
      await useSessions.getState().reconnect(hostkey.sessionId)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !isChanged && closeHostKey()} width="max-w-lg"
      title={isChanged ? 'Host key has changed' : 'New server, new host key'}
      description={
        isChanged
          ? 'The server presents a different key than the one pinned on first connect. This is expected after an OS reinstall — and it is also exactly what a man-in-the-middle attack looks like. Verify out-of-band before continuing.'
          : 'First connection to this host. Its key fingerprint is shown below; SSH Vault will pin it and refuse any future change.'
      }
    >
      <div className="flex flex-col gap-4">
        <div className={`flex items-start gap-3 rounded-xl border p-4 ${isChanged ? 'border-danger/40 bg-danger-soft' : 'border-line bg-inset'}`}>
          {isChanged ? (
            <ShieldAlert size={20} className="mt-0.5 shrink-0 text-danger" />
          ) : (
            <ShieldQuestion size={20} className="mt-0.5 shrink-0 text-accent" />
          )}
          <div className="flex w-full flex-col gap-2.5">
            <div className="flex items-center gap-2 text-[13px]">
              <Fingerprint size={14} className="text-muted" />
              <span className="font-medium text-fg">
                {isChanged ? 'Key offered now' : 'Key fingerprint'}
              </span>
            </div>
            <code className="break-all rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[12px] text-fg">
              {hostkey.fingerprint}
            </code>
            {isChanged && hostkey.pinnedFingerprint && (
              <>
                <span className="text-[13px] text-muted">Key pinned previously</span>
                <code className="break-all rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[12px] text-muted line-through">
                  {hostkey.pinnedFingerprint}
                </code>
              </>
            )}
          </div>
        </div>

        {!isChanged ? (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => decide(false)}>
              Refuse
            </Button>
            <Button onClick={() => decide(true)}>
              <Fingerprint size={15} />
              Trust &amp; pin this key
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-muted">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
              If you cannot explain this change (reinstall, migration), refuse and investigate —
              do not replace the pin.
            </p>
            <Input
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={`Type “${hostkey.serverName}” to replace the pin`}
              invalid={!!error}
            />
            {error && (
              <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  decide(false)
                  closeHostKey()
                }}
              >
                Keep refusing
              </Button>
              <Button
                variant="danger"
                loading={busy}
                disabled={confirmation.trim() !== hostkey.serverName}
                onClick={replacePin}
              >
                {busy ? <Spinner size={14} /> : <ShieldAlert size={15} />}
                Replace pin &amp; reconnect
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}
