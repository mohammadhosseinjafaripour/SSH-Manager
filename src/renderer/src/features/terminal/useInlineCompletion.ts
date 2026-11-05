import { useCallback, useEffect, useRef, useState } from 'react'
import type { InlineSuggestion } from '@shared/types'

/**
 * Inline "ghost text" completion for the terminal.
 *
 * The whole loop is local: keystrokes are mirrored into a line buffer, a
 * debounced request asks the main process for ranked suggestions, and the
 * selected one is painted as an overlay at the cursor — never written into the
 * terminal buffer, so a wrong guess can never corrupt the remote session.
 *
 * Up/Down cycle through the candidate list (like an IDE popup); Tab accepts the
 * highlighted one.
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
  const [suggestions, setSuggestions] = useState<InlineSuggestion[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
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
    setSuggestions([])
    setActiveIndex(0)
  }, [])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  /** Ask for suggestions for `line`, debounced. Resets to the best candidate. */
  const request = useCallback(
    (line: string) => {
      if (!enabled) {
        setSuggestions([])
        return
      }
      if (timer.current) clearTimeout(timer.current)
      const myToken = ++token.current
      if (!line.trim() || line.trim().length < MIN_CHARS) {
        setSuggestions([])
        setActiveIndex(0)
        return
      }
      timer.current = setTimeout(() => {
        window.sshvault
          .complete({ serverId, line })
          .then((res) => {
            if (myToken !== token.current) return // superseded by newer input
            setSuggestions(res.filter((s) => s.insert.length > 0))
            setActiveIndex(0)
          })
          .catch(() => {
            if (myToken === token.current) {
              setSuggestions([])
              setActiveIndex(0)
            }
          })
      }, DEBOUNCE_MS)
    },
    [enabled, serverId]
  )

  /**
   * Feeds typed data into the line buffer and refreshes the suggestion.
   * Typing always resets the highlight to the best guess.
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

  /** Current suggestion, or null when the list is empty. */
  const ghost: Ghost | null = (() => {
    const s = suggestions[activeIndex]
    if (!s?.insert) return null
    return { text: s.insert, hint: s.hint }
  })()

  /**
   * Moves the highlight through the candidate list, wrapping at both ends.
   * Returns true when the list was actually navigated (so the caller knows to
   * swallow the arrow key instead of sending it to the shell).
   */
  const cycle = useCallback(
    (direction: 1 | -1): boolean => {
      if (suggestions.length === 0) return false
      setActiveIndex((i) => {
        const next = (i + direction + suggestions.length) % suggestions.length
        return next
      })
      return true
    },
    [suggestions.length]
  )

  /**
   * Accepts the highlighted suggestion. Returns the text that was sent so the
   * caller can forward it to the PTY.
   */
  const accept = useCallback((): string | null => {
    const s = suggestions[activeIndex]
    if (!s?.insert) return null
    lineRef.current += s.insert
    clear()
    return s.insert
  }, [suggestions, activeIndex, clear])

  /** Accepts only up to the next path/word boundary (like fish/zsh). */
  const acceptWord = useCallback((): string | null => {
    const s = suggestions[activeIndex]
    if (!s?.insert) return null
    const boundary = s.insert.search(/[/\s-]/)
    const part = boundary === -1 ? s.insert : s.insert.slice(0, boundary + 1)
    if (!part) return null
    lineRef.current += part
    clear()
    return part
  }, [suggestions, activeIndex, clear])

  const currentLine = () => lineRef.current

  return {
    ghost,
    suggestions,
    activeIndex,
    cycle,
    feed,
    accept,
    acceptWord,
    clear,
    currentLine
  }
}
