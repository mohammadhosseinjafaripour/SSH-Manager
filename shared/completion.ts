/**
 * Shell completion engine — pure, local, no network and no AI.
 *
 * Suggestions come from three sources, in priority order:
 *   1. your own command history on this server (what you actually type)
 *   2. a built-in catalog of common commands, subcommands and flags
 *   3. real file paths, listed over SFTP on demand
 *
 * The renderer shows the result as ghost text after the cursor; Tab accepts it.
 */

export interface CommandSpec {
  name: string
  /** Short description, shown next to the suggestion. */
  desc?: string
  flags?: string[]
  subs?: string[]
}

/** Commands whose next argument is a path. */
export const PATH_COMMANDS = new Set([
  'cd', 'ls', 'cat', 'less', 'more', 'head', 'tail', 'touch', 'mkdir', 'rmdir',
  'rm', 'cp', 'mv', 'ln', 'chmod', 'chown', 'chgrp', 'find', 'stat', 'file',
  'du', 'df', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'grep', 'rg', 'sed',
  'awk', 'nano', 'vim', 'vi', 'emacs', 'code', 'diff', 'cmp', 'source', 'tee',
  'rsync', 'scp', 'install', 'tree', 'wc', 'md5sum', 'sha256sum', 'xxd'
])

/** Common commands with their most useful flags and subcommands. */
export const COMMAND_CATALOG: CommandSpec[] = [
  { name: 'ls', desc: 'list directory', flags: ['-la', '-l', '-a', '-lh', '-lah', '-R', '-t', '-S', '-h', '-d', '-i', '-1'] },
  { name: 'cd', desc: 'change directory', flags: ['-', '~', '..'] },
  { name: 'pwd', desc: 'print working directory' },
  { name: 'cat', desc: 'print file', flags: ['-n', '-A', '-E'] },
  { name: 'less', desc: 'page through file', flags: ['-R', '-S', '+F'] },
  { name: 'head', desc: 'first lines', flags: ['-n 20', '-n 50', '-c'] },
  { name: 'tail', desc: 'last lines', flags: ['-n 20', '-f', '-F', '-n 100'] },
  { name: 'grep', desc: 'search text', flags: ['-r', '-rn', '-i', '-v', '-l', '-n', '-E', '-A 3', '-B 3', '--color=auto'] },
  { name: 'rg', desc: 'ripgrep search', flags: ['-n', '-i', '-l', '-uu', '--hidden', '-g'] },
  { name: 'find', desc: 'find files', flags: ['-name', '-type f', '-type d', '-mtime -1', '-size +100M', '-delete', '-exec'] },
  { name: 'cp', desc: 'copy', flags: ['-r', '-a', '-v', '-p', '-f'] },
  { name: 'mv', desc: 'move/rename', flags: ['-v', '-f', '-n'] },
  { name: 'rm', desc: 'remove', flags: ['-rf', '-r', '-f', '-i', '-v'] },
  { name: 'mkdir', desc: 'make directory', flags: ['-p', '-v'] },
  { name: 'touch', desc: 'create/update file' },
  { name: 'chmod', desc: 'change permissions', flags: ['-R', '755', '644', '600', '700', '+x'] },
  { name: 'chown', desc: 'change owner', flags: ['-R'] },
  { name: 'ln', desc: 'link files', flags: ['-s', '-sf', '-n'] },
  { name: 'tar', desc: 'archive', flags: ['-czf', '-xzf', '-tzf', '-xzvf', '-czvf'] },
  { name: 'zip', desc: 'compress', flags: ['-r'] },
  { name: 'unzip', desc: 'extract', flags: ['-l', '-d', '-o'] },
  { name: 'ps', desc: 'processes', flags: ['aux', '-ef', '-eo pid,ppid,cmd'] },
  { name: 'top', desc: 'live processes', flags: ['-b', '-n 1'] },
  { name: 'htop', desc: 'live processes (nicer)' },
  { name: 'kill', desc: 'signal a process', flags: ['-9', '-15', '-TERM', '-KILL'] },
  { name: 'killall', desc: 'kill by name', flags: ['-9'] },
  { name: 'df', desc: 'disk usage', flags: ['-h', '-i', '-T'] },
  { name: 'du', desc: 'directory size', flags: ['-sh', '-h', '--max-depth=1', '-ah'] },
  { name: 'free', desc: 'memory usage', flags: ['-h', '-m', '-g'] },
  { name: 'uptime', desc: 'load average' },
  { name: 'uname', desc: 'system info', flags: ['-a', '-r', '-m'] },
  { name: 'whoami', desc: 'current user' },
  { name: 'id', desc: 'user and groups' },
  { name: 'hostname', desc: 'host name', flags: ['-I', '-f'] },
  { name: 'date', desc: 'date and time', flags: ['-u', '+%Y-%m-%d'] },
  { name: 'echo', desc: 'print text', flags: ['-e', '-n'] },
  { name: 'export', desc: 'set env var' },
  { name: 'env', desc: 'environment' },
  { name: 'which', desc: 'locate a command' },
  { name: 'whereis', desc: 'locate binary/source' },
  { name: 'man', desc: 'manual page', flags: ['-k'] },
  { name: 'history', desc: 'command history', flags: ['| tail -20', '| grep'] },
  { name: 'clear', desc: 'clear screen' },
  { name: 'exit', desc: 'leave shell' },
  { name: 'logout', desc: 'leave shell' },
  { name: 'sudo', desc: 'run as root', flags: ['-s', '-i', '-u', '-l', '-k'] },
  { name: 'su', desc: 'switch user', flags: ['-', '-l'] },
  { name: 'apt', desc: 'Debian packages', subs: ['update', 'upgrade', 'install', 'remove', 'search', 'list --installed', 'autoremove', 'clean'] },
  { name: 'apt-get', desc: 'Debian packages', subs: ['update', 'upgrade', 'install', 'remove', 'autoremove'] },
  { name: 'yum', desc: 'RHEL packages', subs: ['update', 'install', 'remove', 'search', 'list installed'] },
  { name: 'dnf', desc: 'RHEL packages', subs: ['update', 'install', 'remove', 'search', 'list installed'] },
  { name: 'pacman', desc: 'Arch packages', subs: ['-Syu', '-S', '-R', '-Ss', '-Q'] },
  { name: 'snap', desc: 'snap packages', subs: ['list', 'install', 'remove', 'refresh'] },
  { name: 'systemctl', desc: 'systemd control', subs: ['status', 'start', 'stop', 'restart', 'reload', 'enable', 'disable', 'list-units', 'list-unit-files', 'daemon-reload', 'is-active'] },
  { name: 'service', desc: 'init service', subs: ['status', 'start', 'stop', 'restart', 'reload'] },
  { name: 'journalctl', desc: 'systemd logs', flags: ['-u', '-f', '-n 100', '--since today', '-xe', '--no-pager'] },
  { name: 'docker', desc: 'containers', subs: ['ps', 'ps -a', 'images', 'run', 'exec -it', 'logs -f', 'start', 'stop', 'restart', 'rm', 'rmi', 'pull', 'build', 'compose', 'inspect', 'stats'] },
  { name: 'docker-compose', desc: 'compose stacks', subs: ['up -d', 'down', 'ps', 'logs -f', 'restart', 'pull', 'build'] },
  { name: 'kubectl', desc: 'Kubernetes', subs: ['get pods', 'get svc', 'get nodes', 'get deploy', 'describe', 'logs -f', 'apply -f', 'delete', 'exec -it', 'top', 'rollout'] },
  { name: 'git', desc: 'version control', subs: ['status', 'pull', 'push', 'fetch', 'log --oneline', 'diff', 'add .', 'commit -m', 'checkout', 'switch', 'branch', 'merge', 'rebase', 'stash', 'reset --hard', 'clone'] },
  { name: 'npm', desc: 'node packages', subs: ['install', 'ci', 'run', 'start', 'test', 'build', 'update', 'audit fix'] },
  { name: 'yarn', desc: 'node packages', subs: ['install', 'add', 'start', 'build', 'test'] },
  { name: 'pnpm', desc: 'node packages', subs: ['install', 'add', 'start', 'build', 'test'] },
  { name: 'pip', desc: 'python packages', subs: ['install', 'install -r requirements.txt', 'list', 'freeze', 'uninstall'] },
  { name: 'python3', desc: 'python interpreter', flags: ['-m venv', '-m http.server'] },
  { name: 'node', desc: 'node interpreter', flags: ['-v', '-e'] },
  { name: 'php', desc: 'php', flags: ['-v', '-m', '-i'] },
  { name: 'composer', desc: 'php packages', subs: ['install', 'update', 'dump-autoload', 'require'] },
  { name: 'mysql', desc: 'MySQL client', flags: ['-u root -p', '-e'] },
  { name: 'psql', desc: 'PostgreSQL client', flags: ['-U postgres', '-d', '-c'] },
  { name: 'redis-cli', desc: 'Redis client', flags: ['ping', 'info', 'monitor', '-h'] },
  { name: 'mongo', desc: 'Mongo shell', flags: ['--host', '--eval'] },
  { name: 'nginx', desc: 'web server', flags: ['-t', '-s reload', '-s stop', '-T'] },
  { name: 'apache2ctl', desc: 'Apache control', flags: ['configtest', '-k restart'] },
  { name: 'php-fpm', desc: 'PHP FPM', flags: ['-t', '-R'] },
  { name: 'curl', desc: 'HTTP client', flags: ['-I', '-L', '-s', '-v', '-X POST', '-H', '-d', '-o', '-k', '--resolve'] },
  { name: 'wget', desc: 'download', flags: ['-O', '-c', '-q', '--no-check-certificate'] },
  { name: 'ssh', desc: 'SSH client', flags: ['-p', '-i', '-L', '-R', '-N', '-v', '-o StrictHostKeyChecking=no'] },
  { name: 'scp', desc: 'copy over SSH', flags: ['-r', '-P', '-i'] },
  { name: 'rsync', desc: 'sync files', flags: ['-avz', '-avz --delete', '--progress', '-e ssh', '--dry-run'] },
  { name: 'netstat', desc: 'network stats', flags: ['-tulpn', '-an', '-rn'] },
  { name: 'ss', desc: 'socket stats', flags: ['-tulpn', '-tan', '-s'] },
  { name: 'lsof', desc: 'open files', flags: ['-i', '-i:80', '-p', '-u'] },
  { name: 'ping', desc: 'icmp test', flags: ['-c 4', '-c 10', '-i'] },
  { name: 'traceroute', desc: 'path to host', flags: ['-I', '-n'] },
  { name: 'dig', desc: 'DNS lookup', flags: ['+short', 'ANY', 'MX', 'TXT', '@8.8.8.8'] },
  { name: 'nslookup', desc: 'DNS lookup' },
  { name: 'ip', desc: 'network config', flags: ['a', 'addr', 'route', 'link', 'neigh'] },
  { name: 'ifconfig', desc: 'interfaces' },
  { name: 'iptables', desc: 'firewall', flags: ['-L -n -v', '-S', '-F'] },
  { name: 'ufw', desc: 'Ubuntu firewall', subs: ['status', 'enable', 'disable', 'allow', 'deny'] },
  { name: 'firewall-cmd', desc: 'firewalld', flags: ['--list-all', '--reload', '--add-port'] },
  { name: 'crontab', desc: 'scheduled jobs', flags: ['-l', '-e', '-r'] },
  { name: 'at', desc: 'one-off schedule', flags: ['now + 1 hour'] },
  { name: 'mount', desc: 'mount filesystems' },
  { name: 'umount', desc: 'unmount' },
  { name: 'fdisk', desc: 'partition table', flags: ['-l'] },
  { name: 'lsblk', desc: 'block devices', flags: ['-f'] },
  { name: 'blkid', desc: 'block ids' },
  { name: 'dmesg', desc: 'kernel log', flags: ['-T', '-w', '| tail -50'] },
  { name: 'last', desc: 'login history', flags: ['-n 20'] },
  { name: 'w', desc: 'who is logged in' },
  { name: 'who', desc: 'logged-in users' },
  { name: 'users', desc: 'logged-in users' },
  { name: 'passwd', desc: 'change password', flags: ['-l', '-u', '-S'] },
  { name: 'useradd', desc: 'add user', flags: ['-m', '-s /bin/bash', '-G'] },
  { name: 'userdel', desc: 'delete user', flags: ['-r'] },
  { name: 'usermod', desc: 'modify user', flags: ['-aG', '-s', '-L', '-U'] },
  { name: 'groupadd', desc: 'add group' },
  { name: 'chpasswd', desc: 'bulk password change' },
  { name: 'visudo', desc: 'edit sudoers' },
  { name: 'crontab -l', desc: 'list cron jobs' },
  { name: 'docker logs', desc: 'container logs' },
  { name: 'tail -f', desc: 'follow file', flags: ['/var/log/syslog', '/var/log/auth.log', '/var/log/nginx/access.log', '/var/log/nginx/error.log'] },
  { name: 'systemctl status', desc: 'unit status' },
  { name: 'wc', desc: 'count lines/words', flags: ['-l', '-w', '-c'] },
  { name: 'sort', desc: 'sort lines', flags: ['-n', '-r', '-u', '-k2', '-h'] },
  { name: 'uniq', desc: 'dedupe lines', flags: ['-c', '-d', '-u'] },
  { name: 'cut', desc: 'cut columns', flags: ['-d', '-f1', '-c'] },
  { name: 'sed', desc: 'stream edit', flags: ['-i', '-n', '-e', 's///g'] },
  { name: 'awk', desc: 'field processing', flags: ['-F', "{print $1}", 'NR'] },
  { name: 'xargs', desc: 'build args', flags: ['-0', '-n 1', '-I {}', '-r'] },
  { name: 'tee', desc: 'split output', flags: ['-a'] },
  { name: 'base64', desc: 'encode/decode', flags: ['-d', '-w 0'] },
  { name: 'openssl', desc: 'crypto toolkit', subs: ['version', 's_client -connect', 'x509 -noout -text', 'rand -hex 32', 'dgst -sha256'] },
  { name: 'ssh-keygen', desc: 'key management', flags: ['-t ed25519', '-t rsa -b 4096', '-R', '-l -f'] },
  { name: 'ssh-copy-id', desc: 'install public key', flags: ['-i', '-p'] },
  { name: 'screen', desc: 'terminal multiplexer', flags: ['-ls', '-r', '-S'] },
  { name: 'tmux', desc: 'terminal multiplexer', subs: ['ls', 'attach', 'new -s', 'kill-session'] },
  { name: 'vim', desc: 'editor', flags: ['-R', '+set number'] },
  { name: 'nano', desc: 'editor', flags: ['-w', '-l'] },
  { name: 'watch', desc: 'repeat command', flags: ['-n 2', '-d'] },
  { name: 'nohup', desc: 'run detached', flags: ['&', '> /dev/null 2>&1 &'] },
  { name: 'bg', desc: 'background job' },
  { name: 'fg', desc: 'foreground job' },
  { name: 'jobs', desc: 'list jobs', flags: ['-l'] },
  { name: 'time', desc: 'time a command' },
  { name: 'strace', desc: 'trace syscalls', flags: ['-p', '-f', '-e trace=file'] }
]

