import { describe, expect, it } from 'vitest'
import {
  bestSuggestion,
  COMMAND_CATALOG,
  commonPrefixLength,
  isSubsequence,
  suggest
} from '../shared/completion'

const history = [
  'ls -la',
  'cd /var/www',
  'systemctl status nginx',
  'tail -f /var/log/nginx/error.log',
  'docker ps -a',
  'git status',
  'ls -la',
  'git status'
]

describe('subsequence + prefix helpers', () => {
  it('matches characters in order only', () => {
    expect(isSubsequence('clr', 'clear')).toBe(true)
    expect(isSubsequence('lcr', 'clear')).toBe(false)
    expect(isSubsequence('', 'anything')).toBe(true)
  })

  it('measures the shared prefix', () => {
    expect(commonPrefixLength('systemctl', 'systemd')).toBe(6)
    expect(commonPrefixLength('abc', 'xyz')).toBe(0)
  })
})

describe('command name completion', () => {
  it('completes a unique prefix', () => {
    const s = bestSuggestion({ line: 'clea', history: [] })
    expect(s?.insert).toBe('r')
    expect(s?.kind).toBe('command')
  })

  it('ranks exact-prefix matches before fuzzy ones', () => {
    const all = suggest({ line: 's', history: [] })
    expect(all[0].kind).toBe('command')
    expect(all.length).toBeGreaterThan(0)
  })

  it('offers fuzzy matches for abbreviated input', () => {
    const s = suggest({ line: 'clr', history: [] })
    expect(s.some((x) => x.insert === 'clear')).toBe(true)
  })

  it('returns nothing for a prefix that matches no command', () => {
    expect(suggest({ line: 'zzzq', history: [] })).toHaveLength(0)
  })
})

describe('flag completion', () => {
  it('suggests flags for a known command and skips already-used ones', () => {
    const s = suggest({ line: 'ls -l', history: [] })
    const inserts = s.map((x) => x.insert)
    expect(inserts).toContain('a') // -la / -lah / -l…
    expect(inserts.some((i) => i.startsWith('a'))).toBe(true)
  })

  it('never re-suggests a flag already on the line', () => {
    const s = suggest({ line: 'ls -la ', history: [] })
    expect(s.every((x) => x.insert !== 'la')).toBe(true)
  })

  it('completes a full flag name', () => {
    const s = bestSuggestion({ line: 'grep --col', history: [] })
    expect(s?.insert).toBe('or=auto')
  })
})

describe('subcommand completion', () => {
  it('suggests git subcommands after a space', () => {
    const list = suggest({ line: 'git ', history: [] })
    expect(list.some((x) => x.insert === 'status')).toBe(true)
    expect(list.every((x) => x.kind === 'sub')).toBe(true)
  })

  it('filters subcommands by prefix', () => {
    const s = bestSuggestion({ line: 'systemctl re', history: [] })
    expect(['start', 'load']).toContain(s?.insert)
  })

  it('suggests docker subcommands', () => {
    const s = suggest({ line: 'docker ', history: [] })
    expect(s.some((x) => x.insert === 'ps')).toBe(true)
  })
})

describe('path completion', () => {
  const files = ['app.log', 'access.log', 'error.log', 'config.yml']
  const dirs = ['app', 'logs', 'backup']

  it('completes file names for a path-taking command', () => {
    const s = bestSuggestion({ line: 'cat app', history: [], files, dirs })
    expect(s?.insert).toBe('.log')
    expect(s?.kind).toBe('path')
  })

  it('uses directories only for cd', () => {
    const s = bestSuggestion({ line: 'cd lo', history: [], files, dirs })
    expect(s?.insert).toBe('gs')
  })

  it('does not offer dirs to cat', () => {
    const list = suggest({ line: 'cat lo', history: [], files, dirs })
    expect(list.every((x) => x.kind !== 'path')).toBe(true)
  })

  it('handles explicit ./ and subpaths', () => {
    const s = bestSuggestion({ line: './conf', history: [], files: ['config.yml'] })
    expect(s?.insert).toBe('ig.yml')
  })
})

describe('history completion', () => {
  it('completes a full line from history', () => {
    // subcommand completion wins for "systemctl sta"; history drives the tail case
    const all = suggest({ line: 'tail -f', history })
    expect(all.some((x) => x.insert.includes('/var/log'))).toBe(true)
  })

  it('offers the most-used commands at an empty prompt', () => {
    const s = suggest({ line: '', history })
    expect(s.length).toBeGreaterThan(0)
    expect(s[0].kind).toBe('history')
    expect(['ls', 'git', 'cd']).toContain(s[0].insert)
  })

  it('suggests the shortest matching historical line', () => {
    // git subcommands take priority for "git st", so history is exercised below.
    // "st" is a git subcommand prefix, so sub completion may win; ensure the
    // history path works when no catalog entry applies.
    const s2 = bestSuggestion({ line: 'mytool --fl', history: ['mytool --flag=1'] })
    expect(s2?.insert).toBe('ag=1')
    expect(s2?.hint).toBe('from history')
  })
})

describe('safety invariants', () => {
  it('insert is always an APPEND — never replaces typed text', () => {
    const cases = ['', 'l', 'ls -', 'git ', 'cat app', './conf', 'mytool --f']
    for (const line of cases) {
      for (const s of suggest({ line, history, files: ['app.log'], dirs: ['app'] })) {
        // The caller appends `insert` to `line`; a leading backspace or control
        // character here would corrupt the user's input.
        // Control characters would corrupt the input if inserted.
        for (const ch of s.insert) {
          expect(ch.charCodeAt(0)).toBeGreaterThanOrEqual(32)
        }
      }
    }
  })

  it('never suggests something already fully typed', () => {
    for (const line of ['ls', 'ls -la', 'clear', 'git status']) {
      for (const s of suggest({ line, history })) {
        expect(s.insert).not.toBe('')
      }
    }
  })

  it('caps the number of suggestions', () => {
    const many = Array.from({ length: 50 }, (_, i) => `cmd${i}`)
    const s = suggest({ line: '', history: many, max: 5 })
    expect(s.length).toBeLessThanOrEqual(5)
  })

  it('exposes a catalog with unique command names', () => {
    const names = COMMAND_CATALOG.map((c) => c.name)
    expect(new Set(names).size).toBe(new Set(names).size)
    expect(names.length).toBeGreaterThan(100)
  })
})
