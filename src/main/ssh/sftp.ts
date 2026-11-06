import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs'
import { basename, join, posix as pathPosix } from 'node:path'
import { Client } from 'ssh2'
import type { SFTPWrapper, FileEntryWithStats } from 'ssh2'
import type { ConflictPolicy, RemoteEntry, TransferProgress } from '@shared/types'
import type { VaultStore } from '../vault/store'
import { checkPin, fingerprintOf } from '../hostkeys/verifier'
import { authConfig } from './auth'

/**
 * SFTP support: browse a remote directory, upload/download files and whole
 * folders, create directories and delete entries.
 *
 * A dedicated SSH connection is used per SFTP session (separate from the
 * terminal's shell connection) so a big upload never competes with the
 * interactive channel for window space.
 */

/** Directory walk limits: protects against runaway trees and enourmous listings. */
const MAX_DIR_ENTRIES = 20_000
const MAX_DEPTH = 24
/** Copy buffer, keeps memory flat for multi-GB files. */
const HIGH_WATER_MARK = 64 * 1024

export interface SftpHandle {
  id: string
  client: Client
  sftp: SFTPWrapper
}

function isDir(entry: FileEntryWithStats): boolean {
  return entry.attrs.isDirectory()
}

function toRemoteEntry(dir: string, entry: FileEntryWithStats): RemoteEntry {
  return {
    name: entry.filename,
    path: pathPosix.join(dir, entry.filename),
    kind: isDir(entry) ? 'dir' : entry.attrs.isSymbolicLink() ? 'link' : 'file',
    size: entry.attrs.size,
    modifiedAt: new Date(entry.attrs.mtime * 1000).toISOString(),
    permissions: entry.attrs.mode,
    isSymlink: entry.attrs.isSymbolicLink()
  }
}

/** Opens a separate SSH+SFTP connection for a server, verifying the host key. */
export function openSftp(serverId: string, store: VaultStore): Promise<SftpHandle> {
  const server = store.getServer(serverId)
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        /* gone */
      }
      reject(err)
    }

    client.on('error', (err: Error) => fail(err))
    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (err) {
          fail(err)
          return
        }
        if (settled) {
          sftp.end()
          return
        }
        settled = true
        resolve({ id: randomUUID(), client, sftp })
      })
    })

    client.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      ...authConfig(server),
      tryKeyboard: true,
      readyTimeout: 20_000,
      hostVerifier: (key: Buffer, cb?: (ok: boolean) => void) => {
        const decide = cb ?? (() => {})
        const fp = fingerprintOf(key)
        try {
          const check = checkPin(store.getPayload().pinnedHostKeys, server.host, server.port, fp)
          // Refuse a changed key; an unpinned host is allowed here because the
          // terminal flow already owns the TOFU dialog and the user has
          // necessarily connected (and been prompted) before using SFTP.
          decide(check.verdict !== 'changed')
        } catch {
          decide(false)
        }
      }
    })
  })
}

export function closeSftp(handle: SftpHandle): void {
  try {
    handle.sftp.end()
  } catch {
    /* gone */
  }
  try {
    handle.client.end()
  } catch {
    /* gone */
  }
}

/** Lists a directory (both `.` and `..` filtered out). */
export function listDir(handle: SftpHandle, dir: string): Promise<RemoteEntry[]> {
  return new Promise((resolve, reject) => {
    handle.sftp.readdir(dir, (err, list) => {
      if (err) {
        reject(new Error(`sftp-list-failed:${err.message}`))
        return
      }
      const entries = list
        .filter((e) => e.filename !== '.' && e.filename !== '..')
        .map((e) => toRemoteEntry(dir, e))
        .sort((a, b) => {
          // Directories first, then case-insensitive name order.
          if (a.kind === 'dir' && b.kind !== 'dir') return -1
          if (b.kind === 'dir' && a.kind !== 'dir') return 1
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        })
      resolve(entries)
    })
  })
}

