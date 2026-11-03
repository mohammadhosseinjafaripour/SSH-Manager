/**
 * DEV-ONLY mock of the preload bridge (used when the renderer runs in a
 * plain browser during development — never bundled into production builds;
 * main.tsx imports this only under `import.meta.env.DEV`).
 *
 * Simulates: vault create/unlock, server CRUD, a first-connect host-key
 * dialog, an echo shell with prompt, and the sudo marker/echo-off dance.
 */
import { randomUUID } from './uuid'
import type {
  Bridge,
  MainPortMessage,
  RendererPortMessage,
  ServerEntry,
  ServerUpsertInput,
  SessionPort,
  VaultBackupInfo,
  VaultSettings
} from '@shared/types'

const STORAGE_KEY = 'sshvault-devmock-v1'

interface MockState {
  created: boolean
  masterPassword: string
  servers: ServerEntry[]
  settings: VaultSettings
  pinned: Record<string, string>
}

const defaultState: MockState = {
  created: false,
  masterPassword: '',
  servers: seedServers(),
  settings: { idleLockMinutes: 10, theme: 'dark' },
  pinned: {}
}

function seedServers(): ServerEntry[] {
  const base = {
    authMethod: 'password' as const,
    notes: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  return [
    {
      ...base,
      id: 'demo-1',
      name: 'web-prod-1',
      host: '203.0.113.10',
      port: 22,
      username: 'deploy',
      password: 'demo-password',
      tags: ['production', 'web'],
      elevate: { enabled: true, preset: 'sudo -s', customCommand: '', passwordMode: 'same', customPassword: '' },
      lastConnectedAt: new Date(Date.now() - 3 * 3600_000).toISOString()
    },
    {
      ...base,
      id: 'demo-2',
      name: 'db-replica',
      host: '203.0.113.20',
      port: 2222,
      username: 'admin',
      password: 'demo-password',
      tags: ['production', 'database'],
      elevate: { enabled: false, preset: 'sudo -i', customCommand: '', passwordMode: 'same', customPassword: '' },
      lastConnectedAt: null
    }
  ]
}

function load(): MockState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...defaultState, ...JSON.parse(raw) }
  } catch {
    /* fall through */
  }
  return { ...defaultState, servers: seedServers() }
}

const state = load()

