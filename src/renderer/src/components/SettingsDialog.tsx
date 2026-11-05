import { useEffect, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Download,
  FileSpreadsheet,
  Moon,
  RefreshCw,
  Settings2,
  Sun
} from 'lucide-react'
import type { Theme, UpdateState } from '@shared/types'
import { Button, Dialog, Field, Input, Switch } from './ui'
import { applyTheme } from '../lib/theme'
import { useUi } from '../stores/ui'
import { useVault } from '../stores/vault'

/**
 * One settings row: clickable text + switch. The text forwards the toggle
 * exactly once; the switch itself is the only other hit target. A plain div
 * (not a <label>) so no browser forwards a second synthetic click to the
 * button control — the root cause of toggles that flipped and immediately
 * flipped back.
 */
function ToggleRow({
  label,
  checked,
  onToggle
}: {
  label: string
  checked: boolean
  onToggle: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <button
        type="button"
        onClick={() => onToggle(!checked)}
        className="cursor-pointer text-left"
      >
        <span className="block text-[12.5px] text-fg">{label}</span>
        <span className="mt-0.5 block max-w-[300px] text-[11.5px] leading-relaxed text-muted">
          {SETTING_DESCRIPTIONS[label] ?? null}
        </span>
      </button>
      <Switch
        label={label}
        checked={checked}
        onCheckedChange={onToggle}
        className="mt-0.5"
      />
    </div>
  )
}

const SETTING_DESCRIPTIONS: Record<string, string> = {
  'Keep sessions alive':
    'Sends keepalives so idle sessions survive NAT and firewall timeouts',
  'Check for updates automatically':
    'Asks GitHub for a newer release a few times a day. Nothing about you or your servers is sent — just a download of a public file.',
  'Inline command suggestions':
    'Ghost-text completions from your history, common commands and remote paths (Tab accepts). Runs entirely on this machine.',
  'Auto-reconnect':
    'Reconnect automatically when a session drops, keeping its output'
}
const THEME_OPTIONS = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'Follow system' }
]

export function SettingsDialog() {
  const settingsOpen = useUi((s) => s.settingsOpen)
  const setSettingsOpen = useUi((s) => s.setSettingsOpen)
  const settings = useVault((s) => s.settings)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    void window.sshvault.updateState().then(setUpdate)
    return window.sshvault.onUpdateState(setUpdate)
  }, [])

  const checkNow = async () => {
    setChecking(true)
    try {
      setUpdate(await window.sshvault.updateCheck())
    } finally {
      setChecking(false)
    }
  }
  const updateSettings = useVault((s) => s.updateSettings)

  const saveTheme = async (theme: string) => {
    const saved = await updateSettings({ theme: theme as Theme })
    applyTheme(saved.theme)
  }

  const saveIdle = async (value: string) => {
    const n = parseInt(value, 10)
    if (Number.isNaN(n)) return
    await updateSettings({ idleLockMinutes: n })
  }

  return (
    <Dialog
      open={settingsOpen}
      onOpenChange={setSettingsOpen}
      title="Settings"
      description="Stored inside the encrypted vault — nothing leaves this machine."
      width="max-w-sm"
    >
      <div className="flex flex-col gap-5">
        <Field label="Theme">
          <div className="flex gap-2">
            {[
              { value: 'dark' as Theme, icon: <Moon size={14} />, label: 'Dark' },
              { value: 'light' as Theme, icon: <Sun size={14} />, label: 'Light' },
              { value: 'system' as Theme, icon: <Settings2 size={14} />, label: 'System' }
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => void saveTheme(opt.value)}
                className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border text-[13px] transition-colors duration-150 ${
                  settings.theme === opt.value
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-line bg-panel text-muted hover:text-fg'
                }`}
              >
                {opt.icon}
                {opt.label}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label="Auto-lock after (minutes of inactivity)"
          hint="Open terminal sessions keep running; reconnecting needs the master password."
        >
          <Input
            type="number"
            min={1}
            max={240}
            defaultValue={settings.idleLockMinutes}
            key={settings.idleLockMinutes}
            onBlur={(e) => void saveIdle(e.target.value)}
          />
        </Field>

        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <p className="text-[13px] font-medium text-fg">Connection</p>
          <ToggleRow
          label="Keep sessions alive"
          checked={settings.keepAlive !== false}
          onToggle={(v) => void updateSettings({ keepAlive: v })}
        />
          <ToggleRow
          label="Inline command suggestions"
          checked={settings.autocomplete !== false}
          onToggle={(v) => void updateSettings({ autocomplete: v })}
        />
          <ToggleRow
          label="Auto-reconnect"
          checked={settings.autoReconnect !== false}
          onToggle={(v) => void updateSettings({ autoReconnect: v })}
        />
        </div>

        <div className="flex flex-col gap-2.5 border-t border-line pt-4">
          <p className="text-[13px] font-medium text-fg">Updates</p>

          <ToggleRow
          label="Check for updates automatically"
          checked={settings.autoUpdate !== false}
          onToggle={(v) => void updateSettings({ autoUpdate: v })}
        />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void checkNow()}
              loading={checking}
            >
              <RefreshCw size={13} />
              Check now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void window.sshvault.openReleases()}
            >
              Release notes
            </Button>
            {update?.phase === 'ready' && (
              <Button size="sm" onClick={() => void window.sshvault.updateInstall()}>
                <Download size={13} />
                Restart and install
              </Button>
            )}
          </div>

          <p className="text-[11.5px] leading-relaxed text-muted">{describeUpdate(update)}</p>
        </div>


        <div className="border-t border-line pt-4">
          <p className="mb-2.5 text-[13px] font-medium text-fg">Move your servers</p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSettingsOpen(false)
                useUi.getState().openTransfer('export')
              }}
            >
              <ArrowDownToLine size={14} />
              Encrypted export
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSettingsOpen(false)
                useUi.getState().openTransfer('import')
              }}
            >
              <ArrowUpFromLine size={14} />
              Import file…
            </Button>
            <button
              type="button"
              onClick={() => {
                setSettingsOpen(false)
                useUi.getState().openTransfer('csv-export')
              }}
              className="col-span-2 flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[12.5px] text-muted transition-colors duration-150 hover:bg-panel-2 hover:text-warn"
            >
              <FileSpreadsheet size={13} />
              Export as CSV (plaintext passwords)
            </button>
          </div>
        </div>

        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => setSettingsOpen(false)}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export { THEME_OPTIONS }

/**
 * Human-readable status line for the Updates section. Deliberately quiet:
 * a failed check is a sentence, not an error dialog, because it should never
 * interrupt someone working on a server.
 */
function describeUpdate(state: UpdateState | null): string {
  if (!state) return 'Not checked yet.'
  switch (state.phase) {
    case 'disabled':
      return state.error ?? 'Automatic checks are off.'
    case 'checking':
      return 'Checking GitHub for a newer version…'
    case 'up-to-date':
      return state.checkedAt
        ? `You are on the latest version (checked ${new Date(state.checkedAt).toLocaleString()}).`
        : 'You are on the latest version.'
    case 'downloading':
      return `Downloading version ${state.version ?? ''}… ${state.percent ?? 0}%`
    case 'ready':
      return `Version ${state.version ?? ''} is downloaded and ready. Restart when convenient — open SSH sessions will close.`
    case 'error':
      return `Could not check for updates: ${state.error ?? 'unknown error'}`
    default:
      return 'Not checked yet.'
  }
}
