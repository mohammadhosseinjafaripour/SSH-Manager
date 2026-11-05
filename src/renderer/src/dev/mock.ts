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
  RemoteEntry,
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
  settings: { idleLockMinutes: 10, theme: 'dark', keepAlive: true, autoReconnect: true, autocomplete: true },
  pinned: {}
}

function seedServers(): ServerEntry[] {
  const base = {
    authMethod: 'password' as const,
    keyAuth: null,
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
  const { password: _password, keyAuth, elevate, ...rest } = entry
  return {
    ...rest,
    authMethod: entry.authMethod ?? 'password',
    hasKey: !!keyAuth?.privateKey,
    hasKeyPassphrase: !!keyAuth?.passphrase,
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

let pendingMockImport: { raw: string; format: 'encrypted' | 'csv' } | null = null

/** Fake remote filesystem for the Files panel in dev/browser mode. */
const mockSftp = new Map<string, Record<string, RemoteEntry[]>>()

function mockRemoteTree(): Record<string, RemoteEntry[]> {
  const mk = (name: string, kind: RemoteEntry['kind'], size: number): RemoteEntry => ({
    name,
    path: '',
    kind,
    size,
    modifiedAt: new Date(Date.now() - Math.random() * 8e8).toISOString(),
    permissions: kind === 'dir' ? 0o755 : 0o644,
    isSymlink: false
  })
  return {
    '/': [mk('etc', 'dir', 0), mk('home', 'dir', 0), mk('var', 'dir', 0)],
    '/home': [mk('deploy', 'dir', 0), mk('admin', 'dir', 0)],
    '/home/deploy': [
      mk('app', 'dir', 0),
      mk('logs', 'dir', 0),
      mk('deploy.sh', 'file', 2148),
      mk('config.yml', 'file', 891),
      mk('README.md', 'file', 4210)
    ],
    '/home/deploy/logs': [
      mk('app.log', 'file', 1_204_882),
      mk('error.log', 'file', 92_331)
    ],
    '/home/deploy/app': [mk('server.js', 'file', 12_004), mk('package.json', 'file', 1204)]
  }
}

/** Browser stand-in for the native save dialog used by the real app. */
function triggerBrowserDownload(fileName: string, contents: string): void {
  const blob = new Blob([contents], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

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
    // Mirrors the real two-phase sequence: `sudo -v` validates, echo is
    // restored BEFORE the root shell starts.
    this.post({
      type: 'data',
      data: `stty -echo; sudo -S -k -v -p '[SSHVAULT:${nonce}]' && stty echo && sudo -s; stty echo\r\n`
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
    vaultExportEncrypted: async ({ exportPassword, includePinnedHostKeys }) => {
      if (exportPassword.length < 10) throw new Error('invalid-input:export password must be at least 10 characters')
      const doc = JSON.stringify(
        { app: 'ssh-vault-export', format: 1, exportedAt: new Date().toISOString(), exportPassword, includePinnedHostKeys, servers: state.servers, pinnedHostKeys: state.pinned },
        null,
        2
      )
      triggerBrowserDownload(`ssh-vault-export-${new Date().toISOString().slice(0, 10)}.sshvault`, doc)
      return { ok: true, path: '(browser download)' }
    },
    vaultExportCsv: async () => {
      const header = 'name,host,port,username,password,tags,notes,auto_sudo,sudo_command'
      const rows = state.servers.map((s) =>
        [s.name, s.host, String(s.port), s.username, s.password, s.tags.join(';'), s.notes ?? '', s.elevate.enabled ? 'yes' : 'no', s.elevate.preset].join(',')
      )
      triggerBrowserDownload(`ssh-vault-servers-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...rows].join('\r\n'))
      return { ok: true, path: '(browser download)' }
    },
    vaultImportPick: () =>
      new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.sshvault,.csv,.json,.txt'
        input.onchange = async () => {
          const file = input.files?.[0]
          if (!file) return resolve({ ok: false })
          const raw = await file.text()
          const format: 'encrypted' | 'csv' = raw.trimStart().startsWith('{') && raw.includes('ssh-vault-export') ? 'encrypted' : 'csv'
          pendingMockImport = { raw, format }
          resolve({ ok: true, format, fileName: file.name })
        }
        input.click()
      }),
    vaultImportApply: async ({ exportPassword, mode }) => {
      if (!pendingMockImport) throw new Error('not-found')
      const { raw, format } = pendingMockImport
      let servers: ServerEntry[]
      if (format === 'encrypted') {
        const doc = JSON.parse(raw)
        if (doc.exportPassword !== (exportPassword ?? '')) throw new Error('unlock-failed')
        servers = doc.servers ?? []
      } else {
        const lines = raw.split(/\r?\n/).filter((l) => l.trim())
        const header = (lines[0] ?? '').toLowerCase()
        if (!header.includes('name') || !header.includes('host')) {
          throw new Error('invalid-input:Missing required columns (name, host, username, password)')
        }
        servers = lines.slice(1).map((line, i) => {
          const cells = line.split(',')
          return {
            id: randomUUID(),
            name: cells[0] ?? `server-${i + 1}`,
            host: cells[1] ?? '0.0.0.0',
            port: Number(cells[2]) || 22,
            username: cells[3] ?? 'root',
            password: cells[4] ?? '',
            authMethod: 'password' as const,
            keyAuth: null,
            tags: (cells[5] ?? '').split(';').filter(Boolean),
            notes: cells[6] ?? '',
            elevate: { enabled: (cells[7] ?? 'no') === 'yes', preset: (cells[8] as never) ?? 'sudo -s', customCommand: '', passwordMode: 'same' as const, customPassword: '' },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastConnectedAt: null
          }
        })
      }
      pendingMockImport = null
      if (mode === 'replace') {
        state.servers = servers
      } else {
        const key = (s: ServerEntry) => `${s.name}|${s.host}|${s.port}|${s.username}`
        const existing = new Set(state.servers.map(key))
        const before = state.servers.length
        for (const s of servers) if (!existing.has(key(s))) state.servers.push(s)
        save()
        return {
          servers: snapshot().servers,
          summary: { added: state.servers.length - before, skippedDuplicates: servers.length - (state.servers.length - before), replaced: false }
        }
      }
      save()
      return { servers: snapshot().servers, summary: { added: servers.length, skippedDuplicates: 0, replaced: true } }
    },
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
    // ---- SFTP (mock: an in-memory remote tree, no real transfers) ----------
    sftpOpen: async ({ serverId }) => {
      const s = state.servers.find((x) => x.id === serverId)
      if (!s) throw new Error('not-found')
      const id = randomUUID()
      mockSftp.set(id, { ...mockRemoteTree() })
      return { connectionId: id, homeDir: '/home/' + s.username }
    },
    sftpClose: async ({ connectionId }) => {
      mockSftp.delete(connectionId)
    },
    sftpList: async ({ connectionId, dir }) => {
      const tree = mockSftp.get(connectionId)
      if (!tree) throw new Error('sftp-not-connected:open the Files panel again')
      return (tree[dir] ?? []).map((e) => ({ ...e, path: `${dir.replace(/\/$/, '')}/${e.name}` }))
    },
    sftpMkdir: async ({ connectionId, dir }) => {
      const tree = mockSftp.get(connectionId)
      if (!tree) throw new Error('sftp-not-connected:open the Files panel again')
      tree[dir] = []
      const parent = dir.slice(0, dir.lastIndexOf('/')) || '/'
      tree[parent] ??= []
      tree[parent].push({
        name: dir.slice(dir.lastIndexOf('/') + 1),
        path: dir,
        kind: 'dir',
        size: 0,
        modifiedAt: new Date().toISOString(),
        permissions: 0o755,
        isSymlink: false
      })
    },
    sftpDelete: async ({ connectionId, target }) => {
      const tree = mockSftp.get(connectionId)
      if (!tree) throw new Error('sftp-not-connected:open the Files panel again')
      const parent = target.slice(0, target.lastIndexOf('/')) || '/'
      tree[parent] = (tree[parent] ?? []).filter((e) => `${parent.replace(/\/$/, '')}/${e.name}` !== target)
      delete tree[target]
    },
    sftpUpload: async ({ localPaths }) => {
      await new Promise((r) => setTimeout(r, 900))
      return { uploaded: localPaths.length }
    },
    sftpPickAndUpload: async () => ({ ok: false, uploaded: 0 }),
    sftpDownload: async () => ({ ok: false, downloaded: 0 }),
    sftpCancel: async () => undefined,
    sftpCheckConflicts: async ({ remoteDir, names }) => {
      const tree = [...mockSftp.values()][0]
      const present = (tree?.[remoteDir] ?? []).map((e) => e.name)
      return { existing: names.filter((n) => present.includes(n)) }
    },
    sftpRename: async ({ from, to }) => {
      const tree = [...mockSftp.values()][0]
      if (!tree) return
      const parent = from.slice(0, from.lastIndexOf('/')) || '/'
      const list = tree[parent] ?? []
      const entry = list.find((e) => `${parent.replace(/\/$/, '')}/${e.name}` === from)
      if (entry) entry.name = to.slice(to.lastIndexOf('/') + 1)
    },
    sftpChmod: async ({ target, mode }) => {
      const tree = [...mockSftp.values()][0]
      if (!tree) return
      const parent = target.slice(0, target.lastIndexOf('/')) || '/'
      const entry = (tree[parent] ?? []).find(
        (e) => `${parent.replace(/\/$/, '')}/${e.name}` === target
      )
      if (entry) entry.permissions = mode
    },
    sftpUploadToServer: async ({ localPaths }) => {
      await new Promise((r) => setTimeout(r, 700))
      return { uploaded: localPaths.length, remoteDir: '/home/deploy' }
    },
    complete: async ({ line }) => {
      // Browser-mode stand-in for the real local engine.
      const catalog = ['ls', 'cd', 'cat', 'grep', 'tail', 'systemctl', 'docker', 'git', 'clear', 'pwd']
      const t = line.trim()
      if (!t) return []
      if (!t.includes(' ')) {
        const hit = catalog.find((c) => c.startsWith(t) && c !== t)
        return hit ? [{ insert: hit.slice(t.length), kind: 'command' as const }] : []
      }
      return []
    },
    pickKeyFile: async () =>
      new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.onchange = async () => {
          const f = input.files?.[0]
          if (!f) return resolve({ ok: false })
          resolve({ ok: true, contents: await f.text(), fileName: f.name })
        }
        input.click()
      }),
    healthCheck: async ({ serverIds }) =>
      serverIds.map((id, i) => ({
        serverId: id,
        status: (i === 1 ? 'auth-failed' : 'online') as 'online' | 'auth-failed',
        latencyMs: 18 + i * 27
      })),
    resolveDroppedPaths: async ({ files }) =>
      (files ?? []).map((f) => f.path).filter((p): p is string => typeof p === 'string'),
    onTransferProgress: () => () => undefined,

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
    authMethod: input.authMethod ?? existing?.authMethod ?? 'password',
    keyAuth:
      (input.authMethod ?? existing?.authMethod) === 'key'
        ? {
            privateKey: input.privateKey ?? existing?.keyAuth?.privateKey ?? '',
            passphrase: input.keyPassphrase ?? existing?.keyAuth?.passphrase ?? ''
          }
        : null,
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
