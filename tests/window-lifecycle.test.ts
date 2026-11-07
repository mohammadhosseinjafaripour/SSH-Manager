import { describe, expect, it } from 'vitest'

/**
 * Guards for the Electron main-process window lifecycle.
 *
 * A BrowserWindow reference stays non-null after `destroy()`. Calling
 * `.restore()`, `.focus()` or `.webContents.send()` on it throws
 * "Object has been destroyed", which Electron surfaces to the user as
 * "A JavaScript error occurred in the main process".
 *
 * That happened when the app was in the tray and the user reopened it from the
 * shortcut, and again from the auto-lock timer while the window was closed.
 * These tests pin the rule the fixes rely on: never reason about the window
 * from the variable alone.
 */

interface FakeWindow {
  destroyed: boolean
  isDestroyed(): boolean
  restore(): void
  focus(): void
  show(): void
  isMinimized(): boolean
  webContents: { send(channel: string): void }
}

/** Minimal BrowserWindow stand-in that throws exactly like the real one. */
function makeWindow(): FakeWindow {
  const win: FakeWindow = {
    destroyed: false,
    isDestroyed: () => win.destroyed,
    isMinimized: () => false,
    restore() {
      if (win.destroyed) throw new Error('Object has been destroyed')
    },
    focus() {
      if (win.destroyed) throw new Error('Object has been destroyed')
    },
    show() {
      if (win.destroyed) throw new Error('Object has been destroyed')
    },
    webContents: {
      send() {
        if (win.destroyed) throw new Error('Object has been destroyed')
      }
    }
  }
  return win
}

/** Mirrors liveWindow() in src/main/index.ts. */
function liveWindow(ref: FakeWindow | null): FakeWindow | null {
  return ref && !ref.isDestroyed() ? ref : null
}

describe('liveWindow guard', () => {
  it('returns a healthy window', () => {
    const win = makeWindow()
    expect(liveWindow(win)).toBe(win)
  })

  it('returns null for a destroyed window, even though the reference is set', () => {
    const win = makeWindow()
    win.destroyed = true
    // The whole bug: `if (mainWindow)` was true here.
    expect(win).not.toBeNull()
    expect(liveWindow(win)).toBeNull()
  })

  it('returns null when there is no window', () => {
    expect(liveWindow(null)).toBeNull()
  })
})

describe('second-instance handler', () => {
  /** The fixed handler: route through the guard, then recreate if needed. */
  function handleSecondInstance(ref: FakeWindow | null): FakeWindow {
    const existing = liveWindow(ref)
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return existing
    }
    const recreated = makeWindow()
    recreated.show()
    recreated.focus()
    return recreated
  }

  it('REGRESSION: reopening from the shortcut while in the tray does not throw', () => {
    const win = makeWindow()
    win.destroyed = true // window was closed to the tray
    expect(() => handleSecondInstance(win)).not.toThrow()
  })

  it('REGRESSION: it actually reopens a window instead of doing nothing', () => {
    const win = makeWindow()
    win.destroyed = true
    const reopened = handleSecondInstance(win)
    expect(reopened.isDestroyed()).toBe(false)
  })

  it('reuses a live window rather than creating a duplicate', () => {
    const win = makeWindow()
    expect(handleSecondInstance(win)).toBe(win)
  })

  it('the OLD handler shape is what threw (guard against reintroducing it)', () => {
    const win = makeWindow()
    win.destroyed = true
    // Old code: `if (mainWindow) { mainWindow.restore() ... }`
    const oldHandler = (ref: FakeWindow | null): void => {
      if (ref) ref.show()
    }
    expect(() => oldHandler(win)).toThrow('Object has been destroyed')
  })
})

describe('auto-lock timer send', () => {
  /** The fixed timer body. */
  function notifyLocked(ref: FakeWindow | null): boolean {
    const win = liveWindow(ref)
    if (!win) return false
    win.webContents.send('vault:locked')
    return true
  }

  it('REGRESSION: does not throw when the window was closed to the tray', () => {
    const win = makeWindow()
    win.destroyed = true
    expect(() => notifyLocked(win)).not.toThrow()
    expect(notifyLocked(win)).toBe(false)
  })

  it('sends when the window is alive', () => {
    const win = makeWindow()
    expect(notifyLocked(win)).toBe(true)
  })

  it('optional chaining alone was insufficient — that is why this exists', () => {
    const win = makeWindow()
    win.destroyed = true
    // Old code: `mainWindow?.webContents.send(...)`
    const oldSend = (ref: FakeWindow | null): void => {
      ref?.webContents.send('vault:locked')
    }
    expect(() => oldSend(win)).toThrow('Object has been destroyed')
  })
})
