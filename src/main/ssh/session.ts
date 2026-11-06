import { randomUUID } from 'node:crypto'
import { Client, type ConnectConfig } from 'ssh2'
import type { ClientChannel } from 'ssh2'
import { MessagePortMain } from 'electron'
import type { MainPortMessage, RendererPortMessage, ServerEntry, SessionStatus } from '@shared/types'
import type { VaultStore } from '../vault/store'
import { checkPin, fingerprintOf } from '../hostkeys/verifier'
import { authConfig } from './auth'
import { openJumpSocket } from './connection'
import { ElevateDetector, buildElevateLine, makeNonce } from './elevate'

const READY_TIMEOUT_MS = 20_000
/**
 * Keepalive tuning. 15s × 20 missed = 5 minutes of tolerance: long enough to
 * survive a laptop sleep, a VPN blip or a slow NAT timeout, short enough that
 * a genuinely dead link is noticed rather than hanging forever.
 */
const KEEPALIVE_INTERVAL_MS = 15_000
const KEEPALIVE_MAX_MISSED = 20
const KI_ANSWER_TIMEOUT_MS = 120_000
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000]


export interface SshSessionOptions {
  server: ServerEntry
  store: VaultStore
  onEnded: (sessionId: string) => void
}

/**
 * One live SSH connection = one terminal tab. All secrets it handles (login
 * password, sudo password) stay in the main process and are dropped as soon
 * as they are no longer needed.
 */
export class SshSession {
  readonly id = randomUUID()

  private conn: Client | null = null
  private stream: ClientChannel | null = null
  private port: MessagePortMain | null = null
  private detector: ElevateDetector | null = null
  private sudoSecret: string | null = null
  private resolveHostKey: ((accept: boolean) => void) | null = null
  private kiFinish: ((answers: string[]) => void) | null = null
  private kiTimer: ReturnType<typeof setTimeout> | null = null
  private kiAutoTried = false
  private ended = false
  private status: SessionStatus = 'connecting'
  private jumpClose: (() => void) | null = null
  private reconnecting = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Last known PTY size, reapplied after a reconnect. */
  private lastSize = { cols: 80, rows: 24 }

  /**
   * Command history observed on this session's PTY, oldest first. Used only for
   * local completion — it never leaves this process.
   */
  private history: string[] = []
  /** Line currently being typed, reconstructed from keystrokes. */
  private currentLine = ''

  constructor(private readonly opts: SshSessionOptions) {}

  get serverId(): string {
    return this.opts.server.id
  }

  get currentStatus(): SessionStatus {
    return this.status
  }

  attachPort(port: MessagePortMain): void {
    this.port = port
    port.on('message', (event) => this.onRendererMessage(event.data as RendererPortMessage))
    port.on('close', () => this.destroy())
    port.start()
  }

  start(): void {
    this.connect()
  }

