/**
 * POSIX permission helpers shared by the Files panel and its tests.
 * Only the low 9 bits are meaning; file-type bits (e.g. 0o100644) are masked.
 */
export function octalToRwx(mode: number): string {
  const bits = mode & 0o777
  let out = ''
  for (let shift = 6; shift >= 0; shift -= 3) {
    const chunk = (bits >> shift) & 0o7
    out += chunk & 4 ? 'r' : '-'
    out += chunk & 2 ? 'w' : '-'
    out += chunk & 1 ? 'x' : '-'
  }
  return out
}

/** @deprecated alias kept for call sites that predate this module */
export const legacyModeToRwx = octalToRwx

/** Formats a mode as the three-digit octal people type into chmod. */
export function octalDigits(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0')
}
