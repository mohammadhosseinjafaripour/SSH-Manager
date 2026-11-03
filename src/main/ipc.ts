import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
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
  looksLikeEncryptedExport,
  openEncryptedExport,
  serversFromCsv,
  serversToCsv
} from './vault/transfer'
import { ConnectionManager, testConnection } from './ssh/manager'

/** Holds the file chosen in the import picker until it is applied or re-picked. */
let pendingImport: { raw: string; format: 'encrypted' | 'csv' } | null = null

function toView(entry: ServerEntry): ServerView {
  return {
    id: entry.id,
    name: entry.name,
    host: entry.host,
    port: entry.port,
    username: entry.username,
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
    const raw = readFileSync(file, 'utf8')
    const format: 'encrypted' | 'csv' = looksLikeEncryptedExport(raw) ? 'encrypted' : 'csv'
    pendingImport = { raw, format }
    return { ok: true, format, fileName: basename(file) }
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
        const summary = applyImport(
          store,
          { servers: payload.servers, pinnedHostKeys: payload.includePinnedHostKeys ? payload.pinnedHostKeys : [] },
          input.mode
        )
        return { servers: views(store), summary }
      }
      const csv = serversFromCsv(raw)
      if (csv.inputs.length === 0 && csv.errors.length > 0) {
        throw new Error(`invalid-input:${csv.errors[0]}`)
      }
      pendingImport = null
      const summary = applyImport(
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
      return { servers: views(store), summary, warnings: csv.errors }
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
