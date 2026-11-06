export const EDIT_CHANNEL = 'editor:synced'

/**
 * Security helpers: OS-session lock reaction and clipboard hygiene.
 *
 * Lock-on-Windows-lock: the vault re-locks when Windows locks or suspends, so
 * walking away from the machine always means re-entering the master password.
 * Live SSH sessions keep running (they hold their credentials in memory by
 * design) — reconnecting is what requires the password.
 *
 * Clipboard auto-clear: copied secrets are wiped after a delay IF the user has
 * not copied something else meanwhile. Windows clipboard history (Win+V) may
 * retain earlier entries — that cannot be prevented programmatically.
 */
import { clipboard, powerMonitor } from 'electron'
import type { VaultStore } from './vault/store'

const CLEAR_AFTER_MS = 30_000

let lastCopiedSecret: string | null = null
let clearTimer: ReturnType<typeof setTimeout> | null = null

export async function copySecretWithAutoClear(secret: string): Promise<void> {
  await clipboard.writeText(secret)
  lastCopiedSecret = secret
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(async () => {
    try {
      const current = await clipboard.readText()
      if (current === lastCopiedSecret) await clipboard.writeText('')
    } catch {
      /* clipboard unavailable */
    }
    lastCopiedSecret = null
  }, CLEAR_AFTER_MS)
}

/** Wipes the clipboard on exit if it still holds our secret. */
export async function clearClipboardOnQuit(): Promise<void> {
  try {
    if (lastCopiedSecret && (await clipboard.readText()) === lastCopiedSecret) {
      await clipboard.writeText('')
    }
  } catch {
    /* clipboard unavailable */
  }
}

/** Re-locks the vault whenever the OS session locks or the machine suspends. */
export function registerOsLock(store: VaultStore, notify: () => void): void {
  const lockNow = () => {
    try {
      store.lock()
    } catch {
      /* already locked */
    }
    notify()
  }
  powerMonitor.on('suspend', lockNow)
  // 'lock-screen' is Windows-only and missing from some typings.
  const monitor = powerMonitor as unknown as { on: (e: string, fn: () => void) => void }
  monitor.on('lock-screen', lockNow)
}