function save(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function toView(entry: ServerEntry) {
  const { password: _password, elevate, ...rest } = entry
  return {
    ...rest,
    elevate: {
      enabled: elevate.enabled,
      preset: elevate.preset,
      customCommand: elevate.customCommand,
      passwordMode: elevate.passwordMode,
      hasCustomPassword: elevate.passwordMode === 'custom' && !!elevate.customPassword
    }
  }
}

function snapshot() {
  return { settings: state.settings, servers: state.servers.map(toView) }
}

type PortListener = (sessionId: string, port: SessionPort) => void
type LockedListener = () => void

class MockPort implements SessionPort {
  private listener: ((msg: MainPortMessage) => void) | null = null
  private echo = true
  private awaitingPassword = false
  private pendingHostAccept: ((accept: boolean) => void) | null = null
  private inputLine = ''

  constructor(private readonly server: ServerEntry) {}

  onMessage(cb: (msg: MainPortMessage) => void): void {
    this.listener = cb
  }

  close(): void {
    this.listener = null
  }

  send(msg: RendererPortMessage): void {
    if (msg.type === 'input') {
      for (const ch of msg.data) {
        if (ch === '\r') {
          this.handleLine(this.inputLine)
          this.inputLine = ''
        } else if (ch === '\u007f') {
          if (this.echo && this.inputLine.length > 0) this.post({ type: 'data', data: '\b \b' })
          this.inputLine = this.inputLine.slice(0, -1)
        } else if (ch >= ' ') {
          this.inputLine += ch
          if (this.echo) this.post({ type: 'data', data: ch })
        }
      }
      return
    }
    if (msg.type === 'hostkey-decision' && this.pendingHostAccept) {
      const resolve = this.pendingHostAccept
      this.pendingHostAccept = null
      resolve(msg.accept)
    }
  }

  run(): void {
    this.post({ type: 'status', status: 'connecting' })
    const key = `${this.server.host}:${this.server.port}`
    const fingerprint =
      state.pinned[key] ?? 'SHA256:mockfingerprint' + randomUUID().slice(0, 8) + 'base64pad=='
    setTimeout(() => {
      if (!state.pinned[key]) {
        this.post({ type: 'status', status: 'hostkey-unknown' })
        this.post({ type: 'hostkey', kind: 'unknown', fingerprint })
        this.pendingHostAccept = (accept) => {
          if (!accept) {
            this.post({ type: 'status', status: 'error', detail: 'Host key not trusted — connection refused' })
            return
          }
          state.pinned[key] = fingerprint
          save()
          this.connectPhase()
        }
      } else {
        this.connectPhase()
      }
    }, 500)
  }

  private connectPhase(): void {
    this.post({ type: 'status', status: 'connected' })
    this.post({
      type: 'data',
      data: `Welcome to ${this.server.name} (mock)\r\nLast login: just now from 203.0.113.99\r\n\r\n`
    })
    if (this.server.elevate.enabled) {
      setTimeout(() => this.startElevation(), 350)
    } else {
      this.prompt()
    }
  }

  private startElevation(): void {
    const nonce = randomUUID().slice(0, 6)
    // The tty echoes the command line (marker wrapped in quotes)…
    this.post({
      type: 'data',
      data: `stty -echo; sudo -S -k -p '[SSHVAULT:${nonce}]' -s; stty echo\r\n`
    })
    this.echo = false
    // …then sudo prints the bare marker prompt.
    setTimeout(() => this.post({ type: 'data', data: `[SSHVAULT:${nonce}] ` }), 400)
    this.awaitingPassword = true
  }

  private prompt(root = false): void {
    this.echo = true
    const user = root ? 'root' : this.server.username
    this.post({ type: 'data', data: `\r\n${user}@${this.server.host.split('.')[0]}:~# `.replace('#', root ? '#' : '$') })
  }

  private handleLine(line: string): void {
    if (this.awaitingPassword) {
      this.awaitingPassword = false
      setTimeout(() => {
        this.post({ type: 'status', status: 'elevated', detail: 'Root shell active' })
        this.post({ type: 'data', data: '\r\n' })
        this.prompt(true)
      }, 250)
      return
    }
    const cmd = line.trim()
    if (!cmd) {
      this.post({ type: 'data', data: '\r\n' })
      this.promptLine()
      return
    }
    let out: string
    if (cmd === 'whoami') out = 'root'
    else if (cmd === 'ls') out = 'logs   app.log   config.yml'
    else if (cmd === 'pwd') out = '/home/' + this.server.username
    else if (cmd === 'clear') {
      this.post({ type: 'data', data: '\x1b[2J\x1b[H' })
      this.promptLine()
      return
    } else out = `bash: ${cmd.split(' ')[0]}: command not found`
    this.post({ type: 'data', data: `\r\n${out}\r\n` })
    this.promptLine()
  }

  private promptLine(): void {
    const user = 'root'
    this.post({ type: 'data', data: `${user}@${this.server.host.split('.')[0]}:~# ` })
  }

  private post(msg: MainPortMessage): void {
    this.listener?.(msg)
  }
}

export function createMockBridge(): Bridge {
  const portListeners: PortListener[] = []
  const lockedListeners: LockedListener[] = []

  return {
    vaultStatus: async () => ({ exists: state.created }),
    vaultCreate: async (pw) => {
      state.created = true
      state.masterPassword = pw
      save()
      return snapshot()
    },
    vaultUnlock: async (pw) => {
      if (!state.created || pw !== state.masterPassword) throw new Error('unlock-failed')
      return snapshot()
    },
    vaultLock: async () => undefined,
    vaultActivity: async () => undefined,
    vaultBackups: async () => [] as VaultBackupInfo[],
    vaultRestoreBackup: async () => undefined,
    serversUpsert: async (input: ServerUpsertInput) => {
      const now = new Date().toISOString()
      if (input.id) {
        const existing = state.servers.find((s) => s.id === input.id)
        if (existing) Object.assign(existing, { ...inputToEntry(input, existing), updatedAt: now })
      } else {
        state.servers.push(inputToEntry(input, undefined, now))
      }
      save()
      return { servers: snapshot().servers, id: input.id ?? state.servers.at(-1)!.id }
    },
    serversDelete: async (id) => {
      state.servers = state.servers.filter((s) => s.id !== id)
      save()
      return { servers: snapshot().servers }
    },
    serversGetSecret: async (id) => {
      const s = state.servers.find((x) => x.id === id)!
      return {
        password: s.password,
        elevatePassword: s.elevate.passwordMode === 'custom' ? s.elevate.customPassword : null
      }
    },
    settingsUpdate: async (patch) => {
      state.settings = { ...state.settings, ...patch }
      save()
      return state.settings
    },
    sessionOpen: async (serverId) => {
      const server = state.servers.find((s) => s.id === serverId)
      if (!server) throw new Error('not-found')
      const sessionId = randomUUID()
      const port = new MockPort(server)
      setTimeout(() => {
        portListeners.forEach((l) => l(sessionId, port))
        port.run()
      }, 30)
      return { sessionId }
    },
    sessionClose: async () => undefined,
    sessionTest: async (serverId) => {
      const s = state.servers.find((x) => x.id === serverId)
      if (!s) throw new Error('not-found')
      return {
        ok: true,
        pinned: !!state.pinned[`${s.host}:${s.port}`],
        fingerprint: state.pinned[`${s.host}:${s.port}`] ?? 'SHA256:notpinnedyet0000abc=',
        message: 'Connected and authenticated (mock)'
      }
    },
    hostkeyReplacePin: async ({ serverId, confirmation }) => {
      const s = state.servers.find((x) => x.id === serverId)
      if (!s || confirmation.trim() !== s.name) throw new Error('replace-confirmation-mismatch')
      return undefined
    },
    onSessionPort: (cb) => {
      portListeners.push(cb)
      return () => {
        const i = portListeners.indexOf(cb)
        if (i !== -1) portListeners.splice(i, 1)
      }
    },
    onLocked: (cb) => {
      lockedListeners.push(cb)
      return () => {
        const i = lockedListeners.indexOf(cb)
        if (i !== -1) lockedListeners.splice(i, 1)
      }
    }
  }
}

function inputToEntry(input: ServerUpsertInput, existing?: ServerEntry, now?: string): ServerEntry {
  const ts = now ?? new Date().toISOString()
  return {
    id: existing?.id ?? randomUUID(),
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    password: input.password ?? existing?.password ?? '',
    authMethod: 'password',
    tags: input.tags,
    notes: input.notes,
    elevate: {
      enabled: input.elevate.enabled,
      preset: input.elevate.preset,
      customCommand: input.elevate.customCommand,
      passwordMode: input.elevate.passwordMode,
      customPassword:
        input.elevate.passwordMode === 'custom'
          ? input.elevate.customPassword ?? existing?.elevate.customPassword ?? ''
          : ''
    },
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
    lastConnectedAt: existing?.lastConnectedAt ?? null
  }
}
