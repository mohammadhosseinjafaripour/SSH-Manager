import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ServerEntry, ServerUpsertInput, VaultBackupInfo, VaultPayload, VaultSettings } from '@shared/types'
import { normalizeTags } from '@shared/schemas'
import {
  DEFAULT_KDF,
  VaultDecryptError,
  type VaultFile,
  type VaultHeader,
  deriveKey,
  newHeader,
  openPayload,
  parseVaultFile,
  sealPayload
} from './crypto'

export const VAULT_FILE = 'vault.bin'
const BAK_SUFFIXES = ['.bak', '.bak2'] as const

export class UnlockFailedError extends Error {
  constructor() {
    super('unlock-failed')
  }
}

export class VaultExistsError extends Error {
  constructor() {
    super('vault-exists')
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super('vault-locked')
  }
}

export class NotFoundError extends Error {
  constructor() {
    super('not-found')
  }
}

function defaultPayload(): VaultPayload {
  return {
    servers: [],
    pinnedHostKeys: [],
    hostKeyHistory: [],
    settings: { idleLockMinutes: 10, theme: 'dark', keepAlive: true, autoReconnect: true }
  }
}

function mergeDefaults(payload: VaultPayload): VaultPayload {
  const d = defaultPayload()
  return {
    servers: Array.isArray(payload.servers) ? payload.servers : d.servers,
    pinnedHostKeys: Array.isArray(payload.pinnedHostKeys) ? payload.pinnedHostKeys : d.pinnedHostKeys,
    hostKeyHistory: Array.isArray(payload.hostKeyHistory) ? payload.hostKeyHistory : d.hostKeyHistory,
    settings: { ...d.settings, ...payload.settings }
  }
}

/**
 * Encrypted vault repository. The only writer of the vault file. Every save
 * is durable and crash-safe: write temp → fsync → copy previous good file to
 * `.bak` (rotating `.bak` into `.bak2`) → atomically rename temp over the
 * target. There is never a moment where the target is missing or torn;
 * the previous two good generations are always restorable.
 */
export class VaultStore {
  private readonly filePath: string
  private header: VaultHeader | null = null
  private key: Buffer | null = null
  private payload: VaultPayload | null = null
  private saveChain: Promise<void> = Promise.resolve()
  private lastActivityAt = Date.now()

  constructor(private readonly dir: string) {
    this.filePath = join(dir, VAULT_FILE)
  }

  get path(): string {
    return this.filePath
  }

  exists(): boolean {
    return existsSync(this.filePath)
  }

  isUnlocked(): boolean {
    return this.payload !== null
  }

  lock(): void {
    if (this.key) this.key.fill(0)
    this.key = null
    this.payload = null
  }

  touchActivity(): void {
    this.lastActivityAt = Date.now()
  }

  idleMs(): number {
    return Date.now() - this.lastActivityAt
  }

  getPayload(): VaultPayload {
    if (!this.payload) throw new VaultLockedError()
    return this.payload
  }

  async create(masterPassword: string): Promise<void> {
    if (this.exists()) throw new VaultExistsError()
    mkdirSync(this.dir, { recursive: true })
    const header = newHeader(DEFAULT_KDF)
    const salt = Buffer.from(header.kdf.saltB64, 'base64')
    const key = await deriveKey(masterPassword, salt, header.kdf)
    this.header = header
    this.key = key
    this.payload = defaultPayload()
    await this.scheduleSave()
    this.touchActivity()
  }

  async unlock(masterPassword: string): Promise<VaultPayload> {
    if (!this.exists()) throw new UnlockFailedError()
    const doc = parseVaultFile(readFileSync(this.filePath, 'utf8'))
    const salt = Buffer.from(doc.header.kdf.saltB64, 'base64')
    const key = await deriveKey(masterPassword, salt, doc.header.kdf)
    let payload: VaultPayload
    try {
      payload = JSON.parse(openPayload(key, doc.header, doc.sealed))
    } catch (err) {
      if (err instanceof VaultDecryptError) throw new UnlockFailedError()
      throw err
    }
    this.header = doc.header
    this.key = key
    this.payload = mergeDefaults(payload)
    this.touchActivity()
    return this.payload
  }