const NAME_INDEX = new Map(COMMAND_CATALOG.map((c) => [c.name, c]))

/** True when every character of `needle` appears in order inside `hay`. */
export function isSubsequence(needle: string, hay: string): boolean {
  let i = 0
  for (const ch of hay) {
    if (ch === needle[i]) i++
    if (i === needle.length) return true
  }
  return needle.length === 0
}

/** Length of the shared leading substring (used to rank historical matches). */
export function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

export interface Suggestion {
  /** Text appended after the cursor when accepted. */
  insert: string
  kind: 'command' | 'flag' | 'path' | 'history' | 'sub'
  /** Short human hint shown beside the ghost text. */
  hint?: string
}

export interface SuggestInput {
  /** Characters typed on the current line (up to the cursor). */
  line: string
  /** Past commands on this server, oldest first. */
  history: ReadonlyArray<string>
  /** Directory entries for path completion (names only). */
  files?: ReadonlyArray<string>
  /** Directory names for the `cd` case. */
  dirs?: ReadonlyArray<string>
  /** Already-used flags on this line, to avoid re-suggesting them. */
  max?: number
}

/**
 * Produces ranked suggestions for the current line. The returned `insert`
 * always appends to what the user has already typed — it never replaces text,
 * so accepting is always safe even if our view of the line is slightly stale.
 */
