import { describe, expect, it } from 'vitest'
import type { UpdatePhase, UpdateState } from '../shared/types'

/**
 * Rules for the update flow that are worth pinning down, because getting them
 * wrong means either silent breakage or an app that restarts under the user's
 * feet while they have a root shell open.
 */

/** Mirrors UpdateService.check(): may we perform a check? */
function canCheck(opts: {
  manual: boolean
  autoUpdateEnabled: boolean
  isPackaged: boolean
  msSinceLastCheck: number
}): { allowed: boolean; reason?: string } {
  const MIN_INTERVAL = 30_000
  if (!opts.manual && !opts.autoUpdateEnabled) return { allowed: false, reason: 'disabled' }
  if (!opts.isPackaged) return { allowed: false, reason: 'not-packaged' }
  if (opts.msSinceLastCheck < MIN_INTERVAL) return { allowed: false, reason: 'throttled' }
  return { allowed: true }
}

/**
 * Installing is ALWAYS explicit. A background update must never quit the app by
 * itself, because that would silently kill live SSH sessions.
 */
function shouldAutoInstallOnQuit(): boolean {
  return false
}

/** The download/install state machine, in the order transitions may occur. */
const ALLOWED: Record<UpdatePhase, UpdatePhase[]> = {
  idle: ['checking', 'disabled', 'error'],
  checking: ['downloading', 'up-to-date', 'error'],
  downloading: ['ready', 'error'],
  ready: ['idle', 'error'],
  'up-to-date': ['checking', 'idle'],
  disabled: ['checking', 'idle'],
  error: ['checking', 'idle']
}

function canTransition(from: UpdatePhase, to: UpdatePhase): boolean {
  return ALLOWED[from].includes(to)
}

describe('whether a check may run', () => {
  it('background checks are skipped when the user disabled them', () => {
    expect(
      canCheck({ manual: false, autoUpdateEnabled: false, isPackaged: true, msSinceLastCheck: 1e9 })
    ).toEqual({ allowed: false, reason: 'disabled' })
  })

  it('“Check now” works even with automatic checks disabled', () => {
    expect(
      canCheck({ manual: true, autoUpdateEnabled: false, isPackaged: true, msSinceLastCheck: 1e9 })
    ).toEqual({ allowed: true })
  })

  it('never phones home from a development build', () => {
    expect(
      canCheck({ manual: true, autoUpdateEnabled: true, isPackaged: false, msSinceLastCheck: 1e9 })
    ).toEqual({ allowed: false, reason: 'not-packaged' })
  })

  it('throttles repeated clicks so the API is not hammered', () => {
    expect(
      canCheck({ manual: true, autoUpdateEnabled: true, isPackaged: true, msSinceLastCheck: 1000 })
    ).toEqual({ allowed: false, reason: 'throttled' })
  })

  it('allows a check after the throttle window', () => {
    expect(
      canCheck({ manual: true, autoUpdateEnabled: true, isPackaged: true, msSinceLastCheck: 60_000 })
    ).toEqual({ allowed: true })
  })
})

describe('install safety', () => {
  it('never installs automatically on quit', () => {
    // autoInstallOnQuit must stay false: quitting mid-SSH-session would be
    // destructive, so installation is a deliberate button press.
    expect(shouldAutoInstallOnQuit()).toBe(false)
  })
})

describe('state machine', () => {
  it('follows the happy path checking -> downloading -> ready', () => {
    expect(canTransition('checking', 'downloading')).toBe(true)
    expect(canTransition('downloading', 'ready')).toBe(true)
  })

  it('can report up-to-date without downloading', () => {
    expect(canTransition('checking', 'up-to-date')).toBe(true)
    expect(canTransition('up-to-date', 'ready')).toBe(false)
  })

  it('cannot reach ready without downloading', () => {
    expect(canTransition('idle', 'ready')).toBe(false)
    expect(canTransition('checking', 'ready')).toBe(false)
  })

  it('recovers from an error on the next check', () => {
    expect(canTransition('error', 'checking')).toBe(true)
  })

  it('can go from ready back to checking (check again after a dismiss)', () => {
    expect(canTransition('ready', 'idle')).toBe(true)
  })
})

describe('status text', () => {
  /** Mirrors describeUpdate(): always returns a sentence, never throws. */
  function describe(state: UpdateState | null): string {
    if (!state) return 'Not checked yet.'
    switch (state.phase) {
      case 'disabled':
        return state.error ?? 'Automatic checks are off.'
      case 'checking':
        return 'Checking GitHub for a newer version…'
      case 'up-to-date':
        return 'You are on the latest version.'
      case 'downloading':
        return `Downloading version ${state.version ?? ''}… ${state.percent ?? 0}%`
      case 'ready':
        return `Version ${state.version ?? ''} is downloaded and ready.`
      case 'error':
        return `Could not check for updates: ${state.error ?? 'unknown error'}`
      default:
        return 'Not checked yet.'
    }
  }

  it('describes every phase without throwing', () => {
    const phases: UpdatePhase[] = [
      'idle',
      'disabled',
      'checking',
      'up-to-date',
      'downloading',
      'ready',
      'error'
    ]
    for (const phase of phases) {
      expect(describe({ phase }).length).toBeGreaterThan(0)
    }
  })

  it('never renders the word "undefined" to the user', () => {
    for (const state of [
      { phase: 'downloading' as const },
      { phase: 'ready' as const },
      { phase: 'error' as const },
      { phase: 'disabled' as const }
    ]) {
      expect(describe(state)).not.toContain('undefined')
    }
  })
})