  /** (Re)establish the SSH connection. Safe to call for the first attempt or a retry. */
  private async connect(): Promise<void> {
    const { host, port, username } = this.opts.server
    this.clearReconnectTimer()
    const conn = (this.conn = new Client())

    conn.on('error', (err: Error) => this.onConnError(err))
    conn.on('close', () => this.onClosed())
    conn.on('ready', () => this.onReady())
    conn.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) =>
      this.onKeyboardInteractive(name, instructions, prompts, finish)
    )

    const keepAlive = this.settingOn('keepAlive')
    // Host key is verified BEFORE authentication: the password is never sent
    // to a host whose key is unknown-to-the-user or has changed.
    let auth: ReturnType<typeof authConfig>
    try {
      auth = authConfig(this.opts.server)
    } catch (err) {
      this.fail('auth-failed', err instanceof Error ? err.message : 'Missing credentials')
      return
    }

    // Resolve the jump chain first: hops connect with their own pinned
    // credentials, then forwardOut hands us a raw socket to the target.
    let jumpSock: NodeJS.ReadWriteStream | null = null
    if (this.opts.server.jumpHostId) {
      try {
        const jump = await openJumpSocket(this.opts.server, this.opts.store)
        jumpSock = jump.sock
        this.jumpClose = jump.close
      } catch (err) {
        this.fail(
          'error',
          err instanceof Error ? err.message : 'Jump host connection failed'
        )
        return
      }
    }

    const config = {
      host,
      port,
      username,
      ...auth,
      ...(jumpSock ? { sock: jumpSock } : {}),
      tryKeyboard: true,
      readyTimeout: READY_TIMEOUT_MS,
      ...(keepAlive
        ? {
            keepaliveInterval: KEEPALIVE_INTERVAL_MS,
            keepaliveCountMax: KEEPALIVE_MAX_MISSED
          }
        : {}),
      // ssh2 >=1.11 supports a Promise verifier (typed APIs lag behind); the
      // cast keeps the async TOFU flow while satisfying the callback typings.
      // ssh2 >=1.11 accepts a Promise-returning verifier at runtime; the
      // published typings only cover the callback forms, hence the cast.
      // ssh2 >=1.11 accepts a Promise-returning verifier at runtime; the
      // published typings only cover the callback forms, hence the cast.
      hostVerifier: (key: Buffer) => this.verifyHostKey(key)
    }
    conn.connect(config as ConnectConfig)
  }

  /** Reads a boolean vault setting, defaulting to on if the vault is unavailable. */
  private settingOn(key: 'keepAlive' | 'autoReconnect'): boolean {
    try {
      const s = this.opts.store.getPayload().settings
      return s?.[key] !== false
    } catch {
      return true
    }
  }

  destroy(): void {
    if (this.ended) return
    this.ended = true
    this.clearReconnectTimer()
    this.clearKiTimer()
    if (this.jumpClose) {
      try {
        this.jumpClose()
      } catch {
        /* already gone */
      }
      this.jumpClose = null
    }
    this.kiFinish = null
    this.resolveHostKey = null
    this.sudoSecret = null
    this.detector?.finish()
    this.detector = null
    try {
      this.conn?.end()
    } catch {
      /* already gone */
    }
    try {
      this.port?.close()
    } catch {
      /* already gone */
    }
    this.opts.onEnded(this.id)
  }

  // ---- handshake -----------------------------------------------------------

  private async verifyHostKey(key: Buffer): Promise<boolean> {
    const { host, port } = this.opts.server
    const fingerprint = fingerprintOf(key)
    let check: ReturnType<typeof checkPin>
    try {
      check = checkPin(this.opts.store.getPayload().pinnedHostKeys, host, port, fingerprint)
    } catch {
      // Vault locked mid-handshake — refuse rather than guess.
      this.fail('error', 'The vault is locked; reconnect after unlocking')
      return false
    }

    if (check.verdict === 'trusted') return true
    if (check.verdict === 'changed') {
      this.post({
        type: 'hostkey',
        kind: 'changed',
        fingerprint,
        pinnedFingerprint: check.pinnedFingerprint
      })
      this.fail('error', 'Host key changed — connection refused (verify out-of-band before replacing the pin)')
      return false
    }

    // Unknown key: ask the user (TOFU). Nothing is sent either way until decided.
    this.setStatus('hostkey-unknown')
    this.post({ type: 'hostkey', kind: 'unknown', fingerprint })
    const accepted = await new Promise<boolean>((resolve) => {
      this.resolveHostKey = resolve
    })
    this.resolveHostKey = null
    if (accepted) {
      await this.opts.store.pinHostKey(host, port, fingerprint).catch(() => undefined)
      this.setStatus('connecting')
      return true
    }
    this.fail('error', 'Host key not trusted — connection refused')
    return false
  }

  private onKeyboardInteractive(
    name: string,
    instructions: string,
    prompts: ReadonlyArray<{ prompt: string; echo?: boolean }>,
    finish: (answers: string[]) => void
  ): void {
    // Auto-answer only once: a single hidden "Password:"-style challenge gets
    // the stored password. Anything else (OTP, multi-prompt) goes to the user.
    if (
      !this.kiAutoTried &&
      prompts.length === 1 &&
      prompts[0].echo !== true &&
      /pass(word|phrase)?/i.test(prompts[0].prompt)
    ) {
      this.kiAutoTried = true
      finish([this.opts.server.password])
      return
    }
    this.kiFinish = finish
    this.post({
      type: 'ki',
      name,
      instruction: instructions,
      prompts: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo === true }))
    })
    this.kiTimer = setTimeout(() => {
      this.clearKiTimer()
      if (this.kiFinish) {
        const f = this.kiFinish
        this.kiFinish = null
        f([])
      }
    }, KI_ANSWER_TIMEOUT_MS)
  }

  // ---- connection lifecycle ------------------------------------------------

  private onConnError(err: Error): void {
    const msg = err.message ?? 'Connection failed'
    if (/All configured (?:authentication methods|auth methods)/i.test(msg)) {
      this.fail('auth-failed', 'Authentication failed — check the stored password')
      return
    }
    if (this.status === 'hostkey-unknown' || this.status === 'hostkey-changed') return
    this.fail('error', msg)
  }

  private onClosed(): void {
    // A deliberate close (user closed the tab) must never reconnect.
    if (this.ended) return

    const hadSession = this.status === 'connected' || this.status.startsWith('elevated')
    const authFailed = this.status === 'auth-failed'

    // Only retry transient drops of an established session — never retry a
    // rejected password (it would feed lockout counters) or a host-key block.
    if (hadSession && !authFailed && this.settingOn('autoReconnect')) {
      this.scheduleReconnect()
      return
    }

    if (this.status !== 'error' && this.status !== 'auth-failed') {
      this.setStatus('closed')
    }
    void this.opts.store.touchConnected(this.serverId).catch(() => undefined)
    this.destroy()
  }

  /**
   * Retries with exponential backoff, indefinitely. The tab, its scrollback
   * and its position in the tab strip all survive, so an overnight drop just
   * reconnects and leaves the previous output on screen.
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer()
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    this.reconnectAttempt++
    this.reconnecting = true

    const secs = Math.round(delay / 1000)
    this.setStatus(
      'reconnecting',
      `Connection lost — reconnecting in ${secs}s (attempt ${this.reconnectAttempt})`
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.ended) return
      // Tear down the dead client before dialing again.
      try {
        this.conn?.removeAllListeners()
        this.conn?.destroy()
      } catch {
        /* already gone */
      }
      this.conn = null
      this.stream = null
      if (this.jumpClose) {
        try {
          this.jumpClose()
        } catch {
          /* already gone */
        }
        this.jumpClose = null
      }
      this.detector?.finish()
      this.detector = null
      this.kiAutoTried = false
      this.setStatus('connecting', `Reconnecting… (attempt ${this.reconnectAttempt})`)
      this.connect()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private onReady(): void {
    const conn = this.conn
    if (!conn) return
    const resumed = this.reconnecting
    this.reconnecting = false
    this.reconnectAttempt = 0

    const { cols, rows } = this.lastSize
    conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) {
        this.fail('error', `Could not open a shell: ${err.message}`)
        return
      }
      this.stream = stream
      // Defeat server-side idle timeouts (TMOUT, autologout, bash's
      // TMOUT=600). Sent before anything else so it is in effect immediately;
      // harmless on shells that don't support it.
      stream.write('TMOUT=0; unset TMOUT 2>/dev/null; export TMOUT=0\n')
      stream.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        this.post({ type: 'data', data: text })
        this.detector?.feed(text)
      })
      stream.on('close', () => this.onClosed())
      this.setStatus('connected', resumed ? 'Reconnected' : undefined)
      // Re-run elevation after a reconnect: the new shell is a normal user
      // shell again, so the root session must be re-established.
      if (this.opts.server.elevate.enabled) this.beginElevation()
      else if (resumed) this.post({ type: 'notice', kind: 'reconnected' })
    })
  }

  private beginElevation(): void {
    const elevate = this.opts.server.elevate
    const secret =
      elevate.passwordMode === 'custom' ? elevate.customPassword : this.opts.server.password
    if (!secret) {
      this.setStatus('elevate-failed')
      this.post({ type: 'status', status: 'elevate-failed', detail: 'No sudo password stored' })
      return
    }
    this.sudoSecret = secret
    const nonce = makeNonce()
    this.detector = new ElevateDetector(nonce, {
      onSendPassword: () => {
        const pass = this.sudoSecret
        this.sudoSecret = null
        if (pass) this.stream?.write(pass + '\r')
      },
      onStatus: (status, detail) => {
        this.setStatus(status)
        this.post({ type: 'status', status, detail })
      },
      onAbort: () => {
        // sudo is still waiting for another password attempt. Abort it and
        // restore echo, otherwise the user is left with a terminal that
        // accepts input but displays nothing.
        this.stream?.write('\x03')
        setTimeout(() => this.stream?.write('stty echo\r'), 120)
      }
    })
    const line = buildElevateLine(elevate.preset, elevate.customCommand, nonce)
    this.stream?.write(line + '\r')
  }

  // ---- renderer messages ---------------------------------------------------

  private onRendererMessage(msg: RendererPortMessage): void {
    switch (msg.type) {
      case 'input':
        this.stream?.write(msg.data)
        this.trackInput(msg.data)
        return
      case 'resize':
        this.lastSize = { cols: msg.cols, rows: msg.rows }
        this.stream?.setWindow(msg.rows, msg.cols, 480, 640)
        return
      case 'activity':
        this.opts.store.touchActivity()
        return
      case 'hostkey-decision':
        this.resolveHostKey?.(msg.accept)
        return
      case 'ki-answer':
        this.clearKiTimer()
        if (this.kiFinish) {
          const f = this.kiFinish
          this.kiFinish = null
          f(msg.responses)
        }
        return
    }
  }

  // ---- command history (for local completion) -----------------------------

  /**
   * Reconstructs the current input line from keystrokes so completion can see
   * what is being typed. Deliberately simple: only printable characters,
   * backspace and carriage return are tracked; anything exotic resets the
   * buffer rather than guessing wrong.
   */
  private trackInput(data: string): void {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const cmd = this.currentLine.trim()
        if (cmd) {
          this.history.push(cmd)
          if (this.history.length > 500) this.history.shift()
        }
        this.currentLine = ''
      } else if (ch === '\x7f') {
        this.currentLine = this.currentLine.slice(0, -1)
      } else if (ch === '\x03' || ch === '\x15') {
        // Ctrl+C / Ctrl+U both discard the line.
        this.currentLine = ''
      } else if (ch >= ' ' && ch !== '\x1b') {
        this.currentLine += ch
      }
    }
  }

  /**
   * Re-points renderer-facing output at a new WebContents. Sessions whose port
   * died with the previous window are already destroyed; live ports keep
   * working because MessagePorts survive window hide/show cycles.
   */
  reattachWebContents(_wc: import('electron').WebContents): void {
    // Ports survive hide/show; a destroyed port means this session ended.
  }

  /** Read-only view of the observed history for the completion engine. */
  getHistory(): ReadonlyArray<string> {
    return this.history
  }

  /** The line currently being typed (best effort). */
  getCurrentLine(): string {
    return this.currentLine
  }

  // ---- helpers -------------------------------------------------------------

  private setStatus(status: SessionStatus, detail?: string): void {
    if (this.ended) return
    this.status = status
    this.post({ type: 'status', status, detail })
  }

  private fail(status: SessionStatus, detail: string): void {
    this.setStatus(status, detail)
  }

  private post(msg: MainPortMessage): void {
    try {
      this.port?.postMessage(msg)
    } catch {
      /* port closed */
    }
  }

  private clearKiTimer(): void {
    if (this.kiTimer) {
      clearTimeout(this.kiTimer)
      this.kiTimer = null
    }
  }
}
