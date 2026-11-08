import { useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  FileLock2,
  FileSpreadsheet,
  FolderOpen
} from 'lucide-react'
import { masterPasswordIssues } from '@shared/schemas'
import type { ImportPickResult, ImportSummary } from '@shared/types'
import { Button, Checkbox, Dialog, Field, PasswordInput, Spinner, Switch } from './ui'
import { friendlyError } from '../lib/errors'
import { useUi } from '../stores/ui'
import { useVault } from '../stores/vault'

/** Extensions the import accepts — kept in sync with the main-process picker. */
const IMPORT_EXTENSIONS = ['.sshvault', '.csv', '.txt', '.json']

/**
 * Batch transfer of credentials: encrypted export/import (machine-to-machine
 * migration) and plaintext CSV export (interop, explicit risk acceptance).
 * The picked import file never touches the renderer — only its format does.
 */
export function TransferDialog() {
  const transfer = useUi((s) => s.transfer)
  if (!transfer) return null
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) useUi.getState().closeTransfer()
      }}
      width="max-w-md"
    >
      {transfer.mode === 'export' && <ExportPanel />}
      {transfer.mode === 'csv-export' && <CsvExportPanel />}
      {transfer.mode === 'import' && <ImportPanel />}
    </Dialog>
  )
}

function ExportPanel() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [includePins, setIncludePins] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedTo, setSavedTo] = useState<string | null>(null)

  const issues = masterPasswordIssues(password)
  const canExport = password && password === confirm && issues.length === 0

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.sshvault.vaultExportEncrypted({
        exportPassword: password,
        includePinnedHostKeys: includePins
      })
      if (result.ok && result.path) setSavedTo(result.path)
      else if (!result.ok) useUi.getState().closeTransfer() // user cancelled save dialog
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-fg">
        <FileLock2 size={17} className="text-accent" />
        Export vault (encrypted)
      </Dialog.Title>
      <Dialog.Description className="mt-1 text-[13px] leading-relaxed text-muted">
        Every server — passwords included — sealed with a password you choose. The file is useless
        without it: safe to store or move, perfect for setting up a new machine.
      </Dialog.Description>

      {savedTo ? (
        <div className="mt-5 flex flex-col items-center gap-3 py-4 text-center">
          <CheckCircle2 size={28} className="text-ok" />
          <p className="text-[13px] text-fg">Encrypted export saved</p>
          <code className="w-full break-all rounded-lg border border-line bg-inset px-3 py-2 font-mono text-[11.5px] text-muted">
            {savedTo}
          </code>
          <Button variant="secondary" onClick={() => useUi.getState().closeTransfer()}>
            Done
          </Button>
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-4">
          <Field
            label="Export password"
            hint={`At least 10 characters. You'll enter it on the new machine — don't lose it.`}
          >
            <PasswordInput value={password} onChange={setPassword} placeholder="Protects the export file" />
          </Field>
          {password && issues.length > 0 && (
            <p className="text-[12px] text-warn">{issues.join(' · ')}</p>
          )}
          <Field
            label="Confirm password"
            error={confirm && password !== confirm ? 'Passwords do not match' : undefined}
          >
            <PasswordInput value={confirm} onChange={setConfirm} placeholder="Repeat the export password" />
          </Field>
          <div className="flex items-center justify-between rounded-xl border border-line bg-inset px-4 py-3">
            <div>
              <p className="text-[13px] font-medium text-fg">Include pinned host keys</p>
              <p className="text-[12px] text-muted">Skips the first-connect fingerprint prompts on import</p>
            </div>
            <Switch label="Include pinned host keys" checked={includePins} onCheckedChange={setIncludePins} />
          </div>
          {error && (
            <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => useUi.getState().closeTransfer()}>
              Cancel
            </Button>
            <Button onClick={run} loading={busy} disabled={!canExport}>
              <ArrowDownToLine size={15} />
              Choose location &amp; export
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

function CsvExportPanel() {
  const servers = useVault((s) => s.servers)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedTo, setSavedTo] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.sshvault.vaultExportCsv()
      if (result.ok && result.path) setSavedTo(result.path)
      else if (!result.ok) useUi.getState().closeTransfer()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-fg">
        <FileSpreadsheet size={17} className="text-warn" />
        Export as CSV
      </Dialog.Title>
      <Dialog.Description className="mt-1 text-[13px] leading-relaxed text-muted">
        A plain spreadsheet of all {servers.length} servers — readable by humans, scripts and
        other tools.
      </Dialog.Description>

      {savedTo ? (
        <div className="mt-5 flex flex-col items-center gap-3 py-4 text-center">
          <CheckCircle2 size={28} className="text-ok" />
          <p className="text-[13px] text-fg">CSV saved</p>
          <code className="w-full break-all rounded-lg border border-line bg-inset px-3 py-2 font-mono text-[11.5px] text-muted">
            {savedTo}
          </code>
          <Button variant="secondary" onClick={() => useUi.getState().closeTransfer()}>
            Done
          </Button>
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-4">
          <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-3 text-[12.5px] leading-relaxed text-warn">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            This file contains every password in readable plaintext. Anyone who opens it sees
            everything. Delete it as soon as you're done with it.
          </p>
          <Checkbox
            checked={ack}
            onCheckedChange={setAck}
            label="I understand the risk — export plaintext anyway"
            className="text-[13px] text-fg"
          />
          {error && (
            <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => useUi.getState().closeTransfer()}>
              Cancel
            </Button>
            <Button variant="danger" onClick={run} loading={busy} disabled={!ack}>
              <ArrowDownToLine size={15} />
              Export CSV
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

function ImportPanel() {
  const servers = useVault((s) => s.servers)
  const applyServers = useVault((s) => s.setServers)
  const [picked, setPicked] = useState<ImportPickResult | null>(null)
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [replaceAck, setReplaceAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ summary: ImportSummary; warnings?: string[] } | null>(null)
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)

  const adopt = (r: ImportPickResult) => {
    setPicked(r)
    setError(null)
    setResult(null)
  }

  const pick = async () => {
    setError(null)
    setResult(null)
    try {
      const r = await window.sshvault.vaultImportPick()
      if (r.ok) adopt(r)
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  /** Drag & drop: resolve the File to a path in the preload (File.path is gone
   * from Electron), then let the main process read it — contents never cross. */
  const pickDropped = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = 0
    setDropping(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!IMPORT_EXTENSIONS.includes(ext)) {
      setError(`"${file.name}" is not an import file — expected ${IMPORT_EXTENSIONS.join(' or ')}`)
      return
    }
    try {
      const path = window.sshvault.pathForFile(file)
      const r = await window.sshvault.vaultImportFile({ path })
      if (r.ok) adopt(r)
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current++
    setDropping(true)
  }
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDropping(false)
  }
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    // Must be prevented or Chromium replaces the whole app with the file.
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const run = async () => {
    if (!picked?.ok || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.sshvault.vaultImportApply({
        exportPassword: picked.format === 'encrypted' ? password : undefined,
        mode
      })
      applyServers(r.servers)
      setResult({ summary: r.summary, warnings: r.warnings })
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  const canImport =
    picked?.ok &&
    (picked.format === 'csv' || password.length > 0) &&
    (mode === 'merge' || replaceAck)

  return (
    <>
      <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-fg">
        <FolderOpen size={17} className="text-accent" />
        Import servers
      </Dialog.Title>
      <Dialog.Description className="mt-1 text-[13px] leading-relaxed text-muted">
        Load a batch of servers from an encrypted SSH Vault export (.sshvault) or a CSV file.
      </Dialog.Description>

      {result ? (
        <div className="mt-5 flex flex-col gap-3">
          <div className="flex items-center gap-2.5 rounded-xl border border-ok/30 bg-[color-mix(in_srgb,var(--ok)_8%,transparent)] px-4 py-3">
            <CheckCircle2 size={20} className="shrink-0 text-ok" />
            <p className="text-[13px] text-fg">
              {result.summary.replaced
                ? `Replaced the vault with ${result.summary.added} imported servers.`
                : `Added ${result.summary.added} servers${
                    result.summary.skippedDuplicates
                      ? `, skipped ${result.summary.skippedDuplicates} already present`
                      : ''
                  }.`}
            </p>
          </div>
          {result.warnings && result.warnings.length > 0 && (
            <ul className="max-h-32 overflow-y-auto rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-[12px] leading-relaxed text-warn">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button onClick={() => useUi.getState().closeTransfer()}>Done</Button>
          </div>
        </div>
      ) : (
        <div
          className="mt-5 flex flex-col gap-4"
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={(e) => void pickDropped(e)}
        >
          <Button
            variant="outline"
            onClick={pick}
            className={`h-16 w-full justify-center gap-2 rounded-xl border-dashed text-[13px] font-normal text-muted hover:border-accent/60 hover:text-accent ${
              dropping ? 'border-accent bg-accent-soft text-accent' : ''
            }`}
          >
            <FolderOpen size={16} />
            {picked?.ok && picked.fileName ? (
              <span className="flex items-center gap-2">
                <span className="font-mono text-[12px] text-fg">{picked.fileName}</span>
                <span className="rounded border border-line bg-inset px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                  {picked.format === 'encrypted' ? 'Encrypted' : 'CSV'}
                </span>
                <span className="text-faint">— click or drop another</span>
              </span>
            ) : dropping ? (
              'Drop the file to use it…'
            ) : (
              'Drop a .sshvault or .csv file here, or click to browse…'
            )}
          </Button>

          {picked?.ok && picked.format === 'encrypted' && (
            <Field label="Export password">
              <PasswordInput
                value={password}
                onChange={setPassword}
                placeholder="Password used when the file was created"
                invalid={!!error}
              />
            </Field>
          )}
          {/* Rendered for every failure — pick/drop errors too, which used to
              be invisible because the panel only showed errors after a file
              was successfully chosen. */}
          {error && (
            <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          )}

          {picked?.ok && (
            <div className="flex flex-col gap-2">
              <ModeButton
                active={mode === 'merge'}
                onClick={() => setMode('merge')}
                title="Merge (recommended)"
                description={`Add new servers; keep your existing ${servers.length}. Duplicates (same name, host, port and user) are skipped.`}
              />
              <ModeButton
                active={mode === 'replace'}
                onClick={() => setMode('replace')}
                title="Replace everything"
                description={`Delete all ${servers.length} existing servers and pins, then load the file's contents.`}
                danger
              />
            </div>
          )}

          {mode === 'replace' && picked?.ok && (
            <div className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2.5">
              <Checkbox
                checked={replaceAck}
                onCheckedChange={setReplaceAck}
                label={`Yes, permanently delete my ${servers.length} current servers first`}
                className="text-[12.5px] text-danger"
              />
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => useUi.getState().closeTransfer()}>
              Cancel
            </Button>
            <Button onClick={run} loading={busy} disabled={!canImport}>
              {busy ? <Spinner size={14} /> : <CheckCircle2 size={15} />}
              Import
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

function ModeButton({
  active,
  onClick,
  title,
  description,
  danger
}: {
  active: boolean
  onClick: () => void
  title: string
  description: string
  danger?: boolean
}) {
  return (
    <Button
      variant="outline"
      onClick={onClick}
      className={`h-auto min-h-0 flex-col items-start justify-start gap-0 rounded-xl px-4 py-3 text-left font-normal ${
        active
          ? danger
            ? 'border-danger bg-danger-soft hover:bg-danger-soft'
            : 'border-accent bg-accent-soft hover:bg-accent-soft'
          : 'border-line bg-inset hover:border-accent/50'
      }`}
    >
      <span className={`text-[13px] font-medium ${danger ? 'text-danger' : active ? 'text-accent' : 'text-fg'}`}>
        {title}
      </span>
      <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{description}</p>
    </Button>
  )
}
