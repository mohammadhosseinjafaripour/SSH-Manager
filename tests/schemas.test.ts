import { describe, expect, it } from 'vitest'
import {
  generatePassword,
  isValidHost,
  masterPasswordIssues,
  normalizeTags,
  serverFormSchema
} from '../shared/schemas'

describe('serverFormSchema', () => {
  const valid = {
    name: 'web-prod',
    host: '10.0.0.1',
    port: 22,
    username: 'deploy',
    password: 'pw',
    tags: [],
    notes: '',
    elevate: { enabled: false, preset: 'sudo -s', customCommand: '', passwordMode: 'same', customPassword: '' }
  }

  it('accepts a valid form', () => {
    expect(serverFormSchema.safeParse(valid).success).toBe(true)
  })

  it('accepts hostnames, IPv4 and IPv6 literals', () => {
    for (const host of ['server.example.com', '10.0.0.1', '2001:db8::1', '[2001:db8::1]']) {
      expect(isValidHost(host)).toBe(true)
    }
    expect(isValidHost('bad host!')).toBe(false)
  })

  it('rejects custom elevation that does not start with sudo', () => {
    const res = serverFormSchema.safeParse({
      ...valid,
      elevate: { ...valid.elevate, enabled: true, preset: 'custom', customCommand: 'su -' }
    })
    expect(res.success).toBe(false)
  })

  it('rejects custom elevation containing ";" (would break the echo guard)', () => {
    const res = serverFormSchema.safeParse({
      ...valid,
      elevate: {
        ...valid.elevate,
        enabled: true,
        preset: 'custom',
        customCommand: 'sudo -s; rm -rf /'
      }
    })
    expect(res.success).toBe(false)
  })

  it('rejects out-of-range ports', () => {
    expect(serverFormSchema.safeParse({ ...valid, port: 0 }).success).toBe(false)
    expect(serverFormSchema.safeParse({ ...valid, port: 70000 }).success).toBe(false)
  })

  it('allows empty secrets in the schema (edit mode "keep stored value")', () => {
    const res = serverFormSchema.safeParse({
      ...valid,
      password: '',
      elevate: { ...valid.elevate, enabled: true, passwordMode: 'custom', customPassword: '' }
    })
    // The "custom sudo password required" rule is enforced at submit time for
    // NEW servers only; schema stays permissive for edit mode.
    expect(res.success).toBe(true)
  })
})

describe('normalizeTags', () => {
  it('trims, drops empties, dedupes case-insensitively, caps at 12', () => {
    expect(normalizeTags([' Prod ', 'prod', '', 'web'])).toEqual(['Prod', 'web'])
    expect(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(12)
  })
})

describe('generatePassword (PTY-safe)', () => {
  it('never produces leading/trailing specials or control chars', () => {
    for (let i = 0; i < 500; i++) {
      const pw = generatePassword()
      expect(pw).toMatch(/^[A-Za-z0-9][A-Za-z0-9@#%*+=?_-]*[A-Za-z0-9]$/)
      expect(pw.length).toBe(20)
    }
  })
})

describe('masterPasswordIssues', () => {
  it('lists all issues for weak passwords and none for strong ones', () => {
    expect(masterPasswordIssues('short')).toHaveLength(3)
    expect(masterPasswordIssues('Str0ngPassphrase')).toHaveLength(0)
  })
})
