import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { VaultStore, UnlockFailedError } from '../src/main/vault/store'
import {
  applyImport,
  exportEncrypted,
  openEncryptedExport,
  parseCsv,
  serversFromCsv,
  serversToCsv,
  looksLikeEncryptedExport
} from '../src/main/vault/transfer'
import type { ServerEntry } from '../shared/types'

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function freshStore(): VaultStore {
  const dir = mkdtempSync(join(tmpdir(), 'sshvault-transfer-'))
  dirs.push(dir)
  const store = new VaultStore(dir)
  return store
}

const PW = 'transfer test master pw'

function makeServer(over: Partial<ServerEntry> = {}): ServerEntry {
  return {
    id: over.id ?? crypto.randomUUID(),
    name: over.name ?? 'web',
    host: over.host ?? '10.0.0.1',
    port: over.port ?? 22,
    username: over.username ?? 'deploy',
    password: over.password ?? 'secret-one',
    authMethod: 'password',
    tags: over.tags ?? ['prod'],
    notes: over.notes ?? '',
    elevate: over.elevate ?? {
      enabled: false,
      preset: 'sudo -s',
      customCommand: '',
      passwordMode: 'same',
      customPassword: ''
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastConnectedAt: null
  }
}

async function seededStore(): Promise<VaultStore> {
  const store = freshStore()
  await store.create(PW)
  await store.pinHostKey('10.0.0.1', 22, 'SHA256:pin1')
  const s1 = await store.upsertServer({
    name: 'web',
    host: '10.0.0.1',
    port: 22,
    username: 'deploy',
    password: 'secret-one',
    tags: ['prod'],
    notes: 'comma, "quoted" text',
    elevate: { enabled: true, preset: 'sudo -s', customCommand: '', passwordMode: 'same' }
  })
  void s1
  return store
}

describe('encrypted export / import', () => {
  it('round-trips servers and secrets into a fresh vault', async () => {
    const source = await seededStore()
    const raw = await exportEncrypted(
      source.getPayload().servers,
      source.getPayload().pinnedHostKeys,
      true,
      'StrongExportPass1'
    )
    expect(raw).not.toContain('secret-one')
    expect(looksLikeEncryptedExport(raw)).toBe(true)

    const payload = await openEncryptedExport(raw, 'StrongExportPass1')
    expect(payload.servers).toHaveLength(1)
    expect(payload.servers[0].password).toBe('secret-one')
    expect(payload.pinnedHostKeys[0].fingerprint).toBe('SHA256:pin1')

    const target = freshStore()
    await target.create(PW)
    const summary = await applyImport(
      target,
      { servers: payload.servers, pinnedHostKeys: payload.pinnedHostKeys },
      'merge'
    )
    expect(summary).toEqual({ added: 1, skippedDuplicates: 0, replaced: false })
    expect(target.getServer(payload.servers[0].id).password).toBe('secret-one')
    expect(target.getPayload().pinnedHostKeys[0].fingerprint).toBe('SHA256:pin1')
  })

  it('wrong export password → unlock-failed, import rejected', async () => {
    const source = await seededStore()
    const raw = await exportEncrypted(source.getPayload().servers, [], false, 'StrongExportPass1')
    await expect(openEncryptedExport(raw, 'WrongPassword99')).rejects.toBeInstanceOf(UnlockFailedError)
  })

  it('rejects short export passwords', async () => {
    const source = await seededStore()
    await expect(exportEncrypted(source.getPayload().servers, [], false, 'short')).rejects.toThrow(
      'invalid-input'
    )
  })

  it('a random file that is not an export is rejected', async () => {
    await expect(openEncryptedExport('{"hello":1}', 'whatever-pass')).rejects.toThrow('invalid-input')
  })

  it('merge skips natural-key duplicates and de-duplicates colliding ids', async () => {
    const target = freshStore()
    await target.create(PW)
    await target.upsertServer({
      name: 'web',
      host: '10.0.0.1',
      port: 22,
      username: 'deploy',
      password: 'existing',
      tags: [],
      notes: '',
      elevate: { enabled: false, preset: 'sudo -s', customCommand: '', passwordMode: 'same' }
    })

    // 'web' collides on name+host+port+username → skipped.
    // 'db' reuses the existing server's id → must receive a fresh id.
    const existingEntry = target.getPayload().servers[0]
    const summary = await applyImport(
      target,
      {
        servers: [
          makeServer(), // duplicate by name/host/port/user
          makeServer({ id: existingEntry.id, name: 'db', host: '10.0.0.2' })
        ]
      },
      'merge'
    )
    expect(summary.added).toBe(1)
    expect(summary.skippedDuplicates).toBe(1)
    const servers = target.getPayload().servers
    expect(servers).toHaveLength(2)
    expect(servers.find((s) => s.name === 'web')?.password).toBe('existing') // kept existing
    const db = servers.find((s) => s.name === 'db')
    expect(db?.id).toBeDefined()
    expect(db?.id).not.toBe(existingEntry.id)
  })

  it('replace wipes servers and pins', async () => {
    const target = await seededStore()
    const summary = await applyImport(
      target,
      { servers: [makeServer({ name: 'only', host: '1.2.3.4' })], pinnedHostKeys: [] },
      'replace'
    )
    expect(summary.replaced).toBe(true)
    expect(target.getPayload().servers.map((s) => s.name)).toEqual(['only'])
    expect(target.getPayload().pinnedHostKeys).toHaveLength(0)
  })
})

describe('CSV', () => {
  it('parses RFC4180: quotes, escaped quotes, commas, CRLF', () => {
    const rows = parseCsv('a,"b,c","d""e"\r\nplain,,x\r\n')
    expect(rows).toEqual([
      ['a', 'b,c', 'd"e'],
      ['plain', '', 'x']
    ])
  })

  it('round-trips servers through CSV preserving special characters', () => {
    const servers = [
      makeServer({
        name: 'web, prod',
        host: '10.0.0.1',
        password: 'p@ss "word", with, commas',
        tags: ['prod', 'web'],
        notes: 'line1\nline2',
        elevate: { enabled: true, preset: 'custom', customCommand: 'sudo -u admin -s', passwordMode: 'same', customPassword: '' }
      })
    ]
    const csv = serversToCsv(servers)
    const parsed = serversFromCsv(csv)
    expect(parsed.errors).toEqual([])
    expect(parsed.inputs).toHaveLength(1)
    const got = parsed.inputs[0]
    expect(got.name).toBe('web, prod')
    expect(got.password).toBe('p@ss "word", with, commas')
    expect(got.tags).toEqual(['prod', 'web'])
    expect(got.notes).toBe('line1\nline2')
    expect(got.elevate.enabled).toBe(true)
    expect(got.elevate.preset).toBe('custom')
    expect(got.elevate.customCommand).toBe('sudo -u admin -s')
  })

  it('defaults port 22 and sudo off; auto_sudo yes enables elevation', () => {
    const csv =
      'name,host,username,password,auto_sudo\r\na,1.2.3.4,root,pw\r\nb,1.2.3.5,root,pw2,yes\r\n'
    const parsed = serversFromCsv(csv)
    expect(parsed.errors).toEqual([])
    expect(parsed.inputs[0].port).toBe(22)
    expect(parsed.inputs[0].elevate.enabled).toBe(false)
    expect(parsed.inputs[1].elevate.enabled).toBe(true)
  })

  it('reports row errors without dropping valid rows', () => {
    const csv = 'name,host,port,username,password\r\nok,1.1.1.1,22,u,p\r\n,2.2.2.2,22,u,p\r\nbad,3.3.3.3,99999,u,p\r\n'
    const parsed = serversFromCsv(csv)
    expect(parsed.inputs.map((i) => i.name)).toEqual(['ok'])
    expect(parsed.errors).toHaveLength(2)
  })

  it('fails outright when the header is missing required columns', () => {
    const parsed = serversFromCsv('label,address\r\na,b\r\n')
    expect(parsed.inputs).toHaveLength(0)
    expect(parsed.errors[0]).toMatch(/Missing required columns/)
  })
})
