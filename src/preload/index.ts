import { contextBridge, ipcRenderer } from 'electron'
import {
  BRIDGE_CHANNELS,
  SESSION_PORT_CHANNEL,
  VAULT_LOCKED_CHANNEL
} from '@shared/types'
import type { Bridge, MainPortMessage, SessionPort } from '@shared/types'

/**
 * The only bridge into the renderer: a narrow, typed API. No ipcRenderer
 * object, no channels beyond these, no Node.
 */

interface PortLike {
  postMessage(msg: unknown): void
  close(): void
  onmessage: ((ev: { data: unknown }) => void) | null
}

const api: Bridge = {
  vaultStatus: () => ipcRenderer.invoke(BRIDGE_CHANNELS.vaultStatus),
  vaultCreate: (masterPassword) => ipcRenderer.invoke(BRIDGE_CHANNELS.vaultCreate, masterPassword),
  vaultUnlock: (masterPassword) => ipcRenderer.invoke(BRIDGE_CHANNELS.vaultUnlock, masterPassword),
  vaultLock: () => ipcRenderer.invoke(BRIDGE_CHANNELS.vaultLock),
  vaultActivity: () => ipcRenderer.invoke(BRIDGE_CHANNELS.vaultActivity),
  vaultBackups: () => ipcRenderer.invoke(BRIDGE_CHANNELS.vaultBackups),
  vaultRestoreBackup: (file, masterPassword) =>
    ipcRenderer.invoke(BRIDGE_CHANNELS.vaultRestoreBackup, { file, password: masterPassword }),
  vaultExportEncrypted: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.vaultExportEncrypted, input),
  vaultExportCsv: () => ipcRenderer.invoke(BRIDGE_CHANNELS.vaultExportCsv),
  vaultImportPick: () => ipcRenderer.invoke(BRIDGE_CHANNELS.vaultImportPick),
  vaultImportApply: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.vaultImportApply, input),
  serversUpsert: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.serversUpsert, input),
  serversDelete: (id) => ipcRenderer.invoke(BRIDGE_CHANNELS.serversDelete, id),
  serversGetSecret: (id) => ipcRenderer.invoke(BRIDGE_CHANNELS.serversGetSecret, id),
  settingsUpdate: (patch) => ipcRenderer.invoke(BRIDGE_CHANNELS.settingsUpdate, patch),
  sessionOpen: (serverId) => ipcRenderer.invoke(BRIDGE_CHANNELS.sessionOpen, serverId),
  sessionClose: (sessionId) => ipcRenderer.invoke(BRIDGE_CHANNELS.sessionClose, sessionId),
  sessionTest: (serverId) => ipcRenderer.invoke(BRIDGE_CHANNELS.sessionTest, serverId),
  hostkeyReplacePin: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.hostkeyReplacePin, input),

  onSessionPort: (cb) => {
    const handler = (event: unknown, meta: { sessionId: string }) => {
      const port = (event as { ports: PortLike[] }).ports[0]
      if (!port) return
      const wrapped: SessionPort = {
        send: (msg) => {
          try {
            port.postMessage(msg)
          } catch {
            /* port closed */
          }
        },
        onMessage: (cb2) => {
          port.onmessage = (ev) => cb2(ev.data as MainPortMessage)
        },
        close: () => {
          try {
            port.close()
          } catch {
            /* port closed */
          }
        }
      }
      cb(meta.sessionId, wrapped)
    }
    ipcRenderer.on(SESSION_PORT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(SESSION_PORT_CHANNEL, handler)
  },

  onLocked: (cb) => {
    const handler = () => cb()
    ipcRenderer.on(VAULT_LOCKED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(VAULT_LOCKED_CHANNEL, handler)
  }
}

contextBridge.exposeInMainWorld('sshvault', api)
