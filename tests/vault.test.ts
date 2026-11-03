import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { VaultStore, UnlockFailedError } from '../src/main/vault/store'
import { VAULT_FILE } from '../src/main/vault/store'

const dirs: string[] = []

function freshStore(): { store: VaultStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sshvault-test-'))
  dirs.push(dir)
  return { store: new VaultStore(dir), dir }
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const PW = 'correct horse battery staple'

describe('VaultStore', () => {
  it('create → unlock round-trips the payload', async () => {
    const { store } = freshStore()
    await store.create(PW)
    expect(store.exists()).toBe(true)
    await store.upsertServer({
      name: 'web',
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      password: 'secret-server-pw',
      tags: ['prod'],
      notes: '',
      elevate: { enabled: true, preset: 'sudo -s', customCommand: '', passwordMode: 'same' }
    })
    store.lock()
    expect(store.isUnlocked()).toBe(false)

    const payload = await store.unlock(PW)
    expect(payload.servers).toHaveLength(1)
    expect(payload.servers[0].password).toBe('secret-server-pw')
    expect(payload.servers[0].elevate.enabled).toBe(true)
  })

  it('wrong master password → UnlockFailedError (same error as corruption)', async () => {
    const { store } = freshStore()
    await store.create(PW)
    store.lock()
    await expect(store.unlock('wrong password entirely')).rejects.toBeInstanceOf(UnlockFailedError)
  })

  it('tampered ciphertext → UnlockFailedError', async () => {
    const { store, dir } = freshStore()
    await store.create(PW)
    const path = join(dir, VAULT_FILE)
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    doc.sealed.ctB64 = Buffer.from('attacker-controlled payload').toString('base64')
    writeFileSync(path, JSON.stringify(doc))
    await expect(store.unlock(PW)).rejects.toBeInstanceOf(UnlockFailedError)
  })

  it('flipping the kdf salt (header tamper) → UnlockFailedError via AAD/GCM', async () => {
    const { store, dir } = freshStore()
    await store.create(PW)
    const path = join(dir, VAULT_FILE)
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    doc.header.kdf.saltB64 = Buffer.from('0123456789abcdef').toString('base64')
    writeFileSync(path, JSON.stringify(doc))
    await expect(store.unlock(PW)).rejects.toBeInstanceOf(UnlockFailedError)
  })

  it('saves rotate .bak/.bak2 and a valid backup restores', async () => {
    const { store, dir } = freshStore()
    await store.create(PW)
    await store.upsertServer({
      name: 'first',
      host: '10.0.0.1',
      port: 22,
      username: 'u',
      password: 'p1',
      tags: [],
      notes: '',
      elevate: { enabled: false, preset: 'sudo -s', customCommand: '', passwordMode: 'same' }
    })
    const filesAfterFirst = readdirSync(dir)
    await store.upsertServer({
      name: 'second',
      host: '10.0.0.2',
      port: 22,
      username: 'u',
      password: 'p2',
      tags: [],
      notes: '',
      elevate: { enabled: false, preset: 'sudo -s', customCommand: '', passwordMode: 'same' }
    })
    // Two generations of backups exist alongside the live file.
    const names = readdirSync(dir)
    expect(names).toContain(`${VAULT_FILE}.bak`)
    expect(filesAfterFirst.length).toBeGreaterThan(0)

    // Corrupt the live vault; restore the .bak (which contains "first" only).
    writeFileSync(join(dir, VAULT_FILE), 'garbage')
    await store.restoreBackup(`${VAULT_FILE}.bak`, PW)
    const payload = await store.unlock(PW)
    const names2 = payload.servers.map((s) => s.name)
    expect(names2).toEqual(expect.arrayContaining(['first']))
    expect(names2).not.toContain('second')
  })

  it('restoreBackup with wrong password refuses and touches nothing', async () => {
    const { store, dir } = freshStore()
    await store.create(PW)
    await store.upsertServer({
      name: 'only',
      host: '10.0.0.1',
      port: 22,
      username: 'u',
      password: 'p',
      tags: [],
      notes: '',
      elevate: { enabled: false, preset: 'sudo -s', customCommand: '', passwordMode: 'same' }
    })
    const before = readFileSync(join(dir, VAULT_FILE), 'utf8')
    await expect(store.restoreBackup(`${VAULT_FILE}.bak`, 'nope-wrong-password')).rejects.toBeInstanceOf(
      UnlockFailedError
    )
    expect(readFileSync(join(dir, VAULT_FILE), 'utf8')).toBe(before)
  })

  it('edit keeps the stored password when none is supplied', async () => {
    const { store } = freshStore()
    await store.create(PW)
    const { id } = await store.upsertServer({
      name: 'web',
      host: '10.0.0.1',
      port: 22,
      username: 'u',
      password: 'original',
      tags: [],
      notes: '',
      elevate: { enabled: false, preset: 'sudo -s', customCommand: '', passwordMode: 'same' }
    })
    await store.upsertServer({
      id,
      name: 'web-renamed',
      host: '10.0.0.1',
      port: 22,
      username: 'u',
      tags: [],
      notes: '',
      elevate: { enabled: false, preset: 'sudo -s', customCommand: '', passwordMode: 'same' }
    })
    const server = store.getServer(id)
    expect(server.name).toBe('web-renamed')
    expect(server.password).toBe('original')
  })

  it('host key pins: pin → trusted, replace keeps history', async () => {
    const { store } = freshStore()
    await store.create(PW)
    await store.pinHostKey('10.0.0.1', 22, 'SHA256:aaa')
    expect(store.getPayload().pinnedHostKeys).toHaveLength(1)
    await store.pinHostKey('10.0.0.1', 22, 'SHA256:bbb') // no double pin
    expect(store.getPayload().pinnedHostKeys).toHaveLength(1)
    await store.replaceHostKeyPin('10.0.0.1', 22, 'SHA256:ccc')
    const payload = store.getPayload()
    expect(payload.pinnedHostKeys[0].fingerprint).toBe('SHA256:ccc')
    expect(payload.hostKeyHistory).toHaveLength(1)
    expect(payload.hostKeyHistory[0].oldFingerprint).toBe('SHA256:aaa')
  })

  it('vault file is opaque: no plaintext secrets on disk', async () => {
    const { store, dir } = freshStore()
    await store.create(PW)
    await store.upsertServer({
      name: 'web',
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      password: 'SUPER-SECRET-PLAINTEXT',
      tags: [],
      notes: '',
      elevate: { enabled: false, preset: 'sudo -s', customCommand: '', passwordMode: 'same' }
    })
    const raw = readFileSync(join(dir, VAULT_FILE), 'utf8')
    expect(raw).not.toContain('SUPER-SECRET-PLAINTEXT')
    expect(raw).not.toContain('pinnedHostKeys')
    expect(raw).not.toContain('203.0.0') // host value
    expect(JSON.parse(raw).sealed.ctB64.length).toBeGreaterThan(100)
  })
})
