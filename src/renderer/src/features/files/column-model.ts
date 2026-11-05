/**
 * Pure column model for the Files panel — no JSX so it can be unit-tested in
 * the node project.
 *
 * The bug this guards against: Name was `flex-1` while Mode/Size/Modified had
 * fixed widths totalling ~240px inside a 360px panel, leaving Name ~60px. Every
 * filename then rendered as one character plus an ellipsis.
 */

export type ColumnKey = 'name' | 'mode' | 'size' | 'modified'

export interface ColumnDef {
  key: ColumnKey
  label: string
  /** Pixels when visible and not user-resized. */
  defaultWidth: number
  /** Minimum width a manual resize may reach. */
  minWidth: number
  /** Name flexes to fill leftover space; the others are fixed. */
  flexible?: boolean
  align: 'left' | 'right'
}

export const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', defaultWidth: 160, minWidth: 80, flexible: true, align: 'left' },
  { key: 'mode', label: 'Mode', defaultWidth: 88, minWidth: 60, align: 'right' },
  { key: 'size', label: 'Size', defaultWidth: 60, minWidth: 44, align: 'right' },
  { key: 'modified', label: 'Modified', defaultWidth: 84, minWidth: 60, align: 'right' }
]

export interface ColumnState {
  visible: Record<ColumnKey, boolean>
  /** Explicit widths from user drags; absent = use default. */
  widths: Partial<Record<ColumnKey, number>>
}

/** Mode is hidden by default: widest column, least often needed. */
export const DEFAULT_COLUMN_STATE: ColumnState = {
  visible: { name: true, mode: false, size: true, modified: true },
  widths: {}
}

/** Clamps a requested width to the column's minimum. */
export function clampWidth(key: ColumnKey, requested: number): number {
  const min = COLUMNS.find((c) => c.key === key)?.minWidth ?? 50
  return Math.max(min, Math.round(requested))
}

/**
 * Toggles a column, refusing to hide the last visible one (an empty list with
 * no columns would be unreadable and unrecoverable without the menu).
 */
export function toggleColumnState(state: ColumnState, key: ColumnKey): ColumnState {
  const shownElsewhere = COLUMNS.filter((c) => c.key !== key && state.visible[c.key]).length
  if (state.visible[key] && shownElsewhere === 0) return state
  return { ...state, visible: { ...state.visible, [key]: !state.visible[key] } }
}

export function widthOfState(state: ColumnState, key: ColumnKey): number {
  return state.widths[key] ?? COLUMNS.find((c) => c.key === key)?.defaultWidth ?? 80
}
