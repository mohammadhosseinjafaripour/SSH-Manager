/**
 * "Edit remote file in your local editor": download to a temp file, open it in
 * the default application for its type, watch for saves, and push the file
 * back automatically (with a short debounce so editors that write in bursts
 * don't trigger partial uploads).
 *
 * Each edit keeps its own short-lived SFTP connection for pushes, so edits
 * survive closing the Files panel. Temp files live under
 * %TEMP%\ssh-vault-editor\<serverId>\ — they contain decrypted remote content,
 * which is inherent to local editing and worth knowing when wiping machines.
 */
import { createReadStream, promises as fsp, watch, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { shell, type BrowserWindow } from 'electron'
import type { ServerEntry } from '@shared/types'
import type { VaultStore } from '../vault/store'
import { closeSftp, openSftp } from './sftp'

const QUIET_MS = 1200

interface ActiveEdit {
  serverId: string
  remotePath: string
  localPath: string
  watcher: FSWatcher
  timer: ReturnType<typeof setTimeout> | null
  uploading: boolean
  pending: boolean
}

export interface EditorService {
  open(input: { server: ServerEntry; remotePath: string }): Promise<{ localPath: string }>
  /** Stops all watchers and pending pushes (app shutdown). */
  stopAll(): void
}

let serviceInstance: EditorService | null = null

export function initEditorService(store: VaultStore, getWindow: () => BrowserWindow | null): void {
  serviceInstance = createEditorService(store, getWindow)
}

export function openRemoteInEditor(input: { server: ServerEntry; remotePath: string }): Promise<{ localPath: string }> {
  if (!serviceInstance) throw new Error('editor-not-initialised')
  return serviceInstance.open(input)
}

export function stopAllEdits(): void {
  serviceInstance?.stopAll()
}

export function createEditorService(
  store: VaultStore,
  getWindow: () => BrowserWindow | null
): EditorService {
  const activeEdits = new Map<string, ActiveEdit>()

  const notify = (msg: string) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('editor:synced', { message: msg })
  }

  const pushEdit = async (edit: ActiveEdit): Promise<void> => {
    if (edit.uploading) {
      edit.pending = true
      return
    }
    edit.uploading = true
    try {
      await fsp.stat(edit.localPath)
      await withFreshSftp(edit.serverId, async (sftp) => {
        await new Promise<void>((resolve, reject) => {
          const read = createReadStream(edit.localPath)
          const write = sftp.createWriteStream(edit.remotePath)
          write.on('close', () => resolve())
          write.on('error', (e: Error) => reject(new Error(e.message)))
          read.on('error', (e: Error) => reject(new Error(e.message)))
          read.pipe(write)
        })
      })
      notify(`Saved ${basename(edit.remotePath)} — uploaded to server`)
    } catch (err) {
      notify(
        `Could not upload ${basename(edit.remotePath)}: ${
          err instanceof Error ? err.message : 'unknown error'
        } — the temp copy is at ${edit.localPath}`
      )
    } finally {
      edit.uploading = false
      if (edit.pending) {
        edit.pending = false
        void pushEdit(edit)
      }
    }
  }

  const schedulePush = (key: string) => {
    const edit = activeEdits.get(key)
    if (!edit) return
    if (edit.timer) clearTimeout(edit.timer)
    edit.timer = setTimeout(() => void pushEdit(edit), QUIET_MS)
  }

  return {
    async open({ server, remotePath }) {
      const serverId = server.id
      const editDir = join(tmpdir(), 'ssh-vault-editor', serverId)
      await fsp.mkdir(editDir, { recursive: true })
      const localPath = join(editDir, basename(remotePath))

      // Fresh copy every time: the remote file is the source of truth.
      await withFreshSftp(serverId, async (sftp) => {
        await new Promise<void>((resolve, reject) => {
          sftp.fastGet(remotePath, localPath, (err) =>
            err ? reject(new Error(err.message)) : resolve()
          )
        })
      })

      const key = localPath
      const prior = activeEdits.get(key)
      if (prior) prior.watcher.close()

      const watcher = watch(localPath, () => schedulePush(key))
      const edit: ActiveEdit = {
        serverId,
        remotePath,
        localPath,
        watcher,
        timer: null,
        uploading: false,
        pending: false
      }
      activeEdits.set(key, edit)

      await shell.openPath(localPath)
      notify(`Opened ${basename(remotePath)} — saves upload automatically`)
      return { localPath }
    },

    stopAll() {
      for (const [, edit] of activeEdits) {
        edit.watcher.close()
        if (edit.timer) clearTimeout(edit.timer)
      }
      activeEdits.clear()
    }
  }

  async function withFreshSftp<T>(serverId: string, fn: (sftp: import('ssh2').SFTPWrapper) => Promise<T>): Promise<T> {
    const server = store.getServer(serverId)
    const handle = await openSftp(server.id, store)
    try {
      return await fn(handle.sftp)
    } finally {
      closeSftp(handle)
    }
  }
}