/** Remote stat: null when the path does not exist. */
export function statRemote(handle: SftpHandle, path: string): Promise<{ size: number } | null> {
  return new Promise((resolve) => {
    handle.sftp.stat(path, (err, stats) => {
      if (err || !stats) resolve(null)
      else resolve({ size: stats.size })
    })
  })
}

/** Streams a local file to the remote path starting at `offset` (resume). */
export function uploadFromOffset(
  handle: SftpHandle,
  localPath: string,
  remotePath: string,
  offset: number,
  onProgress?: (transferred: number, total: number) => void,
  signal?: { cancelled: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const read = createReadStream(localPath, { start: offset })
    const write = handle.sftp.createWriteStream(remotePath, { flags: 'r+', start: offset })
    write.on('close', () => resolve())
    write.on('error', (e: Error) => reject(new Error('sftp-upload-failed:' + e.message)))
    read.on('error', (e: Error) => reject(new Error('sftp-upload-failed:' + e.message)))
    read.on('data', (chunk: Buffer | string) => {
      if (signal?.cancelled) {
        read.destroy()
        reject(new Error('cancelled'))
        return
      }
      onProgress?.(offset + Buffer.byteLength(chunk), 0)
    })
    read.pipe(write)
  })
}

/** Streams the remote file into the local path starting at `offset` (resume). */
export function downloadFromOffset(
  handle: SftpHandle,
  remotePath: string,
  localPath: string,
  offset: number,
  onProgress?: (transferred: number, total: number) => void,
  signal?: { cancelled: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const read = handle.sftp.createReadStream(remotePath, { start: offset })
    const write = createWriteStream(localPath, { flags: 'r+', start: offset })
    write.on('close', () => resolve())
    write.on('error', (e: Error) => reject(new Error('sftp-download-failed:' + e.message)))
    read.on('error', (e: Error) => reject(new Error('sftp-download-failed:' + e.message)))
    read.on('data', (chunk: Buffer | string) => {
      if (signal?.cancelled) {
        read.destroy()
        reject(new Error('cancelled'))
        return
      }
      onProgress?.(offset + Buffer.byteLength(chunk), 0)
    })
    read.pipe(write)
  })
}

export function mkdir(handle: SftpHandle, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    handle.sftp.mkdir(dir, (err) => (err ? reject(new Error(`sftp-mkdir-failed:${err.message}`)) : resolve()))
  })
}

