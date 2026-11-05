import { MessageChannelMain, type WebContents } from 'electron'
import { Client } from 'ssh2'
import { SESSION_PORT_CHANNEL } from '@shared/types'
import type { HealthResult, ServerEntry, TestConnectionResult } from '@shared/types'
import type { VaultStore } from '../vault/store'
import { checkPin, fingerprintOf } from '../hostkeys/verifier'
import { authConfig } from './auth'
import { SshSession } from './session'

/**
 * Registry of live sessions. Owns the MessageChannelMain pairs: the renderer
 * gets one port per session, the session gets the other; terminal traffic
 * never crosses the typed invoke() bridge.
 */
export class ConnectionManager {
  private sessions = new Map<string, SshSession>()

  constructor(
    private readonly store: VaultStore,
    private readonly wc: WebContents
  ) {}

  open(serverId: string): { sessionId: string } {
    // Throws vault-locked / not-found before any socket is opened.
    const server = this.store.getServer(serverId)
    const session = new SshSession({
      server,
      store: this.store,
      onEnded: (id) => this.sessions.delete(id)
    })
    const { port1, port2 } = new MessageChannelMain()
    session.attachPort(port1)
    this.sessions.set(session.id, session)
    this.wc.postMessage(SESSION_PORT_CHANNEL, { sessionId: session.id }, [port2])
    session.start()
    return { sessionId: session.id }
  }

  close(sessionId: string): void {
    this.sessions.get(sessionId)?.destroy()
  }

  /** Finds the live session for a server (used by terminal completion). */
  findByServer(serverId: string): SshSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.serverId === serverId) return session
    }
    return undefined
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.destroy()
    this.sessions.clear()
  }
}

/**
 * "Test Connection" — verifies reachability, shows the host fingerprint and
 * checks authentication. It never pins a key: pinning happens only through
 * the first-connect TOFU dialog (or the explicit changed-key flow).
 */
export function testConnection(server: ServerEntry, store: VaultStore): Promise<TestConnectionResult> {
  return new Promise((resolve) => {
    const { host, port, username } = server
    let fingerprint: string | undefined
    let pinState: 'none' | 'match' | 'changed' = 'none'
    let settled = false

    const conn = new Client()

    const finish = (result: TestConnectionResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        conn.end()
      } catch {
        /* already gone */
      }
      resolve(result)
    }

    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          pinned: pinState === 'match',
          message: 'Timed out after 15 s — check host, port and firewall',
          fingerprint
        }),
      15_000
    )

    conn.on('error', (err: Error) => {
      if (settled) return
      const msg = err.message ?? 'Connection failed'
      if (/All configured (?:authentication methods|auth methods)/i.test(msg)) {
        finish({
          ok: false,
          pinned: pinState === 'match',
          fingerprint,
          message: 'Reached the server, but authentication failed — check username and password'
        })
        return
      }
      if (pinState === 'changed') {
        finish({
          ok: false,
          pinned: false,
          fingerprint,
          message: 'Host key has CHANGED since it was pinned — connect to review the fingerprints'
        })
        return
      }
      finish({ ok: false, pinned: pinState === 'match', fingerprint, message: msg })
    })

    conn.on('ready', () => {
      finish({
        ok: true,
        pinned: pinState === 'match',
        fingerprint,
        message:
          pinState === 'match'
            ? 'Connected and authenticated — host key matches the pinned fingerprint'
            : 'Connected and authenticated. The host key is not pinned yet; it will be pinned when you first connect.'
      })
    })

    let auth: ReturnType<typeof authConfig>
    try {
      auth = authConfig(server)
    } catch (err) {
      finish({
        ok: false,
        pinned: false,
        message: err instanceof Error ? err.message : 'Missing credentials'
      })
      return
    }

    conn.connect({
      host,
      port,
      username,
      ...auth,
      tryKeyboard: true,
      readyTimeout: 14_000,
      hostVerifier: (key: Buffer, cb?: (ok: boolean) => void) => {
        const decide = cb ?? (() => {})
        fingerprint = fingerprintOf(key)
        try {
          const check = checkPin(store.getPayload().pinnedHostKeys, host, port, fingerprint)
          if (check.verdict === 'trusted') {
            pinState = 'match'
            decide(true)
          } else if (check.verdict === 'changed') {
            pinState = 'changed'
            decide(false) // refused: surfaced as an error result above
          } else {
            decide(true) // unknown key: proceed so auth can be tested; never pinned here
          }
        } catch {
          decide(false)
        }
      }
    })
  })
}

/**
 * Lightweight reachability probe used by the bulk health check. Deliberately
 * does NOT authenticate-successfully-only: it distinguishes "server answers but
 * rejects me" (auth-failed) from "nothing there" (unreachable), which is what
 * you actually want to know when triaging many servers.
 */
export function probeServer(server: ServerEntry, store: VaultStore): Promise<HealthResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    let hostKeyChanged = false
    const conn = new Client()

    const finish = (status: HealthResult['status'], detail?: string, latency?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        conn.end()
      } catch {
        /* gone */
      }
      resolve({ serverId: server.id, status, detail, latencyMs: latency })
    }

    const timer = setTimeout(() => finish('unreachable', 'Timed out'), 12_000)

    conn.on('error', (err: Error) => {
      const msg = err.message ?? ''
      if (hostKeyChanged) {
        finish('hostkey-changed', 'Host key changed — verify before connecting')
        return
      }
      if (/All configured (?:authentication methods|auth methods)/i.test(msg)) {
        // The TCP/TLS layer answered and the host key verified: the server is up.
        finish('auth-failed', 'Server up, but credentials were rejected', Date.now() - started)
        return
      }
      finish('unreachable', msg)
    })

    conn.on('ready', () =>
      finish('online', undefined, Date.now() - started)
    )

    let auth: ReturnType<typeof authConfig>
    try {
      auth = authConfig(server)
    } catch (err) {
      finish('auth-failed', err instanceof Error ? err.message : 'Missing credentials')
      return
    }

    conn.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      ...auth,
      tryKeyboard: true,
      readyTimeout: 11_000,
      hostVerifier: (key: Buffer, cb?: (ok: boolean) => void) => {
        const decide = cb ?? (() => {})
        try {
          const check = checkPin(
            store.getPayload().pinnedHostKeys,
            server.host,
            server.port,
            fingerprintOf(key)
          )
          if (check.verdict === 'changed') {
            hostKeyChanged = true
            decide(false)
          } else {
            decide(true)
          }
        } catch {
          decide(false)
        }
      }
    })
  })
}

/** Runs probes with bounded concurrency so 100 servers don't open 100 sockets. */
export async function healthCheckAll(
  servers: ReadonlyArray<ServerEntry>,
  store: VaultStore,
  concurrency = 8
): Promise<HealthResult[]> {
  const results: HealthResult[] = []
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, servers.length) }, async () => {
    for (;;) {
      const i = index++
      if (i >= servers.length) return
      results.push(await probeServer(servers[i], store))
    }
  })
  await Promise.all(workers)
  // Keep the caller's ordering for stable rendering.
  const byId = new Map(results.map((r) => [r.serverId, r]))
  return servers.map((s) => byId.get(s.id)).filter((r): r is HealthResult => !!r)
}
