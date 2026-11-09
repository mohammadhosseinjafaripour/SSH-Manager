import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { HelloDecryptError, openHelloFile, sealHelloFile } from '../src/main/vault/hello'

/** The wrap/unwrap core must be correct without Windows: DPAPI only hides the
 * KEK; the AES wrap is what binds the vault key. */
describe('windows hello key wrap', () => {
  it('round-trips the vault key under a KEK', () => {
    const kek = randomBytes(32)
    const vaultKey = randomBytes(32)
    const file = sealHelloFile(kek, vaultKey)
    expect(openHelloFile({ ...file, kekB64: 'x' }, kek)).toEqual(vaultKey)
  })

  it('a wrong KEK cannot unwrap (tamper → unlock-failed)', () => {
    const vaultKey = randomBytes(32)
    const file = sealHelloFile(randomBytes(32), vaultKey)
    expect(() => openHelloFile({ ...file, kekB64: 'x' }, randomBytes(32))).toThrow(HelloDecryptError)
  })

  it('tampered ciphertext fails the GCM auth tag', () => {
    const kek = randomBytes(32)
    const file = sealHelloFile(kek, randomBytes(32))
    const blob = Buffer.from(file.wrappedB64, 'base64')
    blob[blob.length - 1] ^= 0xff
    expect(() =>
      openHelloFile({ ...file, kekB64: 'x', wrappedB64: blob.toString('base64') }, kek)
    ).toThrow(HelloDecryptError)
  })

  it('a fresh wrap is never deterministic (random IV)', () => {
    const kek = randomBytes(32)
    const vaultKey = randomBytes(32)
    const a = sealHelloFile(kek, vaultKey)
    const b = sealHelloFile(kek, vaultKey)
    expect(a.wrappedB64).not.toBe(b.wrappedB64)
  })
})
