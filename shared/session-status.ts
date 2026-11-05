/**
 * Live-session predicate, shared by the tray (deciding whether closing the
 * window may exit the app) and the servers list.
 *
 * "Live" means a shell/session a user could still be attached to. Handshake
 * states that never produced a shell (hostkey prompts, rejected auth) are NOT
 * live — closing the app there loses nothing.
 */
import type { SessionStatus } from './types'

const LIVE_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'connecting',
  'reconnecting',
  'connected',
  'elevated',
  'elevated-unverified',
  'elevated-no-prompt',
  'elevate-failed'
])

export function isLiveSessionStatus(status: SessionStatus): boolean {
  return LIVE_STATUSES.has(status)
}
