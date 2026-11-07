/**
 * Automatic sudo elevation ("become root right after login").
 *
 * Safety invariants (verified by unit tests — do not relax them):
 *
 * 1. The sudo password is written to the PTY **exactly once**, and only after
 *    an exact, per-attempt match of the nonce marker `[SSHVAULT:<nonce>]` in
 *    the *unquoted* form. The echoed command line contains the marker wrapped
 *    in single quotes (`-p '[SSHVAULT:...]'`); the real sudo prompt prints it
 *    bare. Matching only the bare form guarantees we never react to our own
 *    echo — which would race `stty -echo` and leak the password on screen.
 * 2. Never on timeout, never on retry, never speculatively. On servers where
 *    sudo never prompts (NOPASSWD, missing sudo) nothing is ever written; the
 *    detector only *reports* status.
 * 3. Exactly one sudo invocation. Authenticating and starting the shell happen
 *    in the same sudo process, so the flow never depends on the timestamp
 *    ticket being reusable. `timestamp_timeout=0` ("always prompt") is common
 *    and makes a separate `sudo -v` pre-check useless — see buildElevateLine.
 * 4. No timed writes of any kind. Echo is restored by the trailing
 *    `; stty echo` in the command itself; a timed write could be consumed by
 *    sudo as a second password attempt and lock the account.
 * 5. Zero automatic retries: one failed attempt proves the stored secret
 *    wrong; retrying feeds pam_faillock.
 */

export const ELEVATE_MARKER_PREFIX = '[SSHVAULT:'

export type ElevateStatus =
  | 'elevated'
  | 'elevated-unverified'
  | 'elevated-no-prompt'
  | 'elevate-failed'

export interface ElevateHandlers {
  /** Called at most once, only on exact bare-marker match. */
  onSendPassword(): void
  onStatus(status: ElevateStatus, detail?: string): void
  /**
   * Called when sudo is left waiting for another password attempt after a
   * rejection. The session cancels it so the user is not stranded at a prompt
   * the app cannot answer.
   */
  onAbort?(): void
}

/** How long to keep watching for a prompt before reporting "no prompt". */
const NO_PROMPT_MS = 5000
/** After the password was sent, how long without failure/proof until we report "unverified". */
const UNVERIFIED_MS = 2500
/** Sliding window of recent output in which markers/failures are matched. */
const WINDOW = 1024

/** `hangs` = sudo is still waiting for input and must be aborted. */
const FAILURE_PATTERNS: ReadonlyArray<{ re: RegExp; detail: string; hangs: boolean }> = [
  { re: /sorry, try again/i, detail: 'Sudo rejected the password', hangs: true },
  { re: /incorrect password attempt/i, detail: 'Sudo rejected the password', hangs: true },
  { re: /no password was provided/i, detail: 'Sudo expected a password but none was sent', hangs: false },
  { re: /not in the sudoers file/i, detail: 'This user is not in the sudoers file', hangs: false },
  { re: /sudo: command not found/i, detail: 'sudo is not installed on this server', hangs: false },
  { re: /authentication failure/i, detail: 'Sudo authentication failed', hangs: true }
]

