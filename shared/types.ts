/**
 * Shared contract between the Electron main process, the preload bridge and
 * the renderer. This file is the single source of truth for the IPC surface:
 * secrets never cross this boundary unless explicitly requested (on-demand
 * secret fetch for the edit dialog, and connect-time data that stays in main).
 */

export type Theme = 'dark' | 'light' | 'system'

export type ElevatePreset = 'sudo -s' | 'sudo -i' | 'sudo su -' | 'custom'

export interface ElevateConfig {
  enabled: boolean
  preset: ElevatePreset
  customCommand: string
  passwordMode: 'same' | 'custom'
  customPassword: string
}

export interface ServerEntry {
  id: string
  name: string
  host: string
  port: number
  username: string
  /** Server login password (secret — main process only). */
  password: string
  /** Placeholder for v2 (SSH keys); password auth only in MVP. */
  authMethod: 'password'
  tags: string[]
  notes: string
  elevate: ElevateConfig
  createdAt: string
  updatedAt: string
  lastConnectedAt: string | null
}

/** Renderer-safe projection of a server: no secrets. */
export interface ServerView {
  id: string
  name: string
  host: string
  port: number
  username: string
  tags: string[]
  notes: string
  elevate: {
    enabled: boolean
    preset: ElevatePreset
    customCommand: string
    passwordMode: 'same' | 'custom'
    hasCustomPassword: boolean
  }
  createdAt: string
  updatedAt: string
  lastConnectedAt: string | null
}

export interface ServerUpsertInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  /** Omit/undefined on edit = keep the existing stored password. */
  password?: string
  tags: string[]
  notes: string
  elevate: {
    enabled: boolean
    preset: ElevatePreset
    customCommand: string
    passwordMode: 'same' | 'custom'
    /** Omit/undefined on edit = keep the existing stored sudo password. */
    customPassword?: string
  }
}

export interface HostKeyPin {
  host: string
  port: number
  /** SHA256:<base64> of the host key blob. */
  fingerprint: string
  pinnedAt: string
}

export interface HostKeyHistoryEntry {
  host: string
  port: number
  oldFingerprint: string
  newFingerprint: string
  replacedAt: string
}

export interface VaultSettings {
  idleLockMinutes: number
  theme: Theme
}

export interface VaultPayload {
  servers: ServerEntry[]
  pinnedHostKeys: HostKeyPin[]
  hostKeyHistory: HostKeyHistoryEntry[]
  settings: VaultSettings
}

export interface VaultBackupInfo {
  file: string
  sizeBytes: number
  modifiedAt: string
}

export type SessionStatus =
  | 'connecting'
  | 'connected'
  | 'elevated'
  | 'elevated-unverified'
  | 'elevated-no-prompt'
  | 'elevate-failed'
  | 'hostkey-unknown'
  | 'hostkey-changed'
  | 'auth-failed'
  | 'closed'
  | 'error'

/** Messages main → renderer, over the per-session MessagePort. */
export type MainPortMessage =
  | { type: 'data'; data: string }
  | { type: 'status'; status: SessionStatus; detail?: string }
  | {
      type: 'hostkey'
      kind: 'unknown' | 'changed'
      fingerprint: string
      pinnedFingerprint?: string
    }
  | {
      type: 'ki'
      name: string
      instruction: string
      prompts: ReadonlyArray<{ prompt: string; echo: boolean }>
    }

/** Messages renderer → main, over the per-session MessagePort. */
export type RendererPortMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'activity' }
  | { type: 'hostkey-decision'; accept: boolean }
  | { type: 'ki-answer'; responses: string[] }

/** Preload-wrapped MessagePort handed to the renderer per session. */
export interface SessionPort {
  send(msg: RendererPortMessage): void
  onMessage(cb: (msg: MainPortMessage) => void): void
  close(): void
}

export interface TestConnectionResult {
  ok: boolean
  fingerprint?: string
  pinned: boolean
  message: string
}

/**
 * The complete typed surface exposed on `window.sshvault` via contextBridge.
 * Deliberately narrow: the renderer can do exactly what the UI needs and
 * nothing more.
 */
export interface Bridge {
  vaultStatus(): Promise<{ exists: boolean }>
  vaultCreate(
    masterPassword: string
  ): Promise<{ settings: VaultSettings; servers: ServerView[] }>
  vaultUnlock(
    masterPassword: string
  ): Promise<{ settings: VaultSettings; servers: ServerView[] }>
  vaultLock(): Promise<void>
  vaultActivity(): Promise<void>
  vaultBackups(): Promise<VaultBackupInfo[]>
  vaultRestoreBackup(file: string, masterPassword: string): Promise<void>
  serversUpsert(input: ServerUpsertInput): Promise<{ servers: ServerView[]; id: string }>
  serversDelete(id: string): Promise<{ servers: ServerView[] }>
  serversGetSecret(id: string): Promise<{ password: string; elevatePassword: string | null }>
  settingsUpdate(patch: Partial<VaultSettings>): Promise<VaultSettings>
  sessionOpen(serverId: string): Promise<{ sessionId: string }>
  sessionClose(sessionId: string): Promise<void>
  sessionTest(serverId: string): Promise<TestConnectionResult>
  hostkeyReplacePin(input: {
    serverId: string
    receivedFingerprint: string
    confirmation: string
  }): Promise<void>
  onSessionPort(cb: (sessionId: string, port: SessionPort) => void): () => void
  onLocked(cb: () => void): () => void
}

/**
 * Maps Bridge methods to the IPC channel names used by ipcMain.handle and
 * ipcRenderer.invoke. Shared so the two sides can never drift.
 */
export const BRIDGE_CHANNELS = {
  vaultStatus: 'vault:status',
  vaultCreate: 'vault:create',
  vaultUnlock: 'vault:unlock',
  vaultLock: 'vault:lock',
  vaultActivity: 'vault:activity',
  vaultBackups: 'vault:backups',
  vaultRestoreBackup: 'vault:restore-backup',
  serversUpsert: 'servers:upsert',
  serversDelete: 'servers:delete',
  serversGetSecret: 'servers:get-secret',
  settingsUpdate: 'settings:update',
  sessionOpen: 'sessions:open',
  sessionClose: 'sessions:close',
  sessionTest: 'sessions:test',
  hostkeyReplacePin: 'hostkeys:replace-pin'
} as const satisfies Record<string, string>

export const SESSION_PORT_CHANNEL = 'session-port'
export const VAULT_LOCKED_CHANNEL = 'vault:locked'

/** Error codes crossing IPC as `<code>` or `<code>:<detail>` in Error.message. */
export type BridgeErrorCode =
  | 'unlock-failed'
  | 'vault-exists'
  | 'vault-locked'
  | 'not-found'
  | 'invalid-input'
  | 'hostkey-refused'
  | 'replace-confirmation-mismatch'
  | 'connect-failed'
  | 'internal'
