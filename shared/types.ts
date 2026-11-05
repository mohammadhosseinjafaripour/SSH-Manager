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

/**
 * SSH authentication. `password` and `agent` need nothing else; the key modes
 * carry a PEM/OpenSSH private key stored encrypted inside the vault.
 */
export type AuthMethod = 'password' | 'key' | 'agent'

export interface KeyAuth {
  /** Private key in PEM or OpenSSH format (secret — main process only). */
  privateKey: string
  /** Passphrase protecting the key, if any (secret). */
  passphrase: string
}

export interface ServerEntry {
  id: string
  name: string
  host: string
  port: number
  username: string
  /** Server login password (secret — main process only). Empty when using a key. */
  password: string
  authMethod: AuthMethod
  /** Present when authMethod is 'key'. */
  keyAuth: KeyAuth | null
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
  authMethod: AuthMethod
  /** True when a private key is stored (the key itself never leaves main). */
  hasKey: boolean
  /** True when the stored key is passphrase-protected. */
  hasKeyPassphrase: boolean
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
  /** Defaults to 'password' when omitted (CSV import, older callers). */
  authMethod?: AuthMethod
  /** Omit/undefined on edit = keep the existing stored password. */
  password?: string
  /** Omit/undefined on edit = keep the stored key. */
  privateKey?: string
  /** Omit/undefined on edit = keep the stored passphrase. */
  keyPassphrase?: string
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
  /** Send SSH keepalives so NAT/firewalls don't silently drop idle sessions. */
  keepAlive: boolean
  /** Show local inline command suggestions (ghost text) in the terminal. */
  autocomplete: boolean
  /** Check GitHub Releases for newer versions in the background. */
  autoUpdate: boolean
  /** Reconnect automatically when a session drops unexpectedly. */
  autoReconnect: boolean
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
  | 'reconnecting'
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
  | { type: 'notice'; kind: 'reconnected' }
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

// ---- file transfer (SFTP) -------------------------------------------------

export interface RemoteEntry {
  name: string
  path: string
  kind: 'file' | 'dir' | 'link'
  size: number
  modifiedAt: string
  permissions: number
  isSymlink: boolean
}

export interface TransferProgress {
  currentFile: string
  transferred: number
  total: number
  done: boolean
}

/** What to do when an upload targets a path that already exists. */
export type ConflictPolicy = 'overwrite' | 'rename' | 'skip'

export interface ConflictInfo {
  /** Remote paths that already exist and would be overwritten. */
  existing: string[]
}

export type HealthStatus = 'online' | 'auth-failed' | 'unreachable' | 'hostkey-changed'

export interface HealthResult {
  serverId: string
  status: HealthStatus
  /** Round-trip time for the handshake, when it succeeded. */
  latencyMs?: number
  detail?: string
}

export interface ServerTestResult {
  ok: boolean
  fingerprint?: string
  pinned: boolean
  message: string
}

/** Auto-update lifecycle, surfaced in Settings. */
export type UpdatePhase =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'up-to-date'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  /** Version being downloaded / ready to install. */
  version?: string
  /** Download progress 0-100. */
  percent?: number
  /** Human-readable failure, shown only in Settings. */
  error?: string
  /** ISO timestamp of the last completed check. */
  checkedAt?: string
}

/** A single inline completion offered by the terminal. */
export interface InlineSuggestion {
  insert: string
  kind: 'command' | 'flag' | 'path' | 'history' | 'sub'
  hint?: string
}

export interface ImportSummary {
  added: number
  skippedDuplicates: number
  replaced: boolean
}

/** Result of a transfer that writes a file: ok=false means the user cancelled the save dialog. */
export interface FilePickResult {
  ok: boolean
  path?: string
}

export interface ImportPickResult {
  ok: boolean
  /** Present when ok — which flow the chosen file needs. */
  format?: 'encrypted' | 'csv'
  /** Short display name of the picked file. */
  fileName?: string
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
  vaultExportEncrypted(input: {
    exportPassword: string
    includePinnedHostKeys: boolean
  }): Promise<FilePickResult>
  vaultExportCsv(): Promise<FilePickResult>
  vaultImportPick(): Promise<ImportPickResult>
  vaultImportApply(input: {
    exportPassword?: string
    mode: 'merge' | 'replace'
  }): Promise<{ servers: ServerView[]; summary: ImportSummary; warnings?: string[] }>
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

