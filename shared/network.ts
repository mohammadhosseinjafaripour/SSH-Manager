/**
 * Human-readable text for network failures from Electron's updater.
 *
 * electron-updater surfaces Chromium net errors verbatim, so Settings used to
 * show raw strings like "net::ERR_CONNECTION_TIMED_OUT". That reads like a
 * crash to a user who is simply offline or behind a captive portal. These are
 * the cases we can name confidently; anything unrecognised falls back to the
 * original message rather than hiding information from a user debugging a
 * real problem.
 */

/** Chromium net error → sentence. `offline` marks transient failures worth retrying. */
export function describeNetworkError(raw: string): { text: string; offline: boolean } {
  const message = (raw ?? '').trim()
  // Electron sometimes wraps the code ("Error: net::ERR_...") or embeds it in
  // a longer sentence, so match anywhere rather than on an exact string.
  const has = (needle: string): boolean => message.toUpperCase().includes(needle)

  if (has('ERR_INTERNET_DISCONNECTED') || has('ERR_NETWORK_CHANGED')) {
    return { text: 'No internet connection. SSH Vault will retry automatically.', offline: true }
  }
  if (has('ERR_CONNECTION_TIMED_OUT') || has('ERR_TIMED_OUT')) {
    return {
      text: 'The connection timed out. A firewall, VPN, or proxy may be blocking GitHub.',
      offline: true
    }
  }
  if (has('ERR_NAME_NOT_RESOLVED') || has('ERR_DNS_')) {
    return { text: 'Could not resolve github.com. Check your DNS or network settings.', offline: true }
  }
  if (has('ERR_CONNECTION_REFUSED')) {
    return {
      text: 'The connection was refused. A proxy or firewall is likely blocking GitHub.',
      offline: true
    }
  }
  if (has('ERR_CONNECTION_RESET') || has('ERR_CONNECTION_CLOSED') || has('ERR_CONNECTION_ABORTED')) {
    return { text: 'The connection dropped before the check finished.', offline: true }
  }
  if (has('ERR_SSL') || has('ERR_CERT') || has('ERR_BAD_SSL')) {
    return {
      text: 'A secure connection to GitHub could not be established. A TLS-intercepting proxy can cause this.',
      offline: false
    }
  }
  if (has('ERR_PROXY') || has('ERR_TUNNEL_CONNECTION_FAILED')) {
    return { text: 'The configured proxy could not reach GitHub.', offline: true }
  }
  if (has('ENOTFOUND') || has('EAI_AGAIN')) {
    return { text: 'Could not reach GitHub. Check your internet connection.', offline: true }
  }
  if (has('ETIMEDOUT')) {
    return { text: 'The connection timed out while contacting GitHub.', offline: true }
  }
  return { text: message || 'The update check failed for an unknown reason.', offline: false }
}
