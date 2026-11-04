import type { ConnectConfig } from 'ssh2'
import type { ServerEntry } from '@shared/types'

/**
 * Builds the authentication half of an ssh2 connect config from a stored
 * server. Shared by the terminal, SFTP and "test connection" paths so all
 * three behave identically.
 *
 * Never log or return this object — it carries secrets.
 */
export function authConfig(server: ServerEntry): Partial<ConnectConfig> {
  switch (server.authMethod) {
    case 'key': {
      if (!server.keyAuth?.privateKey) {
        throw new Error('invalid-input:no private key stored for this server')
      }
      return {
        privateKey: server.keyAuth.privateKey,
        ...(server.keyAuth.passphrase ? { passphrase: server.keyAuth.passphrase } : {})
      }
    }
    case 'agent':
      // Uses SSH_AUTH_SOCK when present (Windows: Pageant/OpenSSH agent).
      return { agent: process.env.SSH_AUTH_SOCK }
    case 'password':
    default:
      return { password: server.password }
  }
}

/** True when the server has the credentials its auth method needs. */
export function hasCredentials(server: ServerEntry): boolean {
  switch (server.authMethod) {
    case 'key':
      return !!server.keyAuth?.privateKey
    case 'agent':
      return true
    default:
      return !!server.password
  }
}

/**
 * Validates a pasted private key before saving. Accepts PEM ("BEGIN ... PRIVATE
 * KEY") and OpenSSH format ("BEGIN OPENSSH PRIVATE KEY"). Rejecting garbage
 * here gives a clear error instead of an obscure handshake failure later.
 */
export function looksLikePrivateKey(text: string): boolean {
  const t = text.trim()
  if (t.length < 100) return false
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t) && /-----END [A-Z ]*PRIVATE KEY-----/.test(t)
}

export function privateKeyKind(text: string): string | null {
  const m = text.match(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----/)
  return m ? m[1] : null
}
