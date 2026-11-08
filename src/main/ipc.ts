import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { BRIDGE_CHANNELS } from '@shared/types'
import type {
  ServerEntry,
  ServerUpsertInput,
  ServerView,
  VaultSettings
} from '@shared/types'
import type { VaultStore } from './vault/store'
import {
  NotFoundError,
  UnlockFailedError,
  VaultExistsError,
  VaultLockedError
} from './vault/store'
import {
  applyImport,
  exportEncrypted,
  loadImportFile,
  openEncryptedExport,
  serversFromCsv,
  serversToCsv
} from './vault/transfer'
import { ConnectionManager, healthCheckAll, testConnection } from './ssh/manager'
import { looksLikePrivateKey, hasCredentials } from './ssh/auth'
import { copySecretWithAutoClear } from './security'
import { openRemoteInEditor } from './ssh/editor'
import { parsePuttyRegOutput } from '@shared/putty'
import { parseSshConfig } from '@shared/sshconfig'
import { resolveProxyJump } from '@shared/jump'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { suggest } from '@shared/completion'
import {
  chmodRemote,
  closeSftp,
  downloadRemote,
  existingNames,
  listDir,
  mkdir as sftpMkdir,
  openSftp,
  removeRemote,
  renameRemote,
  uploadPaths,
  type SftpHandle
} from './ssh/sftp'
import { TRANSFER_PROGRESS_CHANNEL } from '@shared/types'
import type { ConflictPolicy, RemoteEntry, TransferProgress } from '@shared/types'

/** Live SFTP connections, keyed by the connection id handed to the renderer. */
const sftpHandles = new Map<string, SftpHandle>()
/** Set to request cancellation of the in-flight transfer, if any. */
const transferSignals = new Map<string, { cancelled: boolean }>()

/** Holds the file chosen in the import picker until it is applied or re-picked. */
let pendingImport: { raw: string; format: 'encrypted' | 'csv' } | null = null

function toView(entry: ServerEntry): ServerView {
  return {
    id: entry.id,
    name: entry.name,
    host: entry.host,
    port: entry.port,
    username: entry.username,
    authMethod: entry.authMethod ?? 'password',
    jumpHostId: entry.jumpHostId ?? null,
    hasKey: !!entry.keyAuth?.privateKey,
    hasKeyPassphrase: !!entry.keyAuth?.passphrase,
    tags: entry.tags,
    notes: entry.notes,
    elevate: {
      enabled: entry.elevate.enabled,
      preset: entry.elevate.preset,
      customCommand: entry.elevate.customCommand,
      passwordMode: entry.elevate.passwordMode,
      hasCustomPassword: entry.elevate.passwordMode === 'custom' && !!entry.elevate.customPassword
    },
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastConnectedAt: entry.lastConnectedAt
  }
}

function views(store: VaultStore): ServerView[] {
  return store.getPayload().servers.map(toView)
}

/**
 * IPC replies must survive the structured clone across to the renderer; a JSON
 * round-trip guarantees nothing exotic can ever sneak into a response and
 * surface as "An object could not be cloned".
 */
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Known error classes cross IPC as their code; anything else is internal. */
function toIpcError(err: unknown): Error {
  if (
    err instanceof UnlockFailedError ||
    err instanceof VaultExistsError ||
    err instanceof VaultLockedError ||
    err instanceof NotFoundError
  ) {
    return err
  }
  const message = err instanceof Error ? err.message : String(err)
  if (message.startsWith('invalid-input')) return new Error(message)
  return new Error(`internal:${message}`)
}

