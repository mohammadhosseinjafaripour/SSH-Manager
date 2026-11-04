import { describe, expect, it } from 'vitest'
import { looksLikePrivateKey, privateKeyKind } from '../src/main/ssh/auth'
import { legacyModeToRwx, octalToRwx } from '../src/renderer/src/features/files/mode-utils'

describe('private key detection', () => {
  const openssh =
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACD+/w==\n-----END OPENSSH PRIVATE KEY-----'
  const rsa =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP\n-----END RSA PRIVATE KEY-----'

  it('accepts OpenSSH and PEM key formats', () => {
    expect(looksLikePrivateKey(openssh)).toBe(true)
    expect(looksLikePrivateKey(rsa)).toBe(true)
  })

  it('rejects public keys, passphrases and random text', () => {
    expect(
      looksLikePrivateKey('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7 user@host')
    ).toBe(false)
    expect(looksLikePrivateKey('my passphrase')).toBe(false)
    expect(looksLikePrivateKey('')).toBe(false)
    // A truncated key block is rejected too.
    expect(looksLikePrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----\nabc')).toBe(false)
  })

  it('reports the key type for user feedback', () => {
    expect(privateKeyKind(openssh)).toBe('OPENSSH PRIVATE KEY')
    expect(privateKeyKind(rsa)).toBe('RSA PRIVATE KEY')
    expect(privateKeyKind('nope')).toBeNull()
  })

  it('rejects a PuTTY .ppk file (must be converted first)', () => {
    const ppk = 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n'
    expect(looksLikePrivateKey(ppk)).toBe(false)
  })
})

describe('permission formatting', () => {
  it('renders rwx triples from an octal mode', () => {
    expect(octalToRwx(0o644)).toBe('rw-r--r--')
    expect(octalToRwx(0o755)).toBe('rwxr-xr-x')
    expect(octalToRwx(0o600)).toBe('rw-------')
    expect(octalToRwx(0o777)).toBe('rwxrwxrwx')
    expect(octalToRwx(0o000)).toBe('---------')
  })

  it('ignores file-type bits above the permission mask', () => {
    // 0o100644 is a regular file with 644 permissions.
    expect(octalToRwx(0o100644)).toBe('rw-r--r--')
  })

  it('legacyModeToRwx stays consistent with octalToRwx', () => {
    for (const m of [0o644, 0o755, 0o600, 0o700, 0o777]) {
      expect(legacyModeToRwx(m)).toBe(octalToRwx(m))
    }
  })
})

describe('upload conflict policy semantics', () => {
  type Policy = 'overwrite' | 'rename' | 'skip'

  /** Mirrors the decision the main process makes for one incoming file. */
  function decide(exists: boolean, policy: Policy): 'write' | 'write-as-new' | 'skip' {
    if (!exists) return 'write'
    if (policy === 'overwrite') return 'write'
    if (policy === 'rename') return 'write-as-new'
    return 'skip'
  }

  it('never touches an existing file unless the user chose overwrite', () => {
    expect(decide(true, 'overwrite')).toBe('write')
    expect(decide(true, 'rename')).toBe('write-as-new')
    expect(decide(true, 'skip')).toBe('skip')
  })

  it('writes new files under every policy', () => {
    for (const p of ['overwrite', 'rename', 'skip'] as Policy[]) {
      expect(decide(false, p)).toBe('write')
    }
  })
})
