import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Algorithm, hashRaw } from '@node-rs/argon2'

export const VAULT_VERSION = 1

/** Argon2id work factors — exceed OWASP minimums (m=19MiB,t=2,p=1). */
export const DEFAULT_KDF = { memoryKiB: 65536, timeCost: 3, parallelism: 4 } as const

export interface KdfParams {
  memoryKiB: number
  timeCost: number
  parallelism: number
}

export interface VaultHeader {
  version: number
  kdf: {
    algo: 'argon2id'
    saltB64: string
    memoryKiB: number
    timeCost: number
    parallelism: number
  }
  cipher: 'aes-256-gcm'
  createdAt: string
}

/**
 * Wrong master password and tampered ciphertext are cryptographically
 * indistinguishable — both surface as this error and both get the same
 * merged user-facing message (by design, so a mistyped password can never be
 * mistaken for corruption and push the user into a stale-backup restore).
 */
export class VaultDecryptError extends Error {
  constructor() {
    super('unlock-failed')
  }
}

export function newHeader(params: KdfParams = DEFAULT_KDF): VaultHeader {
  return {
    version: VAULT_VERSION,
    kdf: {
      algo: 'argon2id',
      saltB64: randomBytes(16).toString('base64'),
      memoryKiB: params.memoryKiB,
      timeCost: params.timeCost,
      parallelism: params.parallelism
    },
    cipher: 'aes-256-gcm',
    createdAt: new Date().toISOString()
  }
}

export async function deriveKey(
  masterPassword: string,
  salt: Buffer,
  params: KdfParams
): Promise<Buffer> {
  return hashRaw(masterPassword.normalize('NFKC'), {
    algorithm: Algorithm.Argon2id,
    salt: new Uint8Array(salt),
    memoryCost: params.memoryKiB,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
    outputLen: 32
  })
}

/** AAD binds the ciphertext to the exact header it was sealed under. */
function headerAad(header: VaultHeader): Buffer {
  return Buffer.from(JSON.stringify(header), 'utf8')
}

export interface SealedPayload {
  ivB64: string
  tagB64: string
  ctB64: string
}

export interface VaultFile {
  header: VaultHeader
  sealed: SealedPayload
}

export function sealPayload(key: Buffer, header: VaultHeader, plaintext: string): SealedPayload {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(headerAad(header))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    ivB64: iv.toString('base64'),
    tagB64: cipher.getAuthTag().toString('base64'),
    ctB64: ct.toString('base64')
  }
}

export function openPayload(key: Buffer, header: VaultHeader, sealed: SealedPayload): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.ivB64, 'base64'))
    decipher.setAAD(headerAad(header))
    decipher.setAuthTag(Buffer.from(sealed.tagB64, 'base64'))
    const ct = Buffer.from(sealed.ctB64, 'base64')
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    throw new VaultDecryptError()
  }
}

export function parseVaultFile(raw: string): VaultFile {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    throw new VaultDecryptError()
  }
  if (
    typeof doc !== 'object' ||
    doc === null ||
    typeof (doc as VaultFile).header !== 'object' ||
    typeof (doc as VaultFile).sealed !== 'object'
  ) {
    throw new VaultDecryptError()
  }
  const { header, sealed } = doc as VaultFile
  if (
    typeof header?.kdf?.saltB64 !== 'string' ||
    typeof header.kdf.memoryKiB !== 'number' ||
    typeof sealed?.ivB64 !== 'string' ||
    typeof sealed.tagB64 !== 'string' ||
    typeof sealed.ctB64 !== 'string'
  ) {
    throw new VaultDecryptError()
  }
  return { header, sealed }
}
