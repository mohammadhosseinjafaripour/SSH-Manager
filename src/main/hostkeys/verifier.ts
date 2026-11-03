import { createHash } from 'node:crypto'
import type { HostKeyPin } from '@shared/types'

/** PuTTY/OpenSSH-style fingerprint: SHA256 over the raw host key blob. */
export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export type HostKeyCheck =
  | { verdict: 'trusted'; fingerprint: string }
  | { verdict: 'unknown'; fingerprint: string }
  | { verdict: 'changed'; fingerprint: string; pinnedFingerprint: string }

/**
 * Trust-on-first-use check. Keyed by {host, port} so IPv6 literals (which
 * contain colons) can never collide with another endpoint's pin.
 */
export function checkPin(
  pins: ReadonlyArray<HostKeyPin>,
  host: string,
  port: number,
  fingerprint: string
): HostKeyCheck {
  const pinned = pins.find((p) => p.host === host && p.port === port)
  if (!pinned) return { verdict: 'unknown', fingerprint }
  if (pinned.fingerprint === fingerprint) return { verdict: 'trusted', fingerprint }
  return { verdict: 'changed', fingerprint, pinnedFingerprint: pinned.fingerprint }
}
