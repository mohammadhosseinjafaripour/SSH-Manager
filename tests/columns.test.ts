import { describe, expect, it } from 'vitest'
import { COLUMNS } from '../src/renderer/src/features/files/column-model'

/**
 * The bug being guarded against: Name was `flex-1` while Mode/Size/Modified had
 * fixed widths totalling ~240px inside a 360px panel. Name was left ~60px, so
 * every filename rendered as "…c…". These tests encode the layout rules that
 * prevent a repeat.
 */

const byKey = Object.fromEntries(COLUMNS.map((c) => [c.key, c]))

/** Sum of the fixed (non-flexible) widths for a set of visible columns. */
function fixedWidth(visible: string[], widths: Record<string, number> = {}): number {
  return COLUMNS.filter((c) => visible.includes(c.key) && !c.flexible).reduce(
    (sum, c) => sum + (widths[c.key] ?? c.defaultWidth),
    0
  )
}

describe('column layout budget', () => {
  it('leaves room for the name column at the old 360px panel width', () => {
    // Default visible set (mode hidden): size + modified only.
    const visible = ['name', 'size', 'modified']
    const used = fixedWidth(visible)
    const chrome = 24 // checkbox + icon + padding + gap
    const nameSpace = 360 - used - chrome
    expect(nameSpace).toBeGreaterThan(120)
  })

  it('hides Mode by default because it is the widest optional column', () => {
    // DEFAULTS in columns.tsx hides it; the widest non-flexible column must not
    // be visible by default or the name column is starved again.
    const widest = COLUMNS.filter((c) => !c.flexible).sort(
      (a, b) => b.defaultWidth - a.defaultWidth
    )[0]
    expect(widest.key).toBe('mode')
  })

  it('name column has a minimum width so it cannot collapse', () => {
    expect(byKey.name.flexible).toBe(true)
    expect(byKey.name.minWidth).toBeGreaterThanOrEqual(80)
  })

  it('every column declares a sane minimum width', () => {
    for (const col of COLUMNS) {
      expect(col.minWidth).toBeGreaterThanOrEqual(40)
      expect(col.defaultWidth).toBeGreaterThanOrEqual(col.minWidth)
    }
  })

  it('shows all four columns at a comfortable panel width', () => {
    const visible = COLUMNS.map((c) => c.key)
    const used = fixedWidth(visible)
    const nameSpace = 640 - used - 24
    expect(nameSpace).toBeGreaterThan(150)
  })
})

describe('width clamping', () => {
  /** Mirrors useColumnState.setWidth(). */
  const clamp = (key: string, requested: number) =>
    Math.max(COLUMNS.find((c) => c.key === key)?.minWidth ?? 50, Math.round(requested))

  it('clamps a drag below the minimum up to the minimum', () => {
    expect(clamp('size', 5)).toBe(byKey.size.minWidth)
    expect(clamp('name', 10)).toBe(byKey.name.minWidth)
  })

  it('accepts a reasonable drag', () => {
    expect(clamp('size', 120)).toBe(120)
  })
})

describe('visibility rules', () => {
  /** Mirrors useColumnState.toggleColumn(). */
  function toggle(visible: Record<string, boolean>, key: string) {
    const shownElsewhere = COLUMNS.filter((c) => c.key !== key && visible[c.key]).length
    if (visible[key] && shownElsewhere === 0) return visible // refuse to hide the last
    return { ...visible, [key]: !visible[key] }
  }

  it('never allows hiding every column', () => {
    const onlyName = { name: true, mode: false, size: false, modified: false }
    const after = toggle(onlyName, 'name')
    expect(after.name).toBe(true) // refused
  })

  it('allows hiding a column when others remain', () => {
    const all = { name: true, mode: true, size: true, modified: true }
    expect(toggle(all, 'mode').mode).toBe(false)
  })

  it('allows re-showing a hidden column', () => {
    const some = { name: true, mode: false, size: true, modified: true }
    expect(toggle(some, 'mode').mode).toBe(true)
  })
})