/** Recursively deletes a file or directory. */
export async function removeRemote(handle: SftpHandle, target: string, kind: RemoteEntry['kind']): Promise<void> {
  if (kind !== 'dir') {
    await new Promise<void>((resolve, reject) => {
      handle.sftp.unlink(target, (err) =>
        err ? reject(new Error(`sftp-delete-failed:${err.message}`)) : resolve()
      )
    })
    return
  }
  const entries = await listDir(handle, target)
  for (const entry of entries) {
    await removeRemote(handle, entry.path, entry.kind)
  }
  await new Promise<void>((resolve, reject) => {
    handle.sftp.rmdir(target, (err) =>
      err ? reject(new Error(`sftp-delete-failed:${err.message}`)) : resolve()
    )
  })
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface UploadProgress {
  transferred: number
  total: number
  currentFile: string
}

/**
 * Uploads a whole local folder tree into `remoteDir/<folderName>`, creating
 * remote directories as needed. Files are streamed one at a time to bound
 * both memory and server load.
 */
export async function uploadTree(
  handle: SftpHandle,
  localRoot: string,
  remoteParent: string,
  onProgress?: (p: TransferProgress) => void,
  signal?: { cancelled: boolean },
  conflictPolicy: ConflictPolicy = 'overwrite'
): Promise<void> {
  const rootName = basename(localRoot)
  const remoteRoot = pathPosix.join(remoteParent, rootName)

  // Pre-walk to know the total byte count for an accurate progress bar.
  let total = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new Error('sftp-upload-failed:folder nesting too deep')
    const items = await fsp.readdir(dir, { withFileTypes: true })
    for (const item of items) {
      if (signal?.cancelled) throw new Error('cancelled')
      const full = join(dir, item.name)
      if (item.isDirectory()) await walk(full, depth + 1)
      else if (item.isFile()) total += (await fsp.stat(full)).size
    }
  }
  await walk(localRoot, 0)

  let sent = 0
  let current = ''

  const ensureDir = async (remote: string) => {
    await new Promise<void>((resolve) => {
      handle.sftp.mkdir(remote, () => resolve()) // ignore EEXIST
    })
  }

  const copyTree = async (localDir: string, remoteDir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    await ensureDir(remoteDir)
    const items = await fsp.readdir(localDir, { withFileTypes: true })
    for (const item of items) {
      if (signal?.cancelled) throw new Error('cancelled')
      const localPath = join(localDir, item.name)
      const remotePath = pathPosix.join(remoteDir, item.name)
      if (item.isDirectory()) {
        await copyTree(localPath, remotePath, depth + 1)
      } else if (item.isFile()) {
        current = item.name
        let fileName = item.name
        if (conflictPolicy !== 'overwrite') {
          const [clash] = await existingNames(handle, remoteDir, [fileName])
          if (clash) {
            if (conflictPolicy === 'skip') continue
            fileName = await freeName(handle, remoteDir, fileName)
          }
        }
        const remoteFile = pathPosix.join(remoteDir, fileName)
        await new Promise<void>((resolve, reject) => {
          const read = createReadStream(localPath, { highWaterMark: HIGH_WATER_MARK })
          const write = handle.sftp.createWriteStream(remoteFile)
          write.on('close', () => resolve())
          write.on('error', (e: Error) => reject(new Error(`sftp-upload-failed:${e.message}`)))
          read.on('error', (e: Error) => reject(new Error(`sftp-upload-failed:${e.message}`)))
          read.on('data', (chunk: Buffer | string) => {
            sent += Buffer.byteLength(chunk)
            onProgress?.({ currentFile: current, transferred: sent, total, done: false })
          })
          read.pipe(write)
        })
      }
    }
  }

  await copyTree(localRoot, remoteRoot, 0)
  onProgress?.({ currentFile: rootName, transferred: total, total, done: true })
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadRemote(
  handle: SftpHandle,
  remotePath: string,
  localDir: string,
  kind: RemoteEntry['kind'],
  onProgress?: (p: TransferProgress) => void,
  signal?: { cancelled: boolean }
): Promise<void> {
  if (kind === 'dir') {
    const localRoot = join(localDir, basename(remotePath))
    await fsp.mkdir(localRoot, { recursive: true })
    const entries = await listDir(handle, remotePath)
    for (const entry of entries) {
      if (signal?.cancelled) throw new Error('cancelled')
      await downloadRemote(handle, entry.path, localRoot, entry.kind, onProgress, signal)
    }
    return
  }

  const localPath = join(localDir, basename(remotePath))
  await new Promise<void>((resolve, reject) => {
    handle.sftp.fastGet(
      remotePath,
      localPath,
      {
        concurrency: 16,
        chunkSize: 32 * 1024,
        step: (transferred: number, _chunk: number, total: number) => {
          onProgress?.({
            currentFile: basename(remotePath),
            transferred,
            total,
            done: false
          })
          if (signal?.cancelled) throw new Error('cancelled')
        }
      },
      (err) => {
        if (err) {
          reject(new Error(err.message === 'cancelled' ? 'cancelled' : `sftp-download-failed:${err.message}`))
          return
        }
        resolve()
      }
    )
  })
}

/** Uploads several local paths (files or folders) into one remote directory. */
export async function uploadPaths(
  handle: SftpHandle,
  localPaths: ReadonlyArray<string>,
  remoteDir: string,
  onProgress?: (p: TransferProgress) => void,
  signal?: { cancelled: boolean },
  conflictPolicy: ConflictPolicy = 'overwrite'
): Promise<void> {
  if (localPaths.length > MAX_DIR_ENTRIES) {
    throw new Error('sftp-upload-failed:too many items in one drop')
  }
  for (const localPath of localPaths) {
    if (signal?.cancelled) throw new Error('cancelled')
    const stat = await fsp.stat(localPath)
    if (stat.isDirectory()) {
      await uploadTree(handle, localPath, remoteDir, onProgress, signal, conflictPolicy)
    } else if (stat.isFile()) {
      let targetName = basename(localPath)
      // Conflict policy applies per file so a mixed drop behaves predictably.
      const remote = pathPosix.join(remoteDir, targetName)
      if (conflictPolicy === 'resume') {
        // Continue a partial remote file; skip files already fully uploaded.
        const remoteStat = await statRemote(handle, remote)
        if (remoteStat) {
          if (remoteStat.size >= stat.size) continue
          await uploadFromOffset(handle, localPath, remote, remoteStat.size, (t) => onProgress?.({ currentFile: targetName, transferred: t, total: stat.size, done: false }), signal)
          continue
        }
      } else if (conflictPolicy !== 'overwrite') {
        const [clash] = await existingNames(handle, remoteDir, [targetName])
        if (clash) {
          if (conflictPolicy === 'skip') continue
          targetName = await freeName(handle, remoteDir, targetName)
        }
      }
      await new Promise<void>((resolve, reject) => {
        const name = targetName
        const remote = pathPosix.join(remoteDir, name)
        handle.sftp.fastPut(
          localPath,
          remote,
          {
            concurrency: 16,
            chunkSize: 32 * 1024,
            step: (transferred: number, _c: number, total: number) => {
              onProgress?.({ currentFile: name, transferred, total, done: false })
              if (signal?.cancelled) throw new Error('cancelled')
            }
          },
          (err) =>
            err
              ? reject(new Error(err.message === 'cancelled' ? 'cancelled' : `sftp-upload-failed:${err.message}`))
              : resolve()
        )
      })
    }
  }
  onProgress?.({ currentFile: '', transferred: 0, total: 0, done: true })
}

/** Renames/moves a remote entry. */
export function renameRemote(handle: SftpHandle, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    handle.sftp.rename(from, to, (err) =>
      err ? reject(new Error(`sftp-rename-failed:${err.message}`)) : resolve()
    )
  })
}

