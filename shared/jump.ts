/**
 * Jump-host (bastion) chain resolution — pure, unit-testable.
 *
 * A server can tunnel through another stored server (ProxyJump style); hops
 * may chain. Cycles and excessive depth are cut off defensively.
 */
import type { ServerEntry } from './types'

export const MAX_JUMP_HOPS = 4

/**
 * Returns the hop servers from outermost to immediate, e.g. for target T with
 * jump J and J jumping through B: [B, J].
 */
export function buildJumpChain(
  target: ServerEntry,
  lookup: (id: string) => ServerEntry | undefined
): { hops: ServerEntry[]; broken: boolean } {
  const hops: ServerEntry[] = []
  const seen = new Set<string>([target.id])
  let cursor = target

  while (cursor.jumpHostId) {
    if (seen.has(cursor.jumpHostId) || hops.length >= MAX_JUMP_HOPS) {
      return { hops, broken: true }
    }
    const hop = lookup(cursor.jumpHostId)
    if (!hop) return { hops, broken: true } // referenced server was deleted
    seen.add(hop.id)
    hops.unshift(hop)
    cursor = hop
  }
  return { hops, broken: false }
}

/**
 * Maps a raw ProxyJump value ("user@bastion", "bastion", "bastion:2222") to a
 * hop server by comparing the host part against an alias or hostname.
 */
export function resolveProxyJump(
  raw: string,
  candidates: ReadonlyArray<{ alias?: string; host: string; id: string }>
): string | null {
  const hostPart = raw.includes('@') ? raw.slice(raw.lastIndexOf('@') + 1) : raw
  const host = hostPart.includes(':') ? hostPart.slice(0, hostPart.indexOf(':')) : hostPart
  const lower = host.toLowerCase()
  const hit = candidates.find(
    (c) => c.host.toLowerCase() === lower || (c.alias ?? '').toLowerCase() === lower
  )
  return hit ? hit.id : null
}
