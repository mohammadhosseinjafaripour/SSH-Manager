import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  ElevateDetector,
  buildElevateLine,
  makeNonce,
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
  it('injects -S -k -p marker into presets', () => {
    const nonce = makeNonce()
    expect(buildElevateLine('sudo -s', '', nonce)).toBe(
      `stty -echo; sudo -S -k -p '[SSHVAULT:${nonce}]' -s; stty echo`
    )
    expect(buildElevateLine('sudo -i', '', nonce)).toContain(`' -i;`)
    expect(buildElevateLine('sudo su -', '', nonce)).toContain(`]' su -;`)
  })

  it('supports custom sudo commands', () => {
    const nonce = makeNonce()
    const line = buildElevateLine('custom', 'sudo -u admin -s', nonce)
    expect(line).toBe(`stty -echo; sudo -S -k -p '[SSHVAULT:${nonce}]' -u admin -s; stty echo`)
  })

  it('contains no secrets and restores echo at the end', () => {
    const line = buildElevateLine('sudo -s', '', makeNonce())
    expect(line.endsWith('; stty echo')).toBe(true)
    expect(line.startsWith('stty -echo;')).toBe(true)
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
