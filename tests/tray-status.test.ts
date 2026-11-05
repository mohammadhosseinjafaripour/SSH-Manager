import { describe, expect, it } from 'vitest'
import { isLiveSessionStatus } from '../shared/session-status'
import type { SessionStatus } from '../shared/types'

describe('tray keep-alive predicate', () => {
  it('treats connected, connecting and elevated states as live', () => {
    const live: SessionStatus[] = ['connected', 'connecting', 'reconnecting', 'elevated', 'elevated-unverified', 'elevated-no-prompt', 'elevate-failed']
    for (const s of live) {
      expect(isLiveSessionStatus(s)).toBe(true)
    }
  })

  it('treats closed, failed and hostkey-blocked states as not live', () => {
    const dead: SessionStatus[] = ['closed', 'error', 'auth-failed', 'hostkey-unknown', 'hostkey-changed']
    for (const s of dead) {
      expect(isLiveSessionStatus(s)).toBe(false)
    }
  })

  it('a hostkey prompt is not worth keeping the app alive for', () => {
    // Closing the app there loses nothing — no shell was ever established.
    expect(isLiveSessionStatus('hostkey-unknown')).toBe(false)
  })
})
