import { useEffect, useState } from 'react'
import { useForm, type Resolver, type UseFormReturn } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowUpRight, ShieldCheck, Zap } from 'lucide-react'
import { serverFormSchema, type ServerFormValues } from '@shared/schemas'
import type { ServerUpsertInput, ServerView, TestConnectionResult } from '@shared/types'
import { Button, Dialog, Field, Input, PasswordInput, Select, Switch } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { useUi } from '../../stores/ui'
import { useVault } from '../../stores/vault'

const PRESET_OPTIONS = [
  { value: 'sudo -s', label: 'sudo -s  (root shell)' },
  { value: 'sudo -i', label: 'sudo -i  (login shell)' },
  { value: 'sudo su -', label: 'sudo su -  (switch to root)' },
  { value: 'custom', label: 'Custom sudo command…' }
]

function toFormValues(server: ServerView | null): ServerFormValues {
  if (!server) {
    return {
      name: '',
      host: '',
      port: 22,
      username: '',
      password: '',
      tags: [],
      notes: '',
      elevate: { enabled: false, preset: 'sudo -s', customCommand: '', passwordMode: 'same', customPassword: '' }
    }
  }
  return {
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    password: '',
    tags: server.tags,
    notes: server.notes,
    elevate: {
      enabled: server.elevate.enabled,
      preset: server.elevate.preset,
      customCommand: server.elevate.customCommand,
      passwordMode: server.elevate.passwordMode,
      customPassword: ''
    }
  }
}

