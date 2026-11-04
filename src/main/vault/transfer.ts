import { randomUUID } from 'node:crypto'
import type { HostKeyPin, ImportSummary, ServerEntry, ServerUpsertInput } from '@shared/types'
import { normalizeTags } from '@shared/schemas'
import {
  VaultDecryptError,
  deriveKey,
  newHeader,
  openPayload,
  parseVaultFile,
  sealPayload
} from './crypto'
import { UnlockFailedError, type VaultStore } from './store'

export const EXPORT_APP_ID = 'ssh-vault-export'
export const MIN_EXPORT_PASSWORD = 10

/**
 * Encrypted export document: same envelope as the vault itself (Argon2id +
 * AES-256-GCM with the header bound as AAD), but sealed under a password the
 * user chooses for the export file. Safe to carry on a USB stick or cloud
 * drive — without that password it is indistinguishable from random bytes.
 */
export interface ExportPayload {
  app: typeof EXPORT_APP_ID
  format: 1
  exportedAt: string
  servers: ServerEntry[]
  pinnedHostKeys: HostKeyPin[]
  includePinnedHostKeys: boolean
}

export async function exportEncrypted(
  servers: ReadonlyArray<ServerEntry>,
  pinnedHostKeys: ReadonlyArray<HostKeyPin>,
  includePinnedHostKeys: boolean,
  exportPassword: string
): Promise<string> {
  if (exportPassword.length < MIN_EXPORT_PASSWORD) {
    throw new Error(`invalid-input:export password must be at least ${MIN_EXPORT_PASSWORD} characters`)
  }
  const header = newHeader()
  const salt = Buffer.from(header.kdf.saltB64, 'base64')
  const key = await deriveKey(exportPassword, salt, header.kdf)
  const payload: ExportPayload = {
    app: EXPORT_APP_ID,
    format: 1,
    exportedAt: new Date().toISOString(),
    servers: servers.map((s) => ({ ...s })),
    pinnedHostKeys: includePinnedHostKeys ? pinnedHostKeys.map((p) => ({ ...p })) : [],
    includePinnedHostKeys
  }
  const doc = { header, sealed: sealPayload(key, header, JSON.stringify(payload)) }
  key.fill(0)
  return JSON.stringify(doc, null, 2)
}

export async function openEncryptedExport(
  raw: string,
  exportPassword: string
): Promise<ExportPayload> {
  let doc: ReturnType<typeof parseVaultFile>
  try {
    doc = parseVaultFile(raw)
  } catch {
    throw new Error('invalid-input:not an SSH Vault export file')
  }
  const salt = Buffer.from(doc.header.kdf.saltB64, 'base64')
  const key = await deriveKey(exportPassword, salt, doc.header.kdf)
  let payload: ExportPayload
  try {
    payload = JSON.parse(openPayload(key, doc.header, doc.sealed))
  } catch (err) {
    if (err instanceof VaultDecryptError) throw new UnlockFailedError()
    throw err
  } finally {
    key.fill(0)
  }
  if (payload?.app !== EXPORT_APP_ID || !Array.isArray(payload.servers)) {
    throw new Error('invalid-input:not an SSH Vault export file')
  }
  return payload
}

/** Cheap sniff used by the import picker to decide which flow to show. */
export function looksLikeEncryptedExport(raw: string): boolean {
  try {
    const doc = JSON.parse(raw)
    return !!doc?.header?.kdf?.saltB64 && !!doc?.sealed?.ctB64
  } catch {
    return false
  }
}

// --------------------------------------------------------------------------
// CSV (RFC 4180: quoted fields, escaped quotes, commas and newlines in cells)
// --------------------------------------------------------------------------

export const CSV_COLUMNS = [
  'name',
  'host',
  'port',
  'username',
  'password',
  'tags',
  'notes',
  'auto_sudo',
  'sudo_command'
] as const

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '')
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function serversToCsv(servers: ReadonlyArray<ServerEntry>): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const s of servers) {
    lines.push(
      [
        csvCell(s.name),
        csvCell(s.host),
        String(s.port),
        csvCell(s.username),
        csvCell(s.password),
        csvCell(s.tags.join(';')),
        csvCell(s.notes ?? ''),
        s.elevate.enabled ? 'yes' : 'no',
        csvCell(s.elevate.preset === 'custom' ? s.elevate.customCommand : s.elevate.preset)
      ].join(',')
    )
  }
  return lines.join('\r\n') + '\r\n'
}

export interface CsvImportResult {
  inputs: ServerUpsertInput[]
  errors: string[]
}

