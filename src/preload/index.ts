import { contextBridge, ipcRenderer } from 'electron'
import {
  BRIDGE_CHANNELS,
  SESSION_PORT_CHANNEL,
  TRANSFER_PROGRESS_CHANNEL,
  UPDATE_STATE_CHANNEL,
  VAULT_LOCKED_CHANNEL
} from '@shared/types'
import type { Bridge, MainPortMessage, SessionPort, TransferProgress } from '@shared/types'

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

  sftpOpen: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.sftpOpen, input),
  sftpClose: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.sftpClose, input),
  sftpList: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.sftpList, input),
  sftpMkdir: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.sftpMkdir, input),
  sftpDelete: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.sftpDelete, input),
  sftpUpload: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.sftpUpload, input),
  sftpPickAndUpload: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.sftpPickAndUpload, input),
  sftpDownload: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.sftpDownload, input),
  sftpCancel: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.sftpCancel, input),
  sftpUploadToServer: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.sftpUploadToServer, input),
  sftpCheckConflicts: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.sftpCheckConflicts, input),
  sftpRename: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.sftpRename, input),
  sftpChmod: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.sftpChmod, input),
  healthCheck: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.healthCheck, input),
  complete: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.complete, input),
  pickKeyFile: () => ipcRenderer.invoke(BRIDGE_CHANNELS.pickKeyFile),
  resolveDroppedPaths: (input) => ipcRenderer.invoke(BRIDGE_CHANNELS.resolveDroppedPaths, input),

  updateState: () => ipcRenderer.invoke(BRIDGE_CHANNELS.updateState),
  updateCheck: () => ipcRenderer.invoke(BRIDGE_CHANNELS.updateCheck),
  updateInstall: () => ipcRenderer.invoke(BRIDGE_CHANNELS.updateInstall),
  openReleases: () => ipcRenderer.invoke(BRIDGE_CHANNELS.openReleases),
  copySecret: (input) => ipcRenderer.invoke('secrets:copy', input),
  importScanPutty: () => ipcRenderer.invoke('import:scan-putty'),
  importScanSshConfig: () => ipcRenderer.invoke('import:scan-sshconfig'),
  importBulk: (input) => ipcRenderer.invoke('import:bulk', input),
  sftpEdit: (input) => ipcRenderer.invoke('sftp:edit', input),
  onEditSynced: (cb) => {
    ipcRenderer.on('editor:synced', (_e, msg) => cb(msg))
    return () => undefined
  },
  onUpdateState: (cb) => {
    const handler = (_e: unknown, st: unknown) => cb(st as never)
    ipcRenderer.on(UPDATE_STATE_CHANNEL, handler)
    return () => ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, handler)
  },

  onTransferProgress: (cb) => {
    const handler = (_e: unknown, p: TransferProgress) => cb(p)
    ipcRenderer.on(TRANSFER_PROGRESS_CHANNEL, handler)
    return () => ipcRenderer.removeListener(TRANSFER_PROGRESS_CHANNEL, handler)
  },

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
