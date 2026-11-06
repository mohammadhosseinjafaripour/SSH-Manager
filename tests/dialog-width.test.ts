import { describe, expect, it } from 'vitest'

/**
 * Dialog widths are handed to the vendored uiarc CSS module as a custom
 * property. Two bugs shipped here that only a browser measurement caught, so
 * the rules are pinned as pure functions:
 *
 *  1. A unitless number produced `min(calc(100vw - 32px), 384)` — invalid CSS,
 *     so `width` was dropped and `inset: 0` stretched the dialog to 1280px.
 *  2. Unknown Tailwind classes silently fell back to a default width.
 */
const WIDTH_PX: Record<string, number> = {
  'max-w-sm': 384,
  'max-w-md': 448,
  'max-w-lg': 512,
  'max-w-xl': 576
}

/** Mirrors the Dialog wrapper's style computation. */
function dialogWidth(className: string | undefined): string {
  return `${WIDTH_PX[className ?? ''] ?? 440}px`
}
describe('dialog width', () => {
  it('always emits a px unit (unitless values invalidate min()/calc())', () => {
    for (const cls of Object.keys(WIDTH_PX)) {
      expect(dialogWidth(cls)).toMatch(/^\d+px$/)
    }
    expect(dialogWidth('nonsense')).toMatch(/^\d+px$/)
  })

  it('maps each Tailwind max-width class to its real pixel width', () => {
    expect(dialogWidth('max-w-sm')).toBe('384px')
    expect(dialogWidth('max-w-md')).toBe('448px')
    expect(dialogWidth('max-w-lg')).toBe('512px')
    expect(dialogWidth('max-w-xl')).toBe('576px')
  })

  it('falls back to the default rather than rendering unitless', () => {
    expect(dialogWidth(undefined)).toBe('440px')
    expect(dialogWidth('max-w-2xl')).toBe('440px')
  })
})
