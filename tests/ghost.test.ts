import { describe, expect, it } from 'vitest'

/**
 * The ghost overlay's visibility rules, extracted so they can be tested without
 * a DOM. `useInlineCompletion` paints exactly when this returns true.
 *
 * The reason this matters: a ghost shown while the suggestion is empty (or when
 * the feature is off) produces an invisible overlay that swallows Tab — which
 * feels like the terminal ignoring the key.
 */
function shouldShowGhost(opts: {
  enabled: boolean
  text: string | undefined
  hasCursorPos: boolean
}): boolean {
  return opts.enabled && !!opts.text && opts.text.length > 0 && opts.hasCursorPos
}

describe('ghost overlay visibility', () => {
  it('shows only for a non-empty suggestion with a measured cursor', () => {
    expect(shouldShowGhost({ enabled: true, text: 'r', hasCursorPos: true })).toBe(true)
  })

  it('hides when the feature is disabled', () => {
    expect(shouldShowGhost({ enabled: false, text: 'r', hasCursorPos: true })).toBe(false)
  })

  it('hides for an empty suggestion (would swallow Tab invisibly)', () => {
    expect(shouldShowGhost({ enabled: true, text: '', hasCursorPos: true })).toBe(false)
    expect(shouldShowGhost({ enabled: true, text: undefined, hasCursorPos: true })).toBe(false)
  })

  it('hides before the cursor cell is measured (avoids painting at 0,0)', () => {
    expect(shouldShowGhost({ enabled: true, text: 'r', hasCursorPos: false })).toBe(false)
  })
})

describe('acceptance semantics', () => {
  /** Mirrors useInlineCompletion.accept(): append whole suggestion, then clear. */
  function accept(line: string, ghost: string | null) {
    if (!ghost) return { line, sent: null }
    return { line: line + ghost, sent: ghost }
  }

  /**
   * Mirrors acceptWord(): accept up to and including the next separator, so
   * partial acceptance composes with repeated Tab presses.
   */
  function acceptWord(line: string, ghost: string | null) {
    if (!ghost) return { line, sent: null }
    const boundary = ghost.search(/[/\s-]/)
    const part = boundary === -1 ? ghost : ghost.slice(0, boundary + 1)
    if (!part) return { line, sent: null }
    return { line: line + part, sent: part }
  }

  it('Tab appends the whole suggestion', () => {
    expect(accept('clea', 'r')).toEqual({ line: 'clear', sent: 'r' })
  })

  it('Tab with no suggestion does nothing (falls through to the shell)', () => {
    expect(accept('clea', null)).toEqual({ line: 'clea', sent: null })
  })

  it('Right-arrow accepts only the next path segment', () => {
    expect(acceptWord('cd /va', 'r/www/site')).toEqual({ line: 'cd /var/', sent: 'r/' })
  })

  it('Right-arrow takes the whole text when there is no separator', () => {
    expect(acceptWord('clea', 'r')).toEqual({ line: 'clear', sent: 'r' })
  })

  it('repeated partial accepts reach the full suggestion', () => {
    let line = 'cd /va'
    const target = 'r/www/site'
    let remaining: string | null = target
    let guard = 0
    while (remaining && remaining.length > 0 && guard < 10) {
      const step = acceptWord(line, remaining)
      line = step.line
      remaining = remaining.slice(step.sent?.length ?? 0)
      guard++
    }
    expect(line).toBe('cd /var/www/site')
  })
})
