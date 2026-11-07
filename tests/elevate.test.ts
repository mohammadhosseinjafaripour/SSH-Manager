import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  ElevateDetector,
  buildElevateLine,
  makeNonce,
  stripAnsi,
  type ElevateStatus
} from '../src/main/ssh/elevate'

interface Recorded {
  sends: number
  statuses: Array<{ status: ElevateStatus; detail?: string }>
}

function makeDetector(nonce: string): { detector: ElevateDetector; rec: Recorded } {
  const rec: Recorded = { sends: 0, statuses: [] }
  const detector = new ElevateDetector(nonce, {
    onSendPassword: () => {
      rec.sends++
    },
    onStatus: (status, detail) => rec.statuses.push({ status, detail })
  })
  return { detector, rec }
}

const marker = (nonce: string) => `[SSHVAULT:${nonce}]`

describe('buildElevateLine', () => {
  it('lets sudo own the terminal: no -S, no stty', () => {
    const nonce = makeNonce()
    const line = buildElevateLine('sudo -s', '', nonce)
    expect(line).toBe(`sudo -k -p '[SSHVAULT:${nonce}]' -s`)
    // `-S` reads the password from stdin, which forces the caller to manage
    // terminal echo by hand. sudo reading from the TTY turns echo off itself
    // and restores it before the root shell starts — no app-side write, so
    // nothing can race the user's typing.
    expect(line).not.toContain('-S')
    expect(line).not.toContain('stty')
  })

  it('uses exactly ONE sudo invocation (no ticket-cache dependency)', () => {
    const line = buildElevateLine('sudo -s', '', makeNonce())
    expect(line.match(/\bsudo\b/g)).toHaveLength(1)
    // The old two-phase design (`sudo -v` then `sudo -s`) prompted twice on
    // servers with timestamp_timeout=0, which never cache a ticket.
    expect(line).not.toContain('-v')
  })

  it('injects the marker into every preset', () => {
    const nonce = makeNonce()
    expect(buildElevateLine('sudo -i', '', nonce)).toContain(`]' -i`)
    expect(buildElevateLine('sudo su -', '', nonce)).toContain(`]' su -`)
  })

  it('supports custom sudo commands', () => {
    const nonce = makeNonce()
    expect(buildElevateLine('custom', 'sudo -u admin -s', nonce)).toBe(
      `sudo -k -p '[SSHVAULT:${nonce}]' -u admin -s`
    )
  })

  it('REGRESSION: never writes anything into the shell after elevation', () => {
    // The 0.6.4 "onShellReady" handler wrote `stty echo\r` into the live root
    // shell. If the user was already typing, that write landed mid-line and the
    // `\r` submitted their half-typed command — reported as
    // "nvalid: command not found" plus a stray bash continuation prompt.
    const line = buildElevateLine('sudo -s', '', makeNonce())
    // Only the password (written on the marked prompt) ever goes to the PTY.
    expect(line.endsWith('-s')).toBe(true)
    expect(line).not.toMatch(/stty|echo\s*$/)
  })
})