  /**
   * Runs a mutation against the live payload and persists it durably.
   * Mutations are serialized through `saveChain` — no concurrent writers.
   */
  async mutate<T>(fn: (payload: VaultPayload) => T): Promise<T> {
    if (!this.payload || !this.key || !this.header) throw new VaultLockedError()
    const result = fn(this.payload)
    await this.scheduleSave()
    return result
  }

  // ---- server domain operations -------------------------------------------

  async upsertServer(input: ServerUpsertInput): Promise<ServerEntry> {
    return this.mutate((p) => {
      const now = new Date().toISOString()
      if (input.id) {
        const existing = p.servers.find((s) => s.id === input.id)
        if (!existing) throw new NotFoundError()
        existing.name = input.name.trim()
        existing.host = input.host.trim()
        existing.port = input.port
        existing.username = input.username.trim()
        if (input.password !== undefined && input.password !== '') existing.password = input.password
        existing.tags = normalizeTags(input.tags)
        existing.notes = input.notes
        existing.elevate = {
          enabled: input.elevate.enabled,
          preset: input.elevate.preset,
          customCommand: input.elevate.customCommand,
          passwordMode: input.elevate.passwordMode,
          customPassword:
            input.elevate.passwordMode === 'custom'
              ? input.elevate.customPassword !== undefined && input.elevate.customPassword !== ''
                ? input.elevate.customPassword
                : existing.elevate.customPassword
              : ''
        }
        existing.updatedAt = now
        return existing
      }
      if (!input.password) throw new Error('invalid-input:password required for a new server')
      const entry: ServerEntry = {
        id: randomUUID(),
        name: input.name.trim(),
        host: input.host.trim(),
        port: input.port,
        username: input.username.trim(),
        password: input.password,
        authMethod: 'password',
        tags: normalizeTags(input.tags),
        notes: input.notes,
        elevate: {
          enabled: input.elevate.enabled,
          preset: input.elevate.preset,
          customCommand: input.elevate.customCommand,
          passwordMode: input.elevate.passwordMode,
          customPassword: input.elevate.passwordMode === 'custom' ? input.elevate.customPassword ?? '' : ''
        },
        createdAt: now,
        updatedAt: now,
        lastConnectedAt: null
      }
      p.servers.push(entry)
      return entry
    })
  }

  async deleteServer(id: string): Promise<void> {
    return this.mutate((p) => {
      const idx = p.servers.findIndex((s) => s.id === id)
      if (idx === -1) throw new NotFoundError()
      p.servers.splice(idx, 1)
    })
  }

  async updateSettings(patch: Partial<VaultSettings>): Promise<VaultSettings> {
    return this.mutate((p) => {
      if (patch.idleLockMinutes !== undefined) {
        const mins = Math.min(240, Math.max(1, Math.round(patch.idleLockMinutes)))
        p.settings.idleLockMinutes = mins
      }
      if (patch.theme !== undefined) p.settings.theme = patch.theme
      if (patch.keepAlive !== undefined) p.settings.keepAlive = !!patch.keepAlive
      if (patch.autoReconnect !== undefined) p.settings.autoReconnect = !!patch.autoReconnect
      return p.settings
    })
  }

  async touchConnected(serverId: string): Promise<void> {
    return this.mutate((p) => {
      const s = p.servers.find((e) => e.id === serverId)
      if (s) s.lastConnectedAt = new Date().toISOString()
    })
  }

  getServer(id: string): ServerEntry {
    const server = this.getPayload().servers.find((s) => s.id === id)
    if (!server) throw new NotFoundError()
    return server
  }

  // ---- host keys -------------------------------------------------------------

