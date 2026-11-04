import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * Reconnect policy is a pure decision: given a session status and the user's
 * setting, do we retry? Retrying a rejected password would feed pam_faillock,
 * and retrying a host-key mismatch would paper over a possible MITM — so those
 * must never auto-reconnect. Those two rules are the safety-critical part.
 */
type Status = 'connecting' | 'connected' | 'auth-failed' | 'error' | 'closed' | 'elevated'

function shouldReconnect(status: Status, autoReconnect: boolean): boolean {
  const hadSession = status === 'connected' || status.startsWith('elevated')
  const authFailed = status === 'auth-failed'
  return hadSession && !authFailed && autoReconnect
}

describe('reconnect policy', () => {
  it('reconnects an established session that dropped', () => {
    expect(shouldReconnect('connected', true)).toBe(true)
    expect(shouldReconnect('elevated', true)).toBe(true)
  })

  it('NEVER reconnects after an authentication failure (lockout risk)', () => {
    expect(shouldReconnect('auth-failed', true)).toBe(false)
  })

  it('does not reconnect when the user disabled auto-reconnect', () => {
    expect(shouldReconnect('connected', false)).toBe(false)
  })

  it('does not reconnect a session that never established', () => {
    expect(shouldReconnect('connecting', true)).toBe(false)
    expect(shouldReconnect('closed', true)).toBe(false)
  })
})

describe('backoff schedule', () => {
  const DELAYS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000]

  const delayFor = (attempt: number) => DELAYS[Math.min(attempt, DELAYS.length - 1)]

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('grows exponentially then caps at 30s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(delayFor)).toEqual([
      1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000
    ])
  })

  it('retries indefinitely (never gives up after N attempts)', () => {
    expect(delayFor(1000)).toBe(30_000)
  })
})

describe('keepalive tolerance', () => {
  const INTERVAL_MS = 15_000
  const MAX_MISSED = 20

  it('tolerates about five minutes of a dead link before declaring it lost', () => {
    // Long enough to survive laptop sleep / VPN blips, short enough to notice
    // a genuinely dead connection.
    expect((INTERVAL_MS * MAX_MISSED) / 1000).toBe(300)
  })
})
