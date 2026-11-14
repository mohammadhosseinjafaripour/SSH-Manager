import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { UnlockFailedError, VaultStore } from '../src/main/vault/store'
import { HELLO_FILE, helloFilePath } from '../src/main/vault/hello'

const dirs: string[] = []
function freshStore(): { store: VaultStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sshvault-chpw-'))
  dirs.push(dir)
  return { store: new VaultStore(dir), dir }
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const OLD = 'old master password 1'
const NEW = 'new master password 2'

async function seeded() {
  const { store, dir } = freshStore()
  await store.create(OLD)
  await store.upsertServer({
    name: 'web',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    password: 'keep-me-secret',
    tags: ['prod'],
    notes: 'note',
    elevate: { enabled: true, preset: 'sudo -s', customCommand: '', passwordMode: 'same' }
  })
  return { store, dir }
}

describe('change master password', () => {
  it('re-encrypts in place: same data, new password works, old stops working', async () => {
    const { store, dir } = await seeded()
    await store.changeMasterPassword(OLD, NEW)

    // still unlocked and intact in memory
    expect(store.getPayload().servers).toHaveLength(1)
    expect(store.getPayload().servers[0].password).toBe('keep-me-secret')

    // on disk: old password now fails, new one opens the same data
    store.lock()
    await expect(store.unlock(OLD)).rejects.toBeInstanceOf(UnlockFailedError)
    const payload = await store.unlock(NEW)
    expect(payload.servers).toHaveLength(1)
    expect(payload.servers[0].password).toBe('keep-me-secret')
    expect(payload.servers[0].tags).toEqual(['prod'])
    expect(existsSync(join(dir, 'vault.bin.hello'))).toBe(false)
  })

  it('a wrong current password is rejected before anything changes on disk', async () => {
    const { store, dir } = await seeded()
    const before = readFileSync(join(dir, 'vault.bin'), 'utf8')
    await expect(store.changeMasterPassword('not-the-password', NEW)).rejects.toBeInstanceOf(
      UnlockFailedError
    )
    // disk untouched, vault still opens with the real password
    expect(readFileSync(join(dir, 'vault.bin'), 'utf8')).toBe(before)
    store.lock()
    await expect(store.unlock(OLD)).resolves.toBeTruthy()
  })

  it('rejects a new password shorter than 10 characters', async () => {
    const { store } = await seeded()
    await expect(store.changeMasterPassword(OLD, 'short')).rejects.toThrow(/at least 10/)
    // vault unchanged
    store.lock()
    await expect(store.unlock(OLD)).resolves.toBeTruthy()
  })

  it('drops a Windows Hello enrollment (it wraps the old key)', async () => {
    const { store, dir } = await seeded()
    // Simulate an enrollment file; changeMasterPassword must remove it.
    writeFileSync(helloFilePath(dir), JSON.stringify({ version: 1 }), 'utf8')
    expect(existsSync(join(dir, HELLO_FILE))).toBe(true)
    await store.changeMasterPassword(OLD, NEW)
    expect(existsSync(join(dir, HELLO_FILE))).toBe(false)
  })

  it('works when locked → vault-locked, never silently succeeds', async () => {
    const { store } = await seeded()
    store.lock()
    await expect(store.changeMasterPassword(OLD, NEW)).rejects.toThrow('vault-locked')
  })

  it('allows changing to the same password (resalted, still valid)', async () => {
    const { store } = await seeded()
    await store.changeMasterPassword(OLD, OLD)
    store.lock()
    await expect(store.unlock(OLD)).resolves.toBeTruthy()
  })
})
