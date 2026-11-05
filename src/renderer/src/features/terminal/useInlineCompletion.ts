import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Inline "ghost text" completion for the terminal.
 *
 * The whole loop is local: keystrokes are mirrored into a line buffer, a
 * debounced request asks the main process for a suggestion, and the result is
 * painted as an overlay at the cursor — never written into the terminal buffer,
 * so a wrong guess can never corrupt the remote session.
 *
 * Why a hook: the terminal component is already large, and this state must be
 * reset consistently when the pane is torn down.
 */

const DEBOUNCE_MS = 120
/** Below this many characters a suggestion is more noise than help. */
const MIN_CHARS = 2

export interface Ghost {
  /** Text to append if accepted. */
  text: string
  /** Optional hint shown dimmed after the ghost. */
  hint?: string
}

interface Options {
  serverId: string
  enabled: boolean
}

export function useInlineCompletion({ serverId, enabled }: Options) {
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const lineRef = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Guards against out-of-order responses overwriting a newer suggestion. */
  const token = useRef(0)

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    token.current++
    setGhost(null)
  }, [])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  /** Ask for a suggestion for `line`, debounced. */
  const request = useCallback(
    (line: string) => {
      if (!enabled) {
        setGhost(null)
        return
      }
      if (timer.current) clearTimeout(timer.current)
      const myToken = ++token.current
      if (!line.trim() || line.trim().length < MIN_CHARS) {
        setGhost(null)
        return
      }
      timer.current = setTimeout(() => {
        window.sshvault
          .complete({ serverId, line })
          .then((res) => {
            if (myToken !== token.current) return // superseded
            const best = res[0]
            setGhost(best?.insert ? { text: best.insert, hint: best.hint } : null)
          })
          .catch(() => {
            if (myToken === token.current) setGhost(null)
          })
      }, DEBOUNCE_MS)
    },
    [enabled, serverId]
  )

  /**
   * Feeds typed data into the line buffer and refreshes the suggestion.
   * Returns the updated line so callers can decide about Tab/Enter handling.
   */
  const feed = useCallback(
    (data: string) => {
      let submitted = false
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          submitted = true
          lineRef.current = ''
        } else if (ch === '\x7f') {
          lineRef.current = lineRef.current.slice(0, -1)
        } else if (ch === '\x03' || ch === '\x15') {
          // Ctrl+C / Ctrl+U discard the line.
          lineRef.current = ''
        } else if (ch >= ' ' && ch !== '\x1b') {
          lineRef.current += ch
        }
      }
      if (submitted) clear()
      else request(lineRef.current)
      return { line: lineRef.current, submitted }
    },
    [clear, request]
  )

  /**
   * Accepts the current suggestion. Returns the text that was sent so the
   * caller can forward it to the PTY.
   */
  const accept = useCallback((): string | null => {
    const g = ghost
    if (!g) return null
    lineRef.current += g.text
    clear()
    return g.text
  }, [ghost, clear])

  /** Accepts only up to the next path/word boundary (like fish/zsh). */
  const acceptWord = useCallback((): string | null => {
    const g = ghost
    if (!g) return null
    const boundary = g.text.search(/[/\s-]/)
    const part = boundary === -1 ? g.text : g.text.slice(0, boundary + 1)
    if (!part) return null
    lineRef.current += part
    clear()
    return part
  }, [ghost, clear])

  const currentLine = () => lineRef.current

  return { ghost, feed, accept, acceptWord, clear, currentLine }
}
