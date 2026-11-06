/**
 * PuTTY session importer — pure parsing of `reg query` output so it can be
 * unit-tested without running reg.exe.
 *
 * Sessions live under HKCU\Software\SimonTatham\PuTTY\Sessions\<Name>, where
 * <Name> is the session name with special characters percent-encoded.
 */

export interface PuttySession {
  name: string
  host: string
  port: number
  username: string
}

/** Decodes PuTTY's percent-encoding of registry session names ("Web%20box"). */
export function decodePuttyName(raw: string): string {
  try {
    return raw.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    )
  } catch {
    return raw
  }
}

function parsePort(raw: string | undefined): number {
  if (!raw) return 22
  // REG_DWORD prints as "0x00000016 (22)" — prefer the decimal in parentheses.
  const paren = raw.match(/\((\d+)\)/)
  if (paren) return Number.parseInt(paren[1], 10)
  const hex = raw.match(/^0x([0-9a-fA-F]+)$/)
  if (hex) return Number.parseInt(hex[1], 16)
  const n = Number.parseInt(raw, 10)
  return Number.isNaN(n) ? 22 : n
}

/**
 * Parses the tree output of:
 *   reg query HKCU\Software\SimonTatham\PuTTY\Sessions /s
 */
export function parsePuttyRegOutput(output: string): PuttySession[] {
  const sessions: PuttySession[] = []
  const lines = output.split(/\r?\n/)

  let name: string | null = null
  let host: string | undefined
  let portRaw: string | undefined
  let username: string | undefined
  let protocol: string | undefined

  const flush = () => {
    if (name && host && (protocol === undefined || /ssh/i.test(protocol))) {
      sessions.push({
        name: decodePuttyName(name),
        host,
        port: parsePort(portRaw),
        username: username ?? ''
      })
    }
    name = null
    host = undefined
    portRaw = undefined
    username = undefined
    protocol = undefined
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    if (line.startsWith('HKEY_')) {
      flush()
      const full = line.trim()
      name = full.slice(full.lastIndexOf('\\') + 1)
      continue
    }
    // Value lines look like: "    HostName    REG_SZ    example.com"
    const m = line.match(/^\s{2,}(\S+)\s+REG_[A-Z_]+\s+(.*)$/)
    if (!m) continue
    const valueName = m[1]
    const value = m[2].trim()
    if (valueName === 'HostName') host = value
    else if (valueName === 'PortNumber') portRaw = value
    else if (valueName === 'UserName') username = value
    else if (valueName === 'Protocol') protocol = value
  }
  flush()

  return sessions.filter((s) => s.host.length > 0)
}
