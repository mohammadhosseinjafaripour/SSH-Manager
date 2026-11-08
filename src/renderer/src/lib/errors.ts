/** Errors cross IPC as `<code>` or `<code>:<detail>` strings in Error.message. */
export function bridgeError(err: unknown): { code: string; detail: string } {
  let message = err instanceof Error ? err.message : String(err)
  // Electron wraps main-side invoke failures as "Error invoking remote method
  // 'channel': <inner>" — unwrap so the code/detail split sees the real code
  // instead of mangling it around the channel name.
  const invoked = /^Error invoking remote method '[^']+':\s*(.*)$/s.exec(message)
  if (invoked) message = invoked[1].replace(/^Error:\s*/, '')
  const idx = message.indexOf(':')
  if (idx === -1) return { code: message, detail: '' }
  return { code: message.slice(0, idx), detail: message.slice(idx + 1) }
}

export function isCode(err: unknown, code: string): boolean {
  return bridgeError(err).code === code
}

export function friendlyError(err: unknown): string {
  const { code, detail } = bridgeError(err)
  switch (code) {
    case 'unlock-failed':
      return 'Wrong master password — or the vault file is damaged.'
    case 'vault-locked':
      return 'The vault is locked. Unlock it and try again.'
    case 'not-found':
      return 'This server no longer exists in the vault.'
    case 'invalid-input':
      return detail || 'Please check the entered values.'
    case 'vault-exists':
      return 'A vault already exists on this machine.'
    case 'An object could not be cloned.':
      return 'Something went wrong moving the data between the app layers — please try again.'
    default:
      return (detail || code || 'Something went wrong.').trim()
  }
}
