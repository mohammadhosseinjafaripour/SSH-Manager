/** Errors cross IPC as `<code>` or `<code>:<detail>` strings in Error.message. */
export function bridgeError(err: unknown): { code: string; detail: string } {
  const message = err instanceof Error ? err.message : String(err)
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
    default:
      return detail || code || 'Something went wrong.'
  }
}