export function registerIpc(store: VaultStore, manager: ConnectionManager): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (key: keyof typeof BRIDGE_CHANNELS, fn: (arg: any, event: Electron.IpcMainInvokeEvent) => unknown) => {
    ipcMain.handle(BRIDGE_CHANNELS[key], async (event, arg: unknown) => {
      try {
        return await fn(arg, event)
      } catch (err) {
        throw toIpcError(err)
      }
    })
  }

  handle('vaultStatus', () => ({ exists: store.exists() }))

  handle('vaultCreate', (pw: string) => {
    return store.create(pw).then(() => ({
      settings: store.getPayload().settings,
      servers: store.getPayload().servers.map(toView)
    }))
  })

  handle('vaultUnlock', (pw: string) => {
    return store.unlock(pw).then((payload) => ({
      settings: payload.settings,
      servers: payload.servers.map(toView)
    }))
  })

  handle('vaultLock', () => {
    store.lock()
  })

  handle('vaultActivity', () => store.touchActivity())

  handle('vaultBackups', () => store.listBackups())

  handle('vaultRestoreBackup', (input: { file: string; password: string }) =>
    store.restoreBackup(input.file, input.password)
  )

  // ---- SFTP -----------------------------------------------------------------

  const requireHandle = (connectionId: string): SftpHandle => {
    const handle = sftpHandles.get(connectionId)
    if (!handle) throw new Error('sftp-not-connected:open the Files panel again')
    return handle
  }

  /** Streams progress to the renderer without blocking the transfer. */
  const emitProgress = (event: Electron.IpcMainInvokeEvent) => (p: TransferProgress) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send(TRANSFER_PROGRESS_CHANNEL, p)
    }
  }

  handle('sftpOpen', async (input: { serverId: string }) => {
    const handle = await openSftp(input.serverId, store)
    sftpHandles.set(handle.id, handle)
    // `$HOME` is the natural starting point; fall back to / if realpath fails.
    const homeDir = await new Promise<string>((resolve) => {
      handle.sftp.realpath('.', (err, resolved) => resolve(err || !resolved ? '/' : resolved))
    })
    return { connectionId: handle.id, homeDir }
  })

  handle('sftpClose', (input: { connectionId: string }) => {
    const handle = sftpHandles.get(input.connectionId)
    if (handle) {
      closeSftp(handle)
      sftpHandles.delete(input.connectionId)
    }
  })

  handle('sftpCancel', (input: { connectionId: string }) => {
    const signal = transferSignals.get(input.connectionId)
    if (signal) signal.cancelled = true
  })

  handle(
    'sftpCheckConflicts',
    async (input: { connectionId: string; remoteDir: string; names: string[] }) => ({
      existing: await existingNames(requireHandle(input.connectionId), input.remoteDir, input.names)
    })
  )

  handle('sftpRename', (input: { connectionId: string; from: string; to: string }) =>
    renameRemote(requireHandle(input.connectionId), input.from, input.to)
  )

  handle('sftpChmod', (input: { connectionId: string; target: string; mode: number }) =>
    chmodRemote(requireHandle(input.connectionId), input.target, input.mode)
  )

  handle('pickKeyFile', async (_arg: unknown, event: Electron.IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const picked = await dialog.showOpenDialog(win, {
      title: 'Load private key',
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: 'SSH private key', extensions: ['pem', 'key', 'ppk', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return { ok: false }
    const contents = readFileSync(file, 'utf8')
    if (!looksLikePrivateKey(contents)) {
      throw new Error(
        'invalid-input:That file does not look like a private key (.ppk files must be converted with puttygen first)'
      )
    }
    return { ok: true, contents, fileName: basename(file) }
  })

  /**
   * Drag & drop onto the terminal: upload to a server with no Files panel open.
   * Opens its own short-lived SFTP connection, uploads, then tears it down.
   */
  handle(
    'sftpUploadToServer',
    async (
      input: {
        serverId: string
        remoteDir?: string
        localPaths: string[]
        conflictPolicy?: ConflictPolicy
      },
      event: Electron.IpcMainInvokeEvent
    ) => {
      if (!input.localPaths?.length) throw new Error('invalid-input:nothing to upload')
      const handle = await openSftp(input.serverId, store)
      try {
        const remoteDir =
          input.remoteDir ??
          (await new Promise<string>((resolve) => {
            handle.sftp.realpath('.', (err, resolved) => resolve(err || !resolved ? '/' : resolved))
          }))
        const signal = { cancelled: false }
        transferSignals.set(handle.id, signal)
        try {
          await uploadPaths(
            handle,
            input.localPaths,
            remoteDir,
            emitProgress(event),
            signal,
            input.conflictPolicy ?? 'rename'
          )
        } finally {
          transferSignals.delete(handle.id)
        }
        return { uploaded: input.localPaths.length, remoteDir }
      } finally {
        closeSftp(handle)
      }
    }
  )


  /**
   * Inline terminal completion. Local only: history observed on the session plus
   * a built-in catalog, with remote paths listed over a short-lived SFTP
   * connection when the command takes a path argument.
   */
  handle(
    'complete',
    async (input: {
      serverId: string
      line: string
      pathDir?: string
      pathKind?: 'files' | 'dirs'
    }) => {
      const session = manager.findByServer(input.serverId)
      const history = session?.getHistory() ?? []

      let files: string[] | undefined
      let dirs: string[] | undefined
      if (input.pathDir) {
        try {
          const sftp = await openSftp(input.serverId, store)
          try {
            const entries = await listDir(sftp, input.pathDir)
            const onlyDirs = entries.filter((e) => e.kind === 'dir').map((e) => e.name)
            const all = entries.map((e) => e.name)
            if (input.pathKind === 'dirs') {
              dirs = onlyDirs
            } else {
              files = all
              dirs = onlyDirs
            }
          } finally {
            closeSftp(sftp)
          }
        } catch {
          // Path listing is best-effort: a failed SFTP round trip must never
          // break typing. Fall back to catalog + history only.
        }
      }

      // Return the full ranked list so the UI can let the user pick with
      // Up/Down; the renderer shows the first one as the ghost by default.
      return suggest({ line: input.line, history, files, dirs, max: 8 })
    }
  )


  // ---- copy password (auto-clearing clipboard) ----
  handle('copySecret' as keyof typeof BRIDGE_CHANNELS, (input: { serverId: string }) => {
    const server = store.getServer(input.serverId)
    if (!server.password) throw new Error('invalid-input:no password stored — use a key or set one')
    void copySecretWithAutoClear(server.password)
    return { clearedAfter: 30 }
  })

  // ---- import scans ----
  handle('importScanPutty', () => {
    if (process.platform !== 'win32') return { sessions: [] }
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\SimonTatham\\PuTTY\\Sessions', '/s'],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }
      )
      return { sessions: parsePuttyRegOutput(out) }
    } catch {
      return { sessions: [] } // no PuTTY installed or no sessions
    }
  })

  handle('importScanSshConfig', () => {
    const configPath = join(homedir(), '.ssh', 'config')
    try {
      const text = readFileSync(configPath, 'utf8')
      const entries = parseSshConfig(text)
      return {
        path: configPath,
        entries: entries.map((e) => {
          let hasKey = false
          if (e.identityFile) {
            try {
              hasKey = looksLikePrivateKey(readFileSync(e.identityFile, 'utf8'))
            } catch {
              hasKey = false
            }
          }
          return { ...e, hasKey, identityPath: e.identityFile }
        })
      }
    } catch {
      return { path: configPath, entries: [] }
    }
  })

  handle(
    'importBulk',
    async (input: { candidates: Array<Record<string, unknown> & { name: string; host: string; port: number; username: string }> }) => {
      const entries: ServerEntry[] = []
      const aliasToId = new Map<string, string>()
      for (const c of input.candidates) {
        const id = randomUUID()
        if ('alias' in c && typeof c.alias === 'string') aliasToId.set(c.alias.toLowerCase(), id)
        if ('host' in c) aliasToId.set(String(c.host).toLowerCase(), id)
        const authMethod = c.authMethod === 'key' ? ('key' as const) : ('password' as const)
        entries.push({
          id,
          name: String(c.name),
          host: String(c.host),
          port: Number(c.port) || 22,
          username: String(c.username),
          password: typeof c.password === 'string' ? c.password : '',
          authMethod,
          keyAuth:
            authMethod === 'key' && typeof c.privateKey === 'string' && c.privateKey
              ? { privateKey: c.privateKey, passphrase: '' }
              : null,
          jumpHostId: null,
          tags: Array.isArray(c.tags) ? (c.tags as string[]).map(String) : [],
          notes: typeof c.notes === 'string' ? c.notes : '',
          elevate: { enabled: false, preset: 'sudo -s', customCommand: '', passwordMode: 'same', customPassword: '' },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastConnectedAt: null
        })
      }
      // Resolve proxyJump aliases to ids (second pass so ids exist).
      for (const e of entries) {
        const raw = (e as unknown as { proxyJumpAlias?: string }).proxyJumpAlias
        if (raw) {
          const hopId = aliasToId.get(raw.toLowerCase()) ?? resolveProxyJump(raw, entries.map((x) => ({ alias: undefined, host: x.host, id: x.id })))
          e.jumpHostId = hopId
        }
      }
      const valid = entries.filter((e) => hasCredentials(e))
      return applyImport(store, { servers: valid }, 'merge')
    }
  )

  // ---- edit remote file ----
  handle('sftpEdit', async (input: { connectionId: string | null; serverId: string; remotePath: string }) => {
    const server = store.getServer(input.serverId)
    void handle // panel may be closed; editor opens its own SFTP connection
    return openRemoteInEditor({ server, remotePath: input.remotePath })
  })

  handle('healthCheck', (input: { serverIds: string[] }) => {
    const servers = input.serverIds
      .map((id) => {
        try {
          return store.getServer(id)
        } catch {
          return null
        }
      })
      .filter((s): s is NonNullable<typeof s> => !!s)
    return healthCheckAll(servers, store)
  })

  handle('sftpList', (input: { connectionId: string; dir: string }) =>
    listDir(requireHandle(input.connectionId), input.dir)
  )

  handle('sftpMkdir', (input: { connectionId: string; dir: string }) =>
    sftpMkdir(requireHandle(input.connectionId), input.dir)
  )

  handle('sftpDelete', (input: { connectionId: string; target: string; kind: RemoteEntry['kind'] }) =>
    removeRemote(requireHandle(input.connectionId), input.target, input.kind)
  )

  handle(
    'sftpUpload',
    async (
      input: {
        connectionId: string
        remoteDir: string
        localPaths: string[]
        conflictPolicy?: ConflictPolicy
      },
      event: Electron.IpcMainInvokeEvent
    ) => {
      const handle = requireHandle(input.connectionId)
      const signal = { cancelled: false }
      transferSignals.set(input.connectionId, signal)
      try {
        await uploadPaths(
          handle,
          input.localPaths,
          input.remoteDir,
          emitProgress(event),
          signal,
          input.conflictPolicy ?? 'overwrite'
        )
      } finally {
        transferSignals.delete(input.connectionId)
      }
      return { uploaded: input.localPaths.length }
    }
  )

  handle(
    'sftpPickAndUpload',
    async (
      input: { connectionId: string; remoteDir: string; conflictPolicy?: ConflictPolicy },
      event: Electron.IpcMainInvokeEvent
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      const picked = await dialog.showOpenDialog(win, {
        title: 'Upload to server',
        properties: ['openFile', 'openDirectory', 'multiSelections']
      })
      if (picked.canceled || picked.filePaths.length === 0) return { ok: false, uploaded: 0 }
      const handle = requireHandle(input.connectionId)
      const signal = { cancelled: false }
      transferSignals.set(input.connectionId, signal)
      try {
        await uploadPaths(
          handle,
          picked.filePaths,
          input.remoteDir,
          emitProgress(event),
          signal,
          input.conflictPolicy ?? 'overwrite'
        )
      } finally {
        transferSignals.delete(input.connectionId)
      }
      return { ok: true, uploaded: picked.filePaths.length }
    }
  )

  handle(
    'sftpDownload',
    async (
      input: { connectionId: string; remotePaths: string[]; kinds: RemoteEntry['kind'][] },
      event: Electron.IpcMainInvokeEvent
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      const picked = await dialog.showOpenDialog(win, {
        title: 'Choose where to save',
        properties: ['openDirectory', 'createDirectory']
      })
      const localDir = picked.filePaths[0]
      if (picked.canceled || !localDir) return { ok: false, downloaded: 0 }

      const handle = requireHandle(input.connectionId)
      const signal = { cancelled: false }
      transferSignals.set(input.connectionId, signal)
      try {
        for (let i = 0; i < input.remotePaths.length; i++) {
          await downloadRemote(
            handle,
            input.remotePaths[i],
            localDir,
            input.kinds[i] ?? 'file',
            emitProgress(event),
            signal
          )
        }
      } finally {
        transferSignals.delete(input.connectionId)
      }
      return { ok: true, downloaded: input.remotePaths.length, localDir }
    }
  )

  // ---- import / export ------------------------------------------------------

  handle(
    'vaultExportEncrypted',
    async (
      input: { exportPassword: string; includePinnedHostKeys: boolean },
      event: Electron.IpcMainInvokeEvent
    ) => {
      const payload = store.getPayload()
      const raw = await exportEncrypted(
        payload.servers,
        payload.pinnedHostKeys,
        input.includePinnedHostKeys,
        input.exportPassword
      )
      const win = BrowserWindow.fromWebContents(event.sender)!
      const stamp = new Date().toISOString().slice(0, 10)
      const result = await dialog.showSaveDialog(win, {
        title: 'Export encrypted vault',
        defaultPath: `ssh-vault-export-${stamp}.sshvault`,
        filters: [{ name: 'SSH Vault export', extensions: ['sshvault'] }]
      })
      if (result.canceled || !result.filePath) return { ok: false }
      writeFileSync(result.filePath, raw, 'utf8')
      return { ok: true, path: result.filePath }
    }
  )

  handle('vaultExportCsv', async (_arg: unknown, event: Electron.IpcMainInvokeEvent) => {
    const payload = store.getPayload()
    const raw = serversToCsv(payload.servers)
    const win = BrowserWindow.fromWebContents(event.sender)!
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(win, {
      title: 'Export servers as CSV (plaintext passwords!)',
      defaultPath: `ssh-vault-servers-${stamp}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false }
    writeFileSync(result.filePath, raw, 'utf8')
    return { ok: true, path: result.filePath }
  })

  handle('vaultImportPick', async (_arg: unknown, event: Electron.IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const result = await dialog.showOpenDialog(win, {
      title: 'Import servers',
      properties: ['openFile'],
      filters: [
        { name: 'SSH Vault export or CSV', extensions: ['sshvault', 'csv', 'txt', 'json'] }
      ]
    })
    const file = result.filePaths[0]
    if (result.canceled || !file) return { ok: false }
    const { raw, format, fileName } = loadImportFile(file)
    pendingImport = { raw, format }
    return { ok: true, format, fileName }
  })

  // Drag & drop twin of the picker: the renderer hands over the absolute path
  // it resolved from the dropped File; the file still never crosses IPC.
  handle('vaultImportFile', (input: { path: string }) => {
    if (!input || typeof input.path !== 'string' || !input.path.trim()) {
      throw new Error('invalid-input:no file path in drop')
    }
    const { raw, format, fileName } = loadImportFile(input.path)
    pendingImport = { raw, format }
    return { ok: true, format, fileName }
  })

  handle(
    'vaultImportApply',
    async (input: { exportPassword?: string; mode: 'merge' | 'replace' }) => {
      if (!pendingImport) throw new NotFoundError()
      const { raw, format } = pendingImport
      if (format === 'encrypted') {
        const payload = await openEncryptedExport(raw, input.exportPassword ?? '')
        // Success — consume the pending pick.
        pendingImport = null
        const summary = await applyImport(
          store,
          { servers: payload.servers, pinnedHostKeys: payload.includePinnedHostKeys ? payload.pinnedHostKeys : [] },
          input.mode
        )
        return jsonClone({ servers: views(store), summary })
      }
      const csv = serversFromCsv(raw)
      if (csv.inputs.length === 0 && csv.errors.length > 0) {
        throw new Error(`invalid-input:${csv.errors[0]}`)
      }
      pendingImport = null
      const summary = await applyImport(
        store,
        {
          servers: csv.inputs.map((i) => ({
            id: crypto.randomUUID(),
            name: i.name,
            host: i.host,
            port: i.port,
            username: i.username,
            password: i.password ?? '',
            authMethod: 'password' as const,
            keyAuth: null,
            jumpHostId: null,
            tags: i.tags,
            notes: i.notes,
            elevate: {
              enabled: i.elevate.enabled,
              preset: i.elevate.preset,
              customCommand: i.elevate.customCommand,
              passwordMode: 'same' as const,
              customPassword: ''
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastConnectedAt: null
          }))
        },
        input.mode
      )
      return jsonClone({ servers: views(store), summary, warnings: csv.errors })
    }
  )

  handle('serversUpsert', (input: ServerUpsertInput) => {
    if (!input || typeof input !== 'object') throw new Error('invalid-input:missing server')
    if (!input.name?.trim() || !input.host?.trim() || !input.username?.trim()) {
      throw new Error('invalid-input:name, host and username are required')
    }
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      throw new Error('invalid-input:invalid port')
    }
    return store.upsertServer(input).then((entry) => ({ servers: views(store), id: entry.id }))
  })

  handle('serversDelete', (id: string) =>
    store.deleteServer(id).then(() => ({ servers: views(store) }))
  )

  handle('serversGetSecret', (id: string) => {
    const entry = store.getServer(id)
    return {
      password: entry.password,
      elevatePassword:
        entry.elevate.passwordMode === 'custom' ? entry.elevate.customPassword : null
    }
  })

  handle('settingsUpdate', (patch: Partial<VaultSettings>) => store.updateSettings(patch))

  handle('sessionOpen', (serverId: string) => manager.open(serverId))

  handle('sessionClose', (sessionId: string) => manager.close(sessionId))

  handle('sessionTest', (serverId: string) => testConnection(store.getServer(serverId), store))

  handle(
    'hostkeyReplacePin',
    (input: { serverId: string; receivedFingerprint: string; confirmation: string }) => {
      // Typed confirmation = exact server name: proves deliberate action.
      const server = store.getServer(input.serverId)
      if (input.confirmation.trim() !== server.name) {
        throw new Error('replace-confirmation-mismatch')
      }
      return store.replaceHostKeyPin(server.host, server.port, input.receivedFingerprint)
    }
  )
}
