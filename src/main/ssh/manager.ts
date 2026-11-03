import { MessageChannelMain, type WebContents } from 'electron'
import { Client } from 'ssh2'
import { SESSION_PORT_CHANNEL } from '@shared/types'
import type { ServerEntry, TestConnectionResult } from '@shared/types'
import type { VaultStore } from '../vault/store'
import { checkPin, fingerprintOf } from '../hostkeys/verifier'
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
    const { host, port, username, password } = server
    let fingerprint: string | undefined
    let pinState: 'none' | 'match' | 'changed' = 'none'

    const finish = (result: TestConnectionResult) => {
      settled = true
      clearTimeout(timer)
      try {
        conn.end()
      } catch {
        /* already gone */
      }
      resolve(result)
    }

    const conn = new Client()
    let settled = false
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

    conn.connect({
      host,
      port,
      username,
      password,
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