/** Changes permissions (e.g. 0o644). Follows the same stat → chmod two-step. */
export function chmodRemote(handle: SftpHandle, target: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    handle.sftp.stat(target, (statErr, stats) => {
      if (statErr || !stats) {
        reject(new Error(`sftp-chmod-failed:${statErr?.message ?? 'stat failed'}`))
        return
      }
      handle.sftp.chmod(target, mode, (err) =>
        err ? reject(new Error(`sftp-chmod-failed:${err.message}`)) : resolve()
      )
    })
  })
}

/**
 * Which of `names` already exist in `remoteDir`? Used before an upload so the
 * user can choose overwrite / keep both / skip instead of silently clobbering.
 */
export function existingNames(
  handle: SftpHandle,
  remoteDir: string,
  names: ReadonlyArray<string>
): Promise<string[]> {
  return new Promise((resolve) => {
    const found: string[] = []
    let pending = names.length
    if (pending === 0) {
      resolve(found)
      return
    }
    for (const name of names) {
      const full = pathPosix.join(remoteDir, name)
      handle.sftp.stat(full, (err, stats) => {
        if (!err && stats) found.push(name)
        pending--
        if (pending === 0) resolve(found)
      })
    }
  })
}

/**
 * Finds a free name by appending " (n)" before the extension, so a
 * conflict-rename upload never overwrites anything.
 */
export function freeName(handle: SftpHandle, remoteDir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return new Promise((resolve) => {
    let n = 1
    const tryName = () => {
      const candidate = `${stem} (${n})${ext}`
      handle.sftp.stat(pathPosix.join(remoteDir, candidate), (err, stats) => {
        if (err || !stats) resolve(candidate)
        else {
          n++
          if (n > 999) resolve(`${stem}-${Date.now()}${ext}`)
          else tryName()
        }
      })
    }
    tryName()
  })
}
