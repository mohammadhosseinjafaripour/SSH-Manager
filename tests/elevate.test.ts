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
  shellReady: number
}

function makeDetector(nonce: string): { detector: ElevateDetector; rec: Recorded } {
  const rec: Recorded = { sends: 0, statuses: [], shellReady: 0 }
  const detector = new ElevateDetector(nonce, {
    onSendPassword: () => {
      rec.sends++
    },
    onStatus: (status, detail) => rec.statuses.push({ status, detail }),
    onShellReady: () => {
      rec.shellReady++
    }
  })
  return { detector, rec }
}

const marker = (nonce: string) => `[SSHVAULT:${nonce}]`

describe('buildElevateLine', () => {
  it('uses exactly ONE sudo invocation (no ticket-cache dependency)', () => {
    const nonce = makeNonce()
    const line = buildElevateLine('sudo -s', '', nonce)
    expect(line).toBe(`stty -echo; sudo -S -k -p '[SSHVAULT:${nonce}]' -s; stty echo`)
    // REGRESSION: the old design ran `sudo -v` and then a second `sudo`. On a
    // server with timestamp_timeout=0 ("always prompt") the ticket never
    // caches, so the second sudo prompted again with its own prompt format —
    // which the detector cannot answer, leaving the user typing the password.
    expect(line.match(/\bsudo\b/g)).toHaveLength(1)
    expect(line).not.toContain('-v')
  })

  it('injects the marker into every preset', () => {
    const nonce = makeNonce()
    expect(buildElevateLine('sudo -i', '', nonce)).toContain(`]' -i;`)
    expect(buildElevateLine('sudo su -', '', nonce)).toContain(`]' su -;`)
  })

  it('supports custom sudo commands', () => {
    const nonce = makeNonce()
    const line = buildElevateLine('custom', 'sudo -u admin -s', nonce)
    expect(line).toBe(`stty -echo; sudo -S -k -p '[SSHVAULT:${nonce}]' -u admin -s; stty echo`)
  })

  it('restores echo on BOTH success and failure (uses `;`, not `&&`)', () => {
    // `... sudo ...; stty echo` runs the restore whether sudo exits 0 or not.
    // With `&&` a failed sudo would leave echo off for the rest of the session.
    const line = buildElevateLine('sudo -s', '', makeNonce())
    expect(line).toContain(`]' -s; stty echo`)
    expect(line).not.toContain(`]' -s && stty echo`)
  })

  it('contains no secrets and keeps a trailing echo safety net', () => {
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

  describe('echo restore (onShellReady)', () => {
    // `sudo -s` runs a shell INSIDE sudo, so the trailing `; stty echo` in the
    // elevation line cannot execute until that shell exits. Echo therefore
    // stays off for the whole session: keys reach the shell and commands run,
    // but nothing is drawn. The session must be told when it is safe to send
    // `stty echo` into the root shell.

    it('REGRESSION: fires once after a root prompt, so echo can be restored', () => {
      const nonce = 'abc123'
      const { detector, rec } = makeDetector(nonce)
      detector.feed(`${marker(nonce)} `)
      expect(rec.shellReady).toBe(0) // not before the shell is proven
      detector.feed('\r\nroot@webprod:~# ')
      expect(rec.shellReady).toBe(1)
      detector.dispose()
    })

    it('fires only once even if more prompts arrive', () => {
      const nonce = 'abc123'
      const { detector, rec } = makeDetector(nonce)
      detector.feed(`${marker(nonce)} `)
      detector.feed('\r\nroot@webprod:~# ')
      detector.feed('ls\r\nfile.txt\r\nroot@webprod:~# ')
      detector.feed('\r\nroot@webprod:~# ')
      expect(rec.shellReady).toBe(1)
      detector.dispose()
    })

    it('SAFETY: never fires while sudo is still waiting for the password', () => {
      // Writing to sudo at this point would be read as a second password
      // attempt and feed pam_faillock.
      const nonce = 'abc123'
      const { detector, rec } = makeDetector(nonce)
      detector.feed('user@host:~$ ')
      expect(rec.shellReady).toBe(0)
      // Even a prompt-looking line before our marker appeared is not trusted.
      detector.feed('\r\n[sudo] password for user: ')
      vi.advanceTimersByTime(3_000)
      expect(rec.shellReady).toBe(0)
      expect(rec.sends).toBe(0)
      detector.dispose()
    })

    it('fires for NOPASSWD servers (no marker, shell prompt after the wait)', () => {
      const nonce = 'abc123'
      const { detector, rec } = makeDetector(nonce)
      // sudo never prompts; after the no-prompt window the shell is running
      // but echo is still off because the trailing command cannot have run.
      detector.feed('Welcome to Ubuntu\r\nroot@webprod:~# ')
      expect(rec.shellReady).toBe(0)
      vi.advanceTimersByTime(6_000)
      detector.feed('\r\nroot@webprod:~# ')
      expect(rec.shellReady).toBe(1)
      expect(rec.sends).toBe(0) // never wrote a password
      detector.dispose()
    })

    it('recognises a non-root prompt too (customised or non-elevated shell)', () => {
      const nonce = 'abc123'
      const { detector, rec } = makeDetector(nonce)
      detector.feed(`${marker(nonce)} `)
      detector.feed('\r\nubuntu@webprod:~$ ')
      expect(rec.shellReady).toBe(1)
      detector.dispose()
    })
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
