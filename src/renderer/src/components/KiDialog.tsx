import { useState } from 'react'
import { MessageSquareLock } from 'lucide-react'
import { Button, Dialog, Input } from './ui'
import { sessionPorts } from '../stores/sessions'
import { useUi } from '../stores/ui'

/**
 * Server-initiated challenges beyond a plain hidden password prompt
 * (OTP, 2FA, multi-question keyboard-interactive), rendered faithfully —
 * each prompt honors its own echo flag.
 */
export function KiDialog() {
  const ki = useUi((s) => s.ki)
  const closeKi = useUi((s) => s.closeKi)
  const [answers, setAnswers] = useState<string[]>([])

  if (!ki) return null

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    sessionPorts.get(ki.sessionId)?.send({ type: 'ki-answer', responses: answers })
    setAnswers([])
    closeKi()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeKi()} width="max-w-sm"
      title={ki.name || 'Server challenge'}
      description={ki.instruction || 'The server asks you to complete authentication.'}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          {ki.prompts.map((p, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium text-fg">{p.prompt}</label>
              <Input
                type={p.echo ? 'text' : 'password'}
                value={answers[i] ?? ''}
                onChange={(e) =>
                  setAnswers((prev) => {
                    const next = [...prev]
                    next[i] = e.target.value
                    return next
                  })
                }
                autoFocus={i === 0}
                autoComplete="off"
              />
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              sessionPorts.get(ki.sessionId)?.send({ type: 'ki-answer', responses: [] })
              closeKi()
            }}
          >
            Cancel
          </Button>
          <Button type="submit">
            <MessageSquareLock size={15} />
            Submit
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