  // ---- SFTP ---------------------------------------------------------------
  sftpOpen(input: { serverId: string }): Promise<{ connectionId: string; homeDir: string }>
  sftpClose(input: { connectionId: string }): Promise<void>
  sftpList(input: { connectionId: string; dir: string }): Promise<RemoteEntry[]>
  sftpMkdir(input: { connectionId: string; dir: string }): Promise<void>
  sftpDelete(input: {
    connectionId: string
    target: string
    kind: RemoteEntry['kind']
  }): Promise<void>
  /** Uploads picked local paths into the remote directory. */
  sftpUpload(input: {
    connectionId: string
    remoteDir: string
    localPaths: string[]
    conflictPolicy?: ConflictPolicy
  }): Promise<{ uploaded: number }>
  /** Opens a native picker and uploads the chosen files/folders. */
  sftpPickAndUpload(input: {
    connectionId: string
    remoteDir: string
    conflictPolicy?: ConflictPolicy
  }): Promise<{ ok: boolean; uploaded: number }>
  /** Checks which remote paths already exist (before uploading). */
  sftpCheckConflicts(input: {
    connectionId: string
    remoteDir: string
    names: string[]
  }): Promise<ConflictInfo>
  sftpRename(input: {
    connectionId: string
    from: string
    to: string
  }): Promise<void>
  sftpChmod(input: {
    connectionId: string
    target: string
    /** Numeric mode, e.g. 0o644. */
    mode: number
  }): Promise<void>
  /** Downloads remote entries into a user-chosen local folder. */
  sftpDownload(input: {
    connectionId: string
    remotePaths: string[]
    kinds: RemoteEntry['kind'][]
  }): Promise<{ ok: boolean; downloaded: number; localDir?: string }>
  /** Paths of files/folders dropped onto the window (absolute). */
  resolveDroppedPaths(input: {
    files: Array<{ path?: string }>
  }): Promise<string[]>
  onTransferProgress(cb: (p: TransferProgress) => void): () => void
  /** Cancels the in-flight transfer on a connection, if any. */
  sftpCancel(input: { connectionId: string }): Promise<void>

  /**
   * Uploads dropped files straight to a server without needing the Files panel
   * open (used by drag & drop onto the terminal). Opens a short-lived SFTP
   * connection, uploads, then closes it.
   */
  sftpUploadToServer(input: {
    serverId: string
    remoteDir?: string
    localPaths: string[]
    conflictPolicy?: ConflictPolicy
  }): Promise<{ uploaded: number; remoteDir: string }>

  /**
   * Inline completion for the terminal. Runs entirely locally in the main
   * process: command history + a built-in catalog + remote paths. Nothing is
   * sent anywhere.
   */
  complete(input: {
    serverId: string
    line: string
    /** Ask for path candidates from this directory. */
    pathDir?: string
    /** 'files' or 'dirs' depending on the command being completed. */
    pathKind?: 'files' | 'dirs'
  }): Promise<InlineSuggestion[]>

  // ---- auto-update --------------------------------------------------------
  updateState(): Promise<UpdateState>
  /** Force a check now (works even when background checks are disabled). */
  updateCheck(): Promise<UpdateState>
  /** Quit and install a downloaded update. */
  updateInstall(): Promise<void>
  /** Open the GitHub releases page in the default browser. */
  openReleases(): Promise<void>
  onUpdateState(cb: (s: UpdateState) => void): () => void

  /** Tests every stored server in parallel; resolves per-server health. */
  healthCheck(input: { serverIds: string[] }): Promise<HealthResult[]>
  /** Opens a file picker and returns a local private key's text. */
  pickKeyFile(): Promise<{ ok: boolean; contents?: string; fileName?: string }>
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
  vaultExportEncrypted: 'vault:export-encrypted',
  vaultExportCsv: 'vault:export-csv',
  vaultImportPick: 'vault:import-pick',
  vaultImportApply: 'vault:import-apply',
  serversUpsert: 'servers:upsert',
  serversDelete: 'servers:delete',
  serversGetSecret: 'servers:get-secret',
  settingsUpdate: 'settings:update',
  sessionOpen: 'sessions:open',
  sessionClose: 'sessions:close',
  sessionTest: 'sessions:test',
  hostkeyReplacePin: 'hostkeys:replace-pin',
  sftpOpen: 'sftp:open',
  sftpClose: 'sftp:close',
  sftpList: 'sftp:list',
  sftpMkdir: 'sftp:mkdir',
  sftpDelete: 'sftp:delete',
  sftpUpload: 'sftp:upload',
  sftpPickAndUpload: 'sftp:pick-and-upload',
  sftpDownload: 'sftp:download',
  sftpCancel: 'sftp:cancel',
  sftpUploadToServer: 'sftp:upload-to-server',
  sftpCheckConflicts: 'sftp:check-conflicts',
  sftpRename: 'sftp:rename',
  sftpChmod: 'sftp:chmod',
  healthCheck: 'servers:health-check',
  updateState: 'update:state',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  openReleases: 'update:open-releases',
  complete: 'terminal:complete',
  pickKeyFile: 'app:pick-key-file',
  resolveDroppedPaths: 'app:resolve-dropped-paths'
} as const satisfies Record<string, string>

export const TRANSFER_PROGRESS_CHANNEL = 'transfer:progress'
export const UPDATE_STATE_CHANNEL = 'update:state'

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
