/**
 * React bindings for the Files-panel column model. The pure data and rules
 * live in ./column-model so they can be unit-tested without JSX.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  COLUMNS,
  DEFAULT_COLUMN_STATE,
  clampWidth,
  toggleColumnState,
  widthOfState,
  type ColumnKey,
  type ColumnState
} from './column-model'

export { COLUMNS }
export type { ColumnKey, ColumnState }

const STORAGE_KEY = 'sshvault-file-columns-v1'

function load(): ColumnState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_COLUMN_STATE
    const parsed = JSON.parse(raw) as Partial<ColumnState>
    return {
      visible: { ...DEFAULT_COLUMN_STATE.visible, ...(parsed.visible ?? {}) },
      widths: { ...(parsed.widths ?? {}) }
    }
  } catch {
    return DEFAULT_COLUMN_STATE
  }
}

export function useColumnState() {
  const [state, setState] = useState<ColumnState>(load)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // Storage unavailable: the layout simply will not persist.
    }
  }, [state])

  const toggleColumn = useCallback((key: ColumnKey) => {
    setState((s) => toggleColumnState(s, key))
  }, [])

  const setWidth = useCallback((key: ColumnKey, width: number) => {
    // 0 means 'reset to default' (bound to double-click on the handle).
    setState((s) => {
      if (width === 0) {
        const widths = { ...s.widths }
        delete widths[key]
        return { ...s, widths }
      }
      return { ...s, widths: { ...s.widths, [key]: clampWidth(key, width) } }
    })
  }, [])

  const resetWidths = useCallback(() => {
    setState((s) => ({ ...s, widths: {} }))
  }, [])

  const widthOf = useCallback((key: ColumnKey) => widthOfState(state, key), [state])

  return { state, toggleColumn, setWidth, resetWidths, widthOf }
}
/**
 * Drag handle for resizing one column. Renders a 5px grab strip on the header
 * edge; uses pointer capture so the drag keeps tracking outside the element.
 */
export function ColumnResizer({
  onResize,
  currentWidth
}: {
  onResize: (next: number) => void
  currentWidth: number
}) {
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      title="Drag to resize"
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        dragging.current = true
        startX.current = e.clientX
        startWidth.current = currentWidth
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        // Dragging left widens a right-aligned column, so the delta is inverted
        // for columns anchored to the right edge.
        onResize(startWidth.current + (e.clientX - startX.current))
      }}
      onPointerUp={(e) => {
        dragging.current = false
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      }}
      onDoubleClick={() => onResize(0)} // 0 = reset to default
      className="ml-1 h-4 w-[3px] shrink-0 cursor-col-resize rounded-full bg-transparent transition-colors duration-150 hover:bg-accent/60"
    />
  )
}
