import { describe, expect, it } from 'vitest'
import { parsePuttyRegOutput, decodePuttyName } from '../shared/putty'
import { parseSshConfig } from '../shared/sshconfig'
import { buildJumpChain, resolveProxyJump } from '../shared/jump'
import type { ServerEntry } from '../shared/types'

const BS = String.fromCharCode(92)
const HK = 'HKEY_CURRENT_USER' + BS + 'Software' + BS + 'SimonTatham' + BS + 'PuTTY' + BS + 'Sessions' + BS

const PUTTY_OUTPUT = [
  '',
  HK + 'web1',
  '    Protocol    REG_SZ    SSH',
  '    HostName    REG_SZ    10.0.0.1',
  '    PortNumber  REG_DWORD 0x00000016 (22)',
  '    UserName    REG_SZ    deploy',
  '',
  HK + 'db%20prod',
  '    Protocol    REG_SZ    SSH',
  '    HostName    REG_SZ    db.internal',
  '    PortNumber  REG_DWORD 0x000008ae (2222)',
  '    UserName    REG_SZ    admin',
  ''
].join('\n')

describe('PuTTY registry parser', () => {
  it('extracts sessions with decoded names', () => {
    const sessions = parsePuttyRegOutput(PUTTY_OUTPUT)
    expect(sessions).toHaveLength(2)
    expect(sessions[0].name).toBe('web1')
    expect(sessions[0].host).toBe('10.0.0.1')
    expect(sessions[0].port).toBe(22)
    expect(sessions[0].username).toBe('deploy')
    expect(sessions[1].name).toBe('db prod')
    expect(sessions[1].port).toBe(2222)
  })

  it('handles empty output', () => {
    expect(parsePuttyRegOutput('')).toHaveLength(0)
  })

  it('skips non-SSH sessions (serial, telnet)', () => {
    const out = PUTTY_OUTPUT + '\n' + HK + 'serial\n    Protocol    REG_SZ    Serial\n'
    expect(parsePuttyRegOutput(out)).toHaveLength(2)
  })

  it('decodes percent-encoded names', () => {
    expect(decodePuttyName('web%20box')).toBe('web box')
    expect(decodePuttyName('plain')).toBe('plain')
  })
})

describe('OpenSSH config parser', () => {
  it('parses Host blocks with HostName, User, Port', () => {
    const entries = parseSshConfig('Host web1\n  HostName 10.0.0.1\n  User deploy\n  Port 2222')
    expect(entries).toHaveLength(1)
    expect(entries[0].alias).toBe('web1')
    expect(entries[0].host).toBe('10.0.0.1')
    expect(entries[0].user).toBe('deploy')
    expect(entries[0].port).toBe(2222)
  })

  it('skips entries without HostName (cannot import without a target)', () => {
    expect(parseSshConfig('Host web1\n  User deploy')).toHaveLength(0)
  })

  it('skips multiple aliases that all lack HostName', () => {
    expect(parseSshConfig('Host web1 web2\n  User deploy')).toHaveLength(0)
  })

  it('skips wildcard patterns and Match blocks', () => {
    const text = 'Host *.prod\n  User deploy\n\nMatch host *\n  User admin\n\nHost real\n  User root\n  HostName 1.2.3.4\n'
    const entries = parseSshConfig(text)
    expect(entries).toHaveLength(1)
    expect(entries[0].alias).toBe('real')
  })

  it('extracts ProxyJump and IdentityFile', () => {
    const text = 'Host target\n  User deploy\n  ProxyJump bastion\n  IdentityFile ~/.ssh/id_ed25519\n  HostName 10.0.0.5\n'
    const entries = parseSshConfig(text)
    expect(entries[0].proxyJump).toBe('bastion')
    expect(entries[0].identityFile).toBe('~/.ssh/id_ed25519')
  })

  it('handles = as key separator', () => {
    const entries = parseSshConfig('Host=web1\nUser=deploy\nHostName=10.0.0.1\n')
    expect(entries).toHaveLength(1)
    expect(entries[0].alias).toBe('web1')
    expect(entries[0].host).toBe('10.0.0.1')
  })
})

describe('jump chain builder', () => {
  const mk = (id: string, jumpHostId: string | null = null): ServerEntry => ({
    id, name: id, host: id, port: 22, username: 'u', password: 'p',
    authMethod: 'password', keyAuth: null, jumpHostId, tags: [], notes: '',
    elevate: { enabled: false, preset: 'sudo -s', customCommand: '', passwordMode: 'same', customPassword: '' },
    createdAt: '', updatedAt: '', lastConnectedAt: null
  })

  it('resolves single-hop chains', () => {
    const target = mk('target', 'bastion')
    const { hops, broken } = buildJumpChain(target, (id) => (id === 'bastion' ? mk('bastion') : undefined))
    expect(hops.map((h) => h.id)).toEqual(['bastion'])
    expect(broken).toBe(false)
  })

  it('resolves multi-hop chains outermost first', () => {
    const target = mk('t', 'j1')
    const j1 = mk('j1', 'j2')
    const j2 = mk('j2')
    const lookup = (id: string) => ({ j1, j2 })[id]
    const { hops } = buildJumpChain(target, lookup)
    expect(hops.map((h) => h.id)).toEqual(['j2', 'j1'])
  })

  it('detects broken chains (deleted hop)', () => {
    const target = mk('t', 'deleted')
    const { broken } = buildJumpChain(target, () => undefined)
    expect(broken).toBe(true)
  })

  it('detects cycles', () => {
    const a = mk('a', 'b')
    const b = mk('b', 'a')
    const lookup = (id: string) => ({ a, b })[id]
    const { broken } = buildJumpChain(a, lookup)
    expect(broken).toBe(true)
  })
})

describe('ProxyJump resolution', () => {
  const candidates = [
    { id: 'id-1', host: 'bastion.internal', alias: 'bastion' },
    { id: 'id-2', host: 'web.example.com', alias: 'web' }
  ]

  it('resolves by hostname', () => {
    expect(resolveProxyJump('bastion.internal', candidates)).toBe('id-1')
  })

  it('resolves by alias', () => {
    expect(resolveProxyJump('bastion', candidates)).toBe('id-1')
  })

  it('resolves user@host form', () => {
    expect(resolveProxyJump('deploy@bastion.internal', candidates)).toBe('id-1')
  })

  it('resolves host:port form', () => {
    expect(resolveProxyJump('bastion:2222', candidates)).toBe('id-1')
  })

  it('returns null for unmatched proxies', () => {
    expect(resolveProxyJump('unknown.host', candidates)).toBeNull()
  })
})
