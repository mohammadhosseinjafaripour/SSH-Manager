import { ipcMain } from 'electron'
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
import { ConnectionManager, testConnection } from './ssh/manager'

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
  const handle = (key: keyof typeof BRIDGE_CHANNELS, fn: (arg: any) => unknown) => {
    ipcMain.handle(BRIDGE_CHANNELS[key], async (_event, arg: unknown) => {
      try {
        return await fn(arg)
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