export function ServerFormModal() {
  const { serverFormOpen, editing, closeServerForm } = useUi()
  const upsert = useVault((s) => s.upsert)
  const [tagsText, setTagsText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<TestConnectionResult | null>(null)
  const [testing, setTesting] = useState(false)

  const form = useForm<ServerFormValues>({
    resolver: zodResolver(serverFormSchema) as unknown as Resolver<ServerFormValues>,
    defaultValues: toFormValues(editing)
  })

  useEffect(() => {
    if (serverFormOpen) {
      form.reset(toFormValues(editing))
      setTagsText(editing?.tags.join(', ') ?? '')
      setError(null)
      setTest(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverFormOpen, editing])

  const watched = form.watch()
  const elevateEnabled = watched.elevate?.enabled
  const preset = watched.elevate?.preset
  const passwordMode = watched.elevate?.passwordMode

  const submit = form.handleSubmit(async (values) => {
    setError(null)
    // Create-mode-only secret requirements; in edit mode empty means "keep
    // the stored value" (enforced by the main process).
    if (!editing && !values.password) {
      form.setError('password', { message: 'Password is required for a new server' })
      return
    }
    if (!editing && values.elevate.passwordMode === 'custom' && !values.elevate.customPassword) {
      form.setError('elevate.customPassword', { message: 'A separate sudo password is required' })
      return
    }
    const input: ServerUpsertInput = {
      id: editing?.id,
      name: values.name,
      host: values.host,
      port: values.port,
      username: values.username,
      tags: tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      notes: values.notes,
      elevate: {
        enabled: values.elevate.enabled,
        preset: values.elevate.preset,
        customCommand: values.elevate.customCommand,
        passwordMode: values.elevate.passwordMode,
        customPassword:
          values.elevate.passwordMode === 'custom' && values.elevate.customPassword
            ? values.elevate.customPassword
            : undefined
      }
    }
    if (!editing) input.password = values.password
    else if (values.password) input.password = values.password
    try {
      await upsert(input)
      closeServerForm()
    } catch (err) {
      setError(friendlyError(err))
    }
  })

  const runTest = async () => {
    if (!editing || testing) return
    setTesting(true)
    setTest(null)
    try {
      setTest(await window.sshvault.sessionTest(editing.id))
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setTesting(false)
    }
  }

  return (
    <Dialog
      open={serverFormOpen}
      onOpenChange={(open) => {
        if (!open) closeServerForm()
      }}
      title={editing ? `Edit “${editing.name}”` : 'Add server'}
      description="Credentials are encrypted inside the vault before being written to disk."
      width="max-w-xl"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" error={form.formState.errors.name?.message} htmlFor="f-name">
            <Input id="f-name" placeholder="web-prod-1" {...form.register('name')} invalid={!!form.formState.errors.name} />
          </Field>
          <Field label="Username" error={form.formState.errors.username?.message} htmlFor="f-user">
            <Input id="f-user" placeholder="deploy" {...form.register('username')} invalid={!!form.formState.errors.username} />
          </Field>
          <Field label="Host / IP" error={form.formState.errors.host?.message} htmlFor="f-host">
            <Input id="f-host" placeholder="203.0.113.10" {...form.register('host')} invalid={!!form.formState.errors.host} />
          </Field>
          <Field label="Port" error={form.formState.errors.port?.message} htmlFor="f-port">
            <Input id="f-port" type="number" {...form.register('port')} invalid={!!form.formState.errors.port} />
          </Field>
        </div>

        <Field
          label="Password"
          error={form.formState.errors.password?.message}
          hint={editing ? 'Leave empty to keep the stored password' : undefined}
        >
          <PasswordInputWithForm form={form} />
        </Field>

        <Field label="Tags" hint="Comma-separated, e.g. production, web">
          <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="production, web" />
        </Field>

        <Field label="Notes (optional)">
          <Input {...form.register('notes')} placeholder="Anything worth remembering" />
        </Field>

        <div className="rounded-xl border border-line bg-inset p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap size={15} className="text-accent" />
              <span className="text-[13px] font-medium text-fg">Become root automatically</span>
            </div>
            <Switch
              label="Enable automatic sudo elevation"
              checked={!!elevateEnabled}
              onCheckedChange={(v) => form.setValue('elevate.enabled', v)}
            />
          </div>

          {elevateEnabled && (
            <div className="mt-4 flex flex-col gap-4">
              <Field label="Elevation command">
                <Select
                  ariaLabel="Elevation command"
                  value={preset ?? 'sudo -s'}
                  onValueChange={(v) => form.setValue('elevate.preset', v as ServerFormValues['elevate']['preset'])}
                  options={PRESET_OPTIONS}
                />
              </Field>
              {preset === 'custom' && (
                <Field
                  label="Custom command"
                  error={form.formState.errors.elevate?.customCommand?.message}
                  hint="Must start with sudo — e.g. sudo -u admin -s"
                >
                  <Input
                    placeholder="sudo -u admin -s"
                    {...form.register('elevate.customCommand')}
                    invalid={!!form.formState.errors.elevate?.customCommand}
                  />
                </Field>
              )}
              <Field label="Sudo password">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => form.setValue('elevate.passwordMode', 'same')}
                    className={`h-9 flex-1 rounded-lg border px-3 text-[13px] transition-colors duration-150 ${
                      passwordMode === 'same'
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line bg-panel text-muted hover:text-fg'
                    }`}
                  >
                    Same as login
                  </button>
                  <button
                    type="button"
                    onClick={() => form.setValue('elevate.passwordMode', 'custom')}
                    className={`h-9 flex-1 rounded-lg border px-3 text-[13px] transition-colors duration-150 ${
                      passwordMode === 'custom'
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line bg-panel text-muted hover:text-fg'
                    }`}
                  >
                    Separate password
                  </button>
                </div>
              </Field>
              {passwordMode === 'custom' && (
                <Field
                  label="Separate sudo password"
                  error={form.formState.errors.elevate?.customPassword?.message}
                  hint={editing ? 'Leave empty to keep the stored sudo password' : undefined}
                >
                  <PasswordInput
                    value={form.watch('elevate.customPassword') ?? ''}
                    onChange={(v) => form.setValue('elevate.customPassword', v)}
                    withGenerator
                  />
                </Field>
              )}
              <p className="flex items-start gap-2 text-[12px] leading-relaxed text-faint">
                <ShieldCheck size={13} className="mt-0.5 shrink-0 text-accent" />
                The password is sent only after sudo&rsquo;s prompt is detected, with terminal echo
                disabled — it never appears on screen.
              </p>
            </div>
          )}
        </div>

        {error && (
          <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}
        {test && (
          <p
            className={`rounded-lg border px-3 py-2 text-[13px] leading-relaxed ${
              test.ok
                ? 'border-ok/30 bg-[color-mix(in_srgb,var(--ok)_8%,transparent)] text-ok'
                : 'border-danger/30 bg-danger-soft text-danger'
            }`}
          >
            <span className="font-mono text-[11px]">{test.fingerprint ? `${test.fingerprint} · ` : ''}</span>
            {test.message}
          </p>
        )}

        <div className="mt-1 flex items-center justify-between">
          {editing ? (
            <Button type="button" variant="secondary" size="sm" loading={testing} onClick={runTest}>
              <ArrowUpRight size={14} />
              Test connection
            </Button>
          ) : (
            <span className="text-[12px] text-faint">Save first, then test the connection</span>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={closeServerForm}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              {editing ? 'Save changes' : 'Add server'}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}

function PasswordInputWithForm({ form }: { form: UseFormReturn<ServerFormValues> }) {
  const value = form.watch('password') ?? ''
  const error = form.formState.errors.password
  return (
    <PasswordInput
      value={value}
      onChange={(v) => form.setValue('password', v)}
      withGenerator
      invalid={!!error}
      placeholder={form.getValues('name') && !value ? '••••••••••  (unchanged)' : 'Server login password'}
    />
  )
}
