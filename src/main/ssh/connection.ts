/**
 * Opens a tunnelled socket through the server's jump chain (ProxyJump style).
 *
 * Each hop is a stored server connected with its own credentials; its host key
 * must already be pinned (connect to it directly once) — a background tunnel
 * cannot surface the interactive TOFU dialog. After the chain, forwardOut
 * opens a TCP channel to the target's host:port, which the caller feeds into
 * `Client.connect({ sock })`.
 *
 * Every hop connection is kept alive for the lifetime of the tunnel; `close()`
 * ends them all.
 */
import { Client, type ConnectConfig } from 'ssh2'
import type { ServerEntry } from '@shared/types'
import { authConfig, hasCredentials } from './auth'
import { checkPin, fingerprintOf } from '../hostkeys/verifier'
import { buildJumpChain } from '@shared/jump'
import type { VaultStore } from '../vault/store'

export interface JumpSocket {
  sock: NodeJS.ReadWriteStream
  /** Ends every hop connection. Call when the tunnelled client closes. */
  close(): void
}

function pinnedVerifier(store: VaultStore, hop: ServerEntry): (key: Buffer) => boolean {
  return (key: Buffer) => {
    try {
      const fp = fingerprintOf(key)
      return checkPin(store.getPayload().pinnedHostKeys, hop.host, hop.port, fp).verdict === 'trusted'
    } catch {
      return false // vault locked mid-handshake: refuse rather than guess
    }
  }
}

/**
 * Resolves the jump chain and returns a tunnelled socket to `server`. Throws a
 * descriptive Error when the chain is broken, untrusted or unreachable.
 */
export async function openJumpSocket(
  server: ServerEntry,
  store: VaultStore
): Promise<JumpSocket> {
  const { hops, broken } = buildJumpChain(server, (id) => {
    try {
      return store.getServer(id)
    } catch {
      return undefined
    }
  })
  if (broken && hops.length === 0) {
    throw new Error('jump-broken:this jump host was deleted — edit the server to clear it')
  }

  const clients: Client[] = []
  const close = () => {
    for (const c of clients) {
      try {
        c.end()
      } catch {
        /* already gone */
      }
    }
  }

  try {
    for (const hop of hops) {
      if (!hasCredentials(hop)) {
        throw new Error(`jump-credentials:"${hop.name}" has no password or key stored`)
      }
      const client = new Client()
      clients.push(client)

      const cfg: ConnectConfig = {
        host: hop.host,
        port: hop.port,
        username: hop.username,
        ...authConfig(hop),
        tryKeyboard: true,
        readyTimeout: 15_000,
        hostVerifier: (key: Buffer, cb?: (ok: boolean) => void) => {
          const ok = pinnedVerifier(store, hop)(key)
          if (!ok) {
            throw new Error(
              `Host key for jump host "${hop.name}" is not pinned — connect to it directly once, then retry`
            )
          }
          cb?.(true)
          return true
        }
      }

      // Tunnel this hop through the previous one.
      if (clients.length > 1) {
        const prev = clients[clients.length - 2]
        await new Promise<void>((resolve, reject) => {
          prev.forwardOut('127.0.0.1', 0, hop.host, hop.port, (err, stream) => {
            if (err) {
              reject(new Error(`jump-forward-failed:${err.message}`))
              return
            }
            cfg.sock = stream
            resolve()
          })
        })
      }

      await new Promise<void>((resolve, reject) => {
        client.on('error', (err: Error) => reject(err))
        client.on('ready', () => resolve())
        client.connect(cfg)
      })
    }

    // Open the channel to the final target through the last hop.
    const last = clients[clients.length - 1]
    const sock = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
      last.forwardOut('127.0.0.1', 0, server.host, server.port, (err, stream) => {
        if (err) reject(new Error(`jump-forward-failed:${err.message}`))
        else resolve(stream)
      })
    })

    return { sock, close }
  } catch (err) {
    close()
    throw err
  }
}

/** True when the server needs a tunnel (i.e. callers must call this first). */
export function needsJump(server: ServerEntry): boolean {
  return !!server.jumpHostId
}