export function suggest(input: SuggestInput): Suggestion[] {
  return withoutEmptyInserts(suggestUnsafe(input))
}

function suggestUnsafe(input: SuggestInput): Suggestion[] {
  const line = input.line
  const limit = input.max ?? 6
  if (!line.trim()) {
    // Empty prompt: offer the most-used commands from history.
    const counts = new Map<string, number>()
    for (const h of input.history) {
      const head = h.trim().split(/\s+/)[0]
      if (head) counts.set(head, (counts.get(head) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => ({
        insert: name,
        kind: 'history' as const,
        hint: `used ${count}×`
      }))
  }

  const tokens = line.split(/\s+/)
  const startsWithSpace = /^\s/.test(line)
  const endsWithSpace = /\s$/.test(line)
  const currentToken = endsWithSpace ? '' : (tokens[tokens.length - 1] ?? '')

  // A path-like first token (./script, ~/x, /usr/bin/x) is a path, not a
  // command name — let the path branch below handle it.
  const pathishFirstToken =
    tokens.length === 1 &&
    !endsWithSpace &&
    (currentToken.startsWith('./') ||
      currentToken.startsWith('../') ||
      currentToken.startsWith('~/') ||
      currentToken.startsWith('/'))

  // --- first token: command name -------------------------------------------
  if (tokens.length === 1 && !endsWithSpace && !startsWithSpace && !pathishFirstToken) {
    const prefix = currentToken
    const fromCatalog = COMMAND_CATALOG.filter(
      (c) => c.name.startsWith(prefix) && c.name !== prefix
    ).map<Suggestion>((c) => ({
      insert: c.name.slice(prefix.length),
      kind: 'command' as const,
      hint: c.desc
    }))
    // Subsequence matches after exact prefix matches ("gco" -> grep? no; but "clr" -> clear).
    const fuzzy = COMMAND_CATALOG.filter(
      (c) => !c.name.startsWith(prefix) && c.name !== prefix && isSubsequence(prefix, c.name)
    ).map<Suggestion>((c) => ({ insert: c.name, kind: 'command', hint: c.desc }))

    const historyHeads = [...new Set(input.history.map((h) => h.trim().split(/\s+/)[0] ?? ''))]
      .filter((h) => h && h.startsWith(prefix) && h !== prefix && !NAME_INDEX.has(h))
      .map<Suggestion>((h) => ({ insert: h.slice(prefix.length), kind: 'history' }))

    return [...fromCatalog, ...historyHeads, ...fuzzy].slice(0, limit)
  }

  const cmdName = startsWithSpace ? '' : (tokens[0] ?? '')
  const spec = NAME_INDEX.get(cmdName)

  // --- subcommand position (git/docker/systemctl ...) ----------------------
  if (spec?.subs && (tokens.length === 1 && endsWithSpace || tokens.length === 2)) {
    const prefix = endsWithSpace ? '' : currentToken
    const subs = spec.subs
      .filter((s) => s.startsWith(prefix) && s !== prefix)
      .map<Suggestion>((s) => ({ insert: s.slice(prefix.length), kind: 'sub' as const, hint: `${cmdName} ${s}` }))
      .filter((s) => s.insert.length > 0)
    if (subs.length > 0) return subs.slice(0, limit)
  }

  // --- flag position -------------------------------------------------------
  if (currentToken.startsWith('-') && spec?.flags) {
    const used = new Set(tokens)
    const flags = spec.flags
      .filter((f) => f.startsWith(currentToken) && f !== currentToken && !used.has(f))
      .map<Suggestion>((f) => ({ insert: f.slice(currentToken.length), kind: 'flag' as const }))
      .filter((f) => f.insert.length > 0)
    if (flags.length > 0) return flags.slice(0, limit)
  }

  // --- path position -------------------------------------------------------
  const prevToken = endsWithSpace ? tokens[tokens.length - 1] : tokens[tokens.length - 2]
  const wantsPath =
    (prevToken && PATH_COMMANDS.has(prevToken)) ||
    currentToken.includes('/') ||
    currentToken.startsWith('~') ||
    currentToken.startsWith('.')

  if (wantsPath) {
    const pool = prevToken === 'cd' ? (input.dirs ?? []) : (input.files ?? [])
    // Split "./conf" into a directory part (kept) and a name part (matched).
    const slash = currentToken.lastIndexOf('/')
    const dirPrefix = slash >= 0 ? currentToken.slice(0, slash + 1) : ''
    const namePrefix = slash >= 0 ? currentToken.slice(slash + 1) : currentToken
    const matches = pool
      .filter((f) => f.startsWith(namePrefix) && f !== namePrefix)
      .map<Suggestion>((f) => ({
        // Only the remainder after what is already typed is appended.
        insert: f.slice(namePrefix.length),
        kind: 'path' as const,
        hint: `${dirPrefix}${f}`
      }))
      .filter((m) => m.insert.length > 0)
    if (matches.length > 0) return matches.slice(0, limit)
  }

  // --- history line completion ---------------------------------------------
  const trimmed = line
  const candidates = input.history
    .filter((h) => h !== trimmed && h.startsWith(trimmed))
    .sort((a, b) => a.length - b.length)
  if (candidates.length > 0) {
    const best = candidates[0]
    const insert = best.slice(trimmed.length)
    if (insert.length > 0) {
      return [{ insert, kind: 'history', hint: 'from history' }]
    }
  }

  return []
}

/** The single best suggestion, or null. */
export function bestSuggestion(input: SuggestInput): Suggestion | null {
  return suggest({ ...input, max: 1 })[0] ?? null
}

/**
 * Last line of defence: an empty `insert` would paint an invisible ghost and
 * make Tab appear broken, so it is stripped before suggestions reach the UI.
 */
function withoutEmptyInserts(list: Suggestion[]): Suggestion[] {
  return list.filter((s) => s.insert.length > 0)
}