export function makeNonce(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Builds the elevation line for a preset ("sudo -s", "sudo -i", "sudo su -")
 * or a custom command that must start with `sudo`.
 *
 *   sudo -k -p '[SSHVAULT:<nonce>]' <rest>
 *
 * ONE sudo invocation, on purpose. An earlier design authenticated with
 * `sudo -v` first and then started the shell through a second `sudo`, relying
 * on the timestamp ticket from the first call. That breaks whenever the ticket
 * cannot be reused:
 *
 *   - `timestamp_timeout=0` in sudoers means "always prompt for a password",
 *     so no ticket is ever cached;
 *   - `timestamp_type` variants and some PAM setups likewise fail to share it.
 *
 * On such servers the second sudo prompted again — with sudo's own prompt
 * (e.g. `[sudo: authenticate] Password:`), not our marker — so the app, which
 * answers exactly one marked prompt, could not respond and the session sat
 * waiting for input the user had to type by hand.
 *
 * Authenticating and starting the shell in the same sudo process removes the
 * dependency entirely: whatever the ticket policy, there is exactly one prompt
 * and it carries our marker.
 *
 * Echo and input integrity: sudo is allowed to read the password from the
 * TERMINAL (no `-S`), because a PTY session always has one. sudo turns echo off
 * itself while it reads, and turns it back on afterwards — before the root
 * shell starts. That is the whole point.
 *
 * Every previous attempt used `sudo -S` (read the password from stdin) plus a
 * hand-rolled `stty -echo`. That combination cannot restore echo correctly:
 *   - `stty -echo; sudo -S ... -s; stty echo` — the trailing restore only runs
 *     after the root shell exits, so echo stayed off for the whole session
 *     (keys reached the shell, nothing was drawn).
 *   - `sudo -v && stty echo && sudo -s` — needs a reusable sudo ticket, which
 *     `timestamp_timeout=0` servers never cache, so sudo prompted twice.
 *   - Writing `stty echo\r` into the live shell once a prompt appeared — that
 *     write raced the user's typing: the `\r` submitted their half-typed line
 *     (seen as "nvalid: command not found" plus a stray bash continuation
 *     prompt). Never write into a shell the user may be using.
 *
 * Letting sudo own echo removes all three, with no app-side write at all.
 */
export function buildElevateLine(preset: string, customCommand: string, nonce: string): string {
  const base = preset === 'custom' ? customCommand.trim() : preset
  const rest = base.replace(/^\s*sudo\b\s*/, '').trim()
  // `-S` is deliberately absent: sudo reads the password from the terminal,
  // disables echo for exactly as long as it needs, and restores it before the
  // root shell starts. `-p` still lets us recognise the prompt. `-k` keeps one
  // prompt per attempt and never reuses a cached ticket.
  return `sudo -k -p '${ELEVATE_MARKER_PREFIX}${nonce}]' ${rest}`
}

/**
 * Removes ANSI escape sequences so prompt matching works on coloured prompts.
 * A themed `PS1` like `\[\e[38;5;2m\]root@host\[\e[0m\]# ` puts the reset code
 * after the `#`, so a regex anchored on `#\s*$` never matches without this.
 */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

/** Finds a *bare* occurrence of the marker (not wrapped in single quotes). */
function hasBareMarker(buf: string, marker: string): boolean {
  let idx = buf.indexOf(marker)
  while (idx !== -1) {
    const before = idx > 0 ? buf[idx - 1] : ''
    const afterIdx = idx + marker.length
    const after = afterIdx < buf.length ? buf[afterIdx] : ''
    if (before !== "'" && after !== "'") return true
    idx = buf.indexOf(marker, idx + 1)
  }
  return false
}

export class ElevateDetector {
  private buf = ''
  private sent = false
  private hardSettled = false
  private noPromptTimer: ReturnType<typeof setTimeout> | null = null
  private unverifiedTimer: ReturnType<typeof setTimeout> | null = null
  private readonly marker: string

  constructor(nonce: string, private handlers: ElevateHandlers) {
    this.marker = `${ELEVATE_MARKER_PREFIX}${nonce}]`
    // Display-only timer: never triggers a write. If no prompt appears the
    // server is NOPASSWD / missing sudo — we keep watching so a late prompt
    // (slow LDAP) still gets its password.
    this.noPromptTimer = setTimeout(() => {
      this.noPromptTimer = null
      if (!this.sent && !this.hardSettled) {
        this.handlers.onStatus(
          'elevated-no-prompt',
          'No sudo password prompt appeared (NOPASSWD sudo or prompt skipped)'
        )
      }
    }, NO_PROMPT_MS)
  }

  feed(chunk: string): void {
    if (this.hardSettled) return
    // Match on the combined buffer BEFORE trimming, so a marker at the head
    // of a chunk larger than the window can never be silently dropped.
    const combined = this.buf + chunk
    this.buf = combined.slice(-WINDOW)

    if (!this.sent && hasBareMarker(combined, this.marker)) {
      this.sent = true
      this.clearNoPromptTimer()
      // Display-only: upgrade the pill if no definitive result follows.
      this.unverifiedTimer = setTimeout(() => {
        this.unverifiedTimer = null
        if (!this.hardSettled) {
          this.handlers.onStatus('elevated-unverified', 'Elevation likely succeeded')
        }
      }, UNVERIFIED_MS)
      this.handlers.onSendPassword()
      return
    }

    for (const { re, detail, hangs } of FAILURE_PATTERNS) {
      if (re.test(this.buf)) {
        this.settle('elevate-failed', detail, hangs)
        return
      }
    }

    // Best-effort early proof: a root prompt. sudo owns echo, so the app never
    // writes into the shell — this only drives the status pill.
    if (this.sent && /(?:^|\n)[^\n]{0,64}#\s*$/.test(stripAnsi(this.buf))) {
      this.settle('elevated', 'Root shell active')
    }
  }

  /** Stream closed — release timers; session status takes over. */
  finish(): void {
    this.dispose()
  }

  dispose(): void {
    this.clearNoPromptTimer()
    if (this.unverifiedTimer) {
      clearTimeout(this.unverifiedTimer)
      this.unverifiedTimer = null
    }
  }

  get passwordWasSent(): boolean {
    return this.sent
  }

  private settle(status: ElevateStatus, detail?: string, abort = false): void {
    this.hardSettled = true
    this.dispose()
    if (abort) this.handlers.onAbort?.()
    this.handlers.onStatus(status, detail)
  }

  private clearNoPromptTimer(): void {
    if (this.noPromptTimer) {
      clearTimeout(this.noPromptTimer)
      this.noPromptTimer = null
    }
  }
}
