/**
 * OpenSSH client-config (~/.ssh/config) parser — pure string parsing,
 * unit-tested without filesystem access.
 *
 * Supports the subset that maps onto the vault: Host, HostName, User, Port,
 * IdentityFile, ProxyJump. Wildcard patterns and Match blocks are skipped
 * (they can't resolve to a single concrete server).
 */

export interface SshConfigEntry {
  /** The Host alias, e.g. "web1". */
  alias: string
  /** The resolved hostname (defaults to the alias). */
  host: string
  user: string
  port: number
  /** First IdentityFile of the block, if any. */
  identityFile?: string
  /** Raw ProxyJump value, if any ("user@bastion" or "bastion:2222"). */
  proxyJump?: string
}

function hasWildcard(pattern: string): boolean {
  return /[*?!]/.test(pattern) || pattern.startsWith('!')
}

export function parseSshConfig(text: string): SshConfigEntry[] {
  const entries: SshConfigEntry[] = []
  // One entry accumulates per concrete host pattern inside a Host block.
  let current: Array<{ alias: string; host?: string; user?: string; port?: number; identityFile?: string; proxyJump?: string }> = []
  let inMatch = false

  const flush = () => {
    for (const c of current) {
      if (!c.host || !c.user) continue // HostName/User are the minimum we import
      entries.push({
        alias: c.alias,
        host: c.host,
        user: c.user,
        port: c.port ?? 22,
        identityFile: c.identityFile,
        proxyJump: c.proxyJump
      })
    }
    current = []
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '').replace(/^[ \t]+/, '').replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    const splitIdx = line.search(/\s/)
    let key: string
    let value: string
    if (eq !== -1 && (splitIdx === -1 || eq < splitIdx)) {
      key = line.slice(0, eq).trim()
      value = line.slice(eq + 1).trim().replace(/^"|"$/g, '')
    } else {
      key = line.slice(0, splitIdx)
      value = line.slice(splitIdx).trim().replace(/^"|"$/g, '')
    }
    const lower = key.toLowerCase()

    if (lower === 'host') {
      flush()
      inMatch = false
      const patterns = value.split(/\s+/).filter((p) => p.length > 0)
      current = patterns
        .filter((p) => !hasWildcard(p))
        .map((p) => ({ alias: p }))
      continue
    }
    if (lower === 'match') {
      flush()
      inMatch = true
      continue
    }
    if (inMatch || current.length === 0) continue

    for (const c of current) {
      if (lower === 'hostname' && !c.host) c.host = value
      else if (lower === 'user' && !c.user) c.user = value
      else if (lower === 'port' && c.port === undefined) {
        const n = Number.parseInt(value, 10)
        if (!Number.isNaN(n)) c.port = n
      } else if (lower === 'identityfile' && !c.identityFile) c.identityFile = value
      else if (lower === 'proxyjump' && !c.proxyJump) c.proxyJump = value
    }
  }
  flush()

  return entries
}
