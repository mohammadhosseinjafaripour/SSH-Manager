import { randomUUID } from 'node:crypto'
import { createReadStream, promises as fsp } from 'node:fs'
import { basename, join, posix as pathPosix } from 'node:path'
import { Client } from 'ssh2'
import type { SFTPWrapper, FileEntryWithStats } from 'ssh2'
import type { RemoteEntry, TransferProgress } from '@shared/types'
import type { VaultStore } from '../vault/store'
import { checkPin, fingerprintOf } from '../hostkeys/verifier'

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
      password: server.password,
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
  signal?: { cancelled: boolean }
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
        await new Promise<void>((resolve, reject) => {
          const read = createReadStream(localPath, { highWaterMark: HIGH_WATER_MARK })
          const write = handle.sftp.createWriteStream(remotePath)
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
  signal?: { cancelled: boolean }
): Promise<void> {
  if (localPaths.length > MAX_DIR_ENTRIES) {
    throw new Error('sftp-upload-failed:too many items in one drop')
  }
  for (const localPath of localPaths) {
    if (signal?.cancelled) throw new Error('cancelled')
    const stat = await fsp.stat(localPath)
    if (stat.isDirectory()) {
      await uploadTree(handle, localPath, remoteDir, onProgress, signal)
    } else if (stat.isFile()) {
      await new Promise<void>((resolve, reject) => {
        const name = basename(localPath)
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