export function serversFromCsv(text: string): CsvImportResult {
  const rows = parseCsv(text)
  const errors: string[] = []
  if (rows.length === 0) return { inputs: [], errors: ['The file is empty'] }

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const idx = (col: string) => header.indexOf(col)
  const iName = idx('name')
  const iHost = idx('host')
  const iPort = idx('port')
  const iUser = idx('username')
  const iPw = idx('password')
  if (iName === -1 || iHost === -1 || iUser === -1 || iPw === -1) {
    return {
      inputs: [],
      errors: [
        `Missing required columns. Expected at least: name, host, username, password (found: ${header.join(', ')})`
      ]
    }
  }

  const inputs: ServerUpsertInput[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const line = r + 1
    const name = (row[iName] ?? '').trim()
    const host = (row[iHost] ?? '').trim()
    const username = (row[iUser] ?? '').trim()
    const password = row[iPw] ?? ''
    const portStr = (iPort !== -1 ? row[iPort] : '22')?.trim() || '22'
    const port = Number.parseInt(portStr, 10)
    if (!name || !host || !username) {
      errors.push(`Row ${line}: name, host and username are required — skipped`)
      continue
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`Row ${line}: invalid port "${portStr}" — skipped`)
      continue
    }
    const sudoRaw = (idx('auto_sudo') !== -1 ? row[idx('auto_sudo')] : 'no')?.trim().toLowerCase()
    const sudoCommand = (idx('sudo_command') !== -1 ? row[idx('sudo_command')] : 'sudo -s')?.trim()
    const preset: 'sudo -s' | 'sudo -i' | 'sudo su -' | 'custom' =
      sudoCommand === 'sudo -s' || sudoCommand === 'sudo -i' || sudoCommand === 'sudo su -'
        ? sudoCommand
        : 'custom'
    inputs.push({
      name,
      host,
      port,
      username,
      authMethod: 'password' as const,
      password: password || undefined,
      tags: normalizeTags(((idx('tags') !== -1 ? row[idx('tags')] : '') ?? '').split(';')),
      notes: (idx('notes') !== -1 ? row[idx('notes')] : '') ?? '',
      elevate: {
        enabled: sudoRaw === 'yes' || sudoRaw === 'true' || sudoRaw === '1',
        preset,
        customCommand: preset === 'custom' ? sudoCommand || 'sudo -s' : '',
        passwordMode: 'same'
      }
    })
  }
  return { inputs, errors }
}

// --------------------------------------------------------------------------
// Applying an import into the live vault
// --------------------------------------------------------------------------

const naturalKey = (s: ServerEntry) => `${s.name}\n${s.host}\n${s.port}\n${s.username}`

/** Deep-copies incoming entries, assigns fresh ids when they collide. */
function cloneIncoming(servers: ReadonlyArray<ServerEntry>, takenIds: Set<string>): ServerEntry[] {
  return servers.map((s) => {
    const copy: ServerEntry = {
      ...s,
      id: takenIds.has(s.id) ? randomUUID() : s.id,
      tags: normalizeTags(s.tags ?? []),
      notes: s.notes ?? '',
      // Preserve key-based auth through export/import; an imported key is
      // already encrypted inside the transport envelope.
      authMethod: s.authMethod === 'key' || s.authMethod === 'agent' ? s.authMethod : 'password',
      keyAuth:
        s.authMethod === 'key' && s.keyAuth?.privateKey
          ? { privateKey: s.keyAuth.privateKey, passphrase: s.keyAuth.passphrase ?? '' }
          : null,
      elevate: {
        enabled: !!s.elevate?.enabled,
        preset: s.elevate?.preset ?? 'sudo -s',
        customCommand: s.elevate?.customCommand ?? '',
        passwordMode: s.elevate?.passwordMode === 'custom' ? 'custom' : 'same',
        customPassword: s.elevate?.passwordMode === 'custom' ? s.elevate?.customPassword ?? '' : ''
      },
      createdAt: s.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastConnectedAt: s.lastConnectedAt ?? null
    }
    takenIds.add(copy.id)
    return copy
  })
}

export async function applyImport(
  store: VaultStore,
  incoming: { servers: ReadonlyArray<ServerEntry>; pinnedHostKeys?: ReadonlyArray<HostKeyPin> },
  mode: 'merge' | 'replace'
): Promise<ImportSummary> {
  return store.mutate((payload) => {
    if (mode === 'replace') {
      const servers = cloneIncoming(incoming.servers, new Set())
      const pins = incoming.pinnedHostKeys ? [...incoming.pinnedHostKeys] : []
      payload.servers = servers
      payload.pinnedHostKeys = pins
      return { added: servers.length, skippedDuplicates: 0, replaced: true }
    }

    const takenIds = new Set(payload.servers.map((s) => s.id))
    const existingKeys = new Set(payload.servers.map(naturalKey))
    const existingPins = new Set(payload.pinnedHostKeys.map((p) => `${p.host}\n${p.port}`))
    let added = 0
    let skippedDuplicates = 0
    const fresh = cloneIncoming(incoming.servers, takenIds)
    for (const s of fresh) {
      if (existingKeys.has(naturalKey(s))) {
        skippedDuplicates++
        continue
      }
      existingKeys.add(naturalKey(s))
      payload.servers.push(s)
      added++
    }
    for (const pin of incoming.pinnedHostKeys ?? []) {
      if (!existingPins.has(`${pin.host}\n${pin.port}`)) {
        existingPins.add(`${pin.host}\n${pin.port}`)
        payload.pinnedHostKeys.push({ ...pin })
      }
    }
    return { added, skippedDuplicates, replaced: false }
  })
}
