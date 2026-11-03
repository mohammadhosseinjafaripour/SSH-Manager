import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkPin, fingerprintOf } from '../src/main/hostkeys/verifier'
import type { HostKeyPin } from '../shared/types'

function fakeKey(seed: string): Buffer {
  return createHash('sha256').update(seed).digest()
}

describe('fingerprintOf', () => {
  it('produces OpenSSH-style SHA256 base64 without padding', () => {
    const fp = fingerprintOf(fakeKey('key-a'))
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })

  it('different keys produce different fingerprints', () => {
    expect(fingerprintOf(fakeKey('a'))).not.toBe(fingerprintOf(fakeKey('b')))
  })
})

describe('checkPin (TOFU)', () => {
  const pins: HostKeyPin[] = [
    { host: '10.0.0.1', port: 22, fingerprint: fingerprintOf(fakeKey('a')), pinnedAt: '2026-01-01' },
    // IPv6 literal: must be keyed safely apart from host:port string concat
    { host: '::1', port: 22, fingerprint: fingerprintOf(fakeKey('v6')), pinnedAt: '2026-01-01' }
  ]

  it('trusted when the fingerprint matches', () => {
    expect(checkPin(pins, '10.0.0.1', 22, pins[0].fingerprint)).toEqual({
      verdict: 'trusted',
      fingerprint: pins[0].fingerprint
    })
  })

  it('unknown for a first-seen host', () => {
    expect(checkPin(pins, '10.0.0.9', 22, 'SHA256:new')).toEqual({
      verdict: 'unknown',
      fingerprint: 'SHA256:new'
    })
  })

  it('changed when the same host offers a different key', () => {
    const res = checkPin(pins, '10.0.0.1', 22, 'SHA256:attacker')
    expect(res).toEqual({
      verdict: 'changed',
      fingerprint: 'SHA256:attacker',
      pinnedFingerprint: pins[0].fingerprint
    })
  })

  it('same host on a different port is a different identity', () => {
    expect(checkPin(pins, '10.0.0.1', 2222, 'SHA256:other')).toEqual({
      verdict: 'unknown',
      fingerprint: 'SHA256:other'
    })
  })

  it('IPv6 literals never collide with another endpoint', () => {
    expect(checkPin(pins, '::1', 22, pins[1].fingerprint).verdict).toBe('trusted')
    expect(checkPin(pins, '::1', 22, 'SHA256:other').verdict).toBe('changed')
    expect(checkPin(pins, '::2', 22, pins[1].fingerprint).verdict).toBe('unknown')
  })
})
