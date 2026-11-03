import { ArrowDownToLine, ArrowUpFromLine, FileSpreadsheet, Moon, Settings2, Sun } from 'lucide-react'
import type { Theme } from '@shared/types'
import { Button, Dialog, Field, Input } from './ui'
import { applyTheme } from '../lib/theme'
import { useUi } from '../stores/ui'
import { useVault } from '../stores/vault'

const THEME_OPTIONS = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'Follow system' }
]

export function SettingsDialog() {
  const settingsOpen = useUi((s) => s.settingsOpen)
  const setSettingsOpen = useUi((s) => s.setSettingsOpen)
  const settings = useVault((s) => s.settings)
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
