import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button, Dialog, Input } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { useUi } from '../../stores/ui'
import { useVault } from '../../stores/vault'

/** Destructive action guard: the exact server name must be typed. */
export function DeleteServerModal() {
  const { deleteTarget, closeDelete } = useUi()
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    if (!deleteTarget || busy) return
    setBusy(true)
    setError(null)
    try {
      await useVault.getState().remove(deleteTarget.id)
      closeDelete()
      setConfirmText('')
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={!!deleteTarget}
      onOpenChange={(open) => {
        if (!open) {
          closeDelete()
          setConfirmText('')
        }
      }}
      title={deleteTarget ? `Delete “${deleteTarget.name}”` : 'Delete server'}
      description="This removes the server and its stored credentials from the vault. Type the server name to confirm."
      width="max-w-sm"
    >
      <div className="flex flex-col gap-4">
        <Input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={deleteTarget?.name}
          invalid={!!error}
          autoFocus
        />
        {error && (
          <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={closeDelete}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!deleteTarget || confirmText.trim() !== deleteTarget.name}
            onClick={remove}
          >
            <Trash2 size={15} />
            Delete permanently
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