describe('ElevateDetector invariants', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('INVARIANT: sends the password exactly once, on exact bare-marker match', () => {
    const nonce = 'abc123'
    const { detector, rec } = makeDetector(nonce)
    detector.feed(`some banner text\r\n${marker(nonce)} `)
    expect(rec.sends).toBe(1)
    detector.feed(`${marker(nonce)} again\r\n`)
    expect(rec.sends).toBe(1)
    detector.dispose()
  })

  it('INVARIANT: never reacts to the echoed command line (marker in quotes)', () => {
    const nonce = 'abc123'
    const { detector, rec } = makeDetector(nonce)
    // This is exactly what the PTY echoes back for the command we typed:
    detector.feed(`stty -echo; sudo -S -k -p '[SSHVAULT:${nonce}]' -s; stty echo\r\n`)
    vi.advanceTimersByTime(60_000)
    expect(rec.sends).toBe(0)
    detector.dispose()
  })

  it('matches a marker split across chunks (once)', () => {
    const nonce = 'deadbe'
    const { detector, rec } = makeDetector(nonce)
    detector.feed(`welcome\r\n[SSHVA`)
    detector.feed(`ULT:${nonce}]`)
    expect(rec.sends).toBe(1)
    detector.dispose()
  })

  it('INVARIANT: no marker ever → no send, even after long inactivity (NOPASSWD)', () => {
    const nonce = 'abc123'
    const { detector, rec } = makeDetector(nonce)
    detector.feed('Welcome to Ubuntu 24.04\r\nroot@host:~# ')
    vi.advanceTimersByTime(120_000)
    detector.feed('more output without any prompt\r\n')
    expect(rec.sends).toBe(0)
    expect(rec.statuses).toEqual([
      { status: 'elevated-no-prompt', detail: expect.any(String) }
    ])
    detector.dispose()
  })

  it('slow LDAP: marker arriving AFTER the no-prompt report still gets its password', () => {
    const nonce = 'abc123'
    const { detector, rec } = makeDetector(nonce)
    detector.feed('welcome\r\n')
    vi.advanceTimersByTime(10_000) // no-prompt reported
    expect(rec.sends).toBe(0)
    detector.feed(`${marker(nonce)} `) // prompt finally arrives
    expect(rec.sends).toBe(1) // display-only timer made no write; detector still armed
    detector.dispose()
  })

  it('REGRESSION: an UNMARKED second sudo prompt is never answered', () => {
    // What timestamp_timeout=0 used to produce with the old two-phase line:
    // phase 1 prompts with our marker, then phase 2 (`sudo -s`) prompts again
    // in sudo's own format. The user saw the app "asking password again".
    // The line is single-invocation now, so this must never happen — and if a
    // server ever emits an unmarked prompt, the app must not write a secret to
    // it (it could be any program asking for input).
    const nonce = 'abc123'
    const { detector, rec } = makeDetector(nonce)
    detector.feed(`${marker(nonce)} `)
    expect(rec.sends).toBe(1)
    // sudo's own prompt formats, none carrying our nonce
    detector.feed('\r\n[sudo: authenticate] Password: ')
    detector.feed('\r\n[sudo] password for ubuntu: ')
    vi.advanceTimersByTime(60_000)
    expect(rec.sends).toBe(1) // exactly one write, ever
    detector.dispose()
  })

  it('wrong password: sudo failure string settles failed, never re-sends', () => {
    const nonce = 'abc123'
    const { detector, rec } = makeDetector(nonce)
    detector.feed(`${marker(nonce)} `)
    expect(rec.sends).toBe(1)
    detector.feed(`${marker(nonce)} sorry, try again\r\n`)
    detector.feed(`${marker(nonce)} `)
    expect(rec.sends).toBe(1)
    expect(rec.statuses.at(-1)?.status).toBe('elevate-failed')
    detector.dispose()
  })

  it('sudo lecture before the prompt does not break matching', () => {
    const nonce = 'cafe00'
    const { detector, rec } = makeDetector(nonce)
    detector.feed(
      'We trust you have received the usual lecture from the local System\r\nAdministrator.\r\n'
    )
    detector.feed(`${marker(nonce)} `)
    expect(rec.sends).toBe(1)
    detector.dispose()
  })

  it.each([
    ['not in the sudoers file.  This incident will be reported.', 'sudoers'],
    ['sudo: command not found', 'not installed'],
    ['sudo: 1 incorrect password attempt', 'rejected'],
    ['sudo: no password was provided', 'no password']
  ])('failure string %j → elevate-failed', (text: string) => {
    const { detector, rec } = makeDetector('abc123')
    detector.feed(`user@host:~$ \r\n${text}\r\n`)
    expect(rec.sends).toBe(0)
    expect(rec.statuses.at(-1)?.status).toBe('elevate-failed')
    detector.dispose()
  })

  it('root prompt after send proves elevation', () => {
    const nonce = 'abc123'
    const { detector, rec } = makeDetector(nonce)
    detector.feed(`${marker(nonce)} `)
    detector.feed('\r\nroot@webprod:~# ')
    expect(rec.statuses.at(-1)?.status).toBe('elevated')
    detector.dispose()
  })

  it('REGRESSION: recognises a COLOURED root prompt (ANSI codes after the #)', () => {
    // A themed PS1 puts the reset sequence after the `#`, so a regex anchored
    // on `#\s*$` never matched and the status stayed at "unverified".
    const nonce = 'abc123'
    const { detector, rec } = makeDetector(nonce)
    detector.feed(`${marker(nonce)} `)
    detector.feed('\r\n\x1b[38;5;2mroot@traefikrsv\x1b[0m:\x1b[34m/home/ubuntu\x1b[0m# \x1b[0m')
    expect(rec.statuses.at(-1)?.status).toBe('elevated')
    detector.dispose()
  })

  it('stripAnsi removes CSI and OSC sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text')
    expect(stripAnsi('plain')).toBe('plain')
  })


  it('no definitive result after send → elevated-unverified (display only)', () => {
    const nonce = 'abc123'
    const { detector, rec } = makeDetector(nonce)
    detector.feed(`${marker(nonce)} `)
    vi.advanceTimersByTime(5_000)
    expect(rec.sends).toBe(1)
    expect(rec.statuses.at(-1)?.status).toBe('elevated-unverified')
    detector.dispose()
  })

  it('single huge chunk: bare marker at its head still fires (no trim loss)', () => {
    const nonce = 'abc123'
    const { detector, rec } = makeDetector(nonce)
    detector.feed(`${marker(nonce)} `.padEnd(4_000, 'x'))
    expect(rec.sends).toBe(1)
    detector.dispose()
  })

  it('quoted marker stays inert even after the window has moved past it', () => {
    const nonce = 'abc123'
    const { detector, rec } = makeDetector(nonce)
    detector.feed(`echo '[SSHVAULT:${nonce}]'\r\n`)
    detector.feed('x'.repeat(4_000))
    expect(rec.sends).toBe(0)
    detector.dispose()
  })
})