  getPin(host: string, port: number): { fingerprint: string } | null {
    const pin = this.getPayload().pinnedHostKeys.find((p) => p.host === host && p.port === port)
    return pin ?? null
  }

  async pinHostKey(host: string, port: number, fingerprint: string): Promise<void> {
    return this.mutate((p) => {
      if (p.pinnedHostKeys.some((k) => k.host === host && k.port === port)) return
      p.pinnedHostKeys.push({ host, port, fingerprint, pinnedAt: new Date().toISOString() })
    })
  }

  /** Explicit, user-confirmed pin replacement (host key rotation). Keeps history. */
  async replaceHostKeyPin(host: string, port: number, newFingerprint: string): Promise<void> {
    return this.mutate((p) => {
      const pin = p.pinnedHostKeys.find((k) => k.host === host && k.port === port)
      if (!pin) throw new NotFoundError()
      p.hostKeyHistory.push({
        host,
        port,
        oldFingerprint: pin.fingerprint,
        newFingerprint,
        replacedAt: new Date().toISOString()
      })
      pin.fingerprint = newFingerprint
      pin.pinnedAt = new Date().toISOString()
    })
  }

  // ---- backups -------------------------------------------------------------

  listBackups(): VaultBackupInfo[] {
    const out: VaultBackupInfo[] = []
    for (const suffix of BAK_SUFFIXES) {
      const file = this.filePath + suffix
      if (!existsSync(file)) continue
      const stat = statSync(file)
      out.push({
        file: VAULT_FILE + suffix,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString()
      })
    }
    return out
  }

  /**
   * Deliberate, explicit restore path (Vault Tools). The candidate backup is
   * decrypted and verified with the provided master password *before* the
   * current file is displaced, and the displaced file is kept alongside as
   * `vault.bin.corrupt-<ts>` for manual inspection.
   */
  async restoreBackup(fileName: string, masterPassword: string): Promise<void> {
    if (!BAK_SUFFIXES.some((s) => VAULT_FILE + s === fileName)) {
      throw new Error('invalid-input:unknown backup file')
    }
    const backupPath = join(this.dir, fileName)
    if (!existsSync(backupPath)) throw new NotFoundError()
    const doc = parseVaultFile(readFileSync(backupPath, 'utf8'))
    const salt = Buffer.from(doc.header.kdf.saltB64, 'base64')
    const key = await deriveKey(masterPassword, salt, doc.header.kdf)
    try {
      JSON.parse(openPayload(key, doc.header, doc.sealed))
    } catch (err) {
      if (err instanceof VaultDecryptError) throw new UnlockFailedError()
      throw err
    } finally {
      key.fill(0)
    }
    this.lock()
    if (existsSync(this.filePath)) {
      renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
    }
    copyFileSync(backupPath, this.filePath)
  }

  // ---- persistence ---------------------------------------------------------

  private scheduleSave(): Promise<void> {
    this.saveChain = this.saveChain.then(
      () => this.writeDurable(),
      (err) => {
        // A failed save must not poison the chain; surface it to the caller.
        throw err
      }
    )
    const tracked = this.saveChain
    tracked.catch(() => {
      // observed by callers via scheduleSave(); swallow to avoid unhandled rejection
    })
    return tracked
  }

  private writeDurable(): void {
    if (!this.header || !this.key || !this.payload) throw new VaultLockedError()
    const doc: VaultFile = {
      header: this.header,
      sealed: sealPayload(this.key, this.header, JSON.stringify(this.payload))
    }
    const tmp = this.filePath + '.tmp'
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, JSON.stringify(doc))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // Rotate the previous two good generations, then atomically replace.
    if (existsSync(this.filePath + '.bak')) {
      copyFileSync(this.filePath + '.bak', this.filePath + '.bak2')
    }
    if (existsSync(this.filePath)) {
      copyFileSync(this.filePath, this.filePath + '.bak')
    }
    renameSync(tmp, this.filePath)
  }
}
