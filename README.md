<p align="center">
  <img src="docs/screenshots/icon.png" width="96" alt="SSH Vault logo" />
</p>

<h1 align="center">SSH Vault</h1>

<p align="center">
  <strong>A secure, minimal SSH connection manager — PuTTY's job, without the dialogs.</strong><br>
  One master password unlocks an encrypted vault of servers; a click opens a real terminal;
  auto-sudo lands you in a root shell without ever typing <code>sudo</code>.
</p>

<p align="center">
  <a href="https://github.com/mohammadhosseinjafaripour/SSH-Manager/releases/latest"><img src="https://img.shields.io/github/v/release/mohammadhosseinjafaripour/SSH-Manager?label=release&color=2dd4bf&logo=github" alt="Release" /></a>
  <a href="https://github.com/mohammadhosseinjafaripour/SSH-Manager/releases"><img src="https://img.shields.io/github/downloads/mohammadhosseinjafaripour/SSH-Manager/total?label=downloads&color=blue&logo=github" alt="Downloads" /></a>
  <a href="https://github.com/mohammadhosseinjafaripour/SSH-Manager/actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/mohammadhosseinjafaripour/SSH-Manager/build.yml?branch=main&label=build&logo=githubactions" alt="Build" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/mohammadhosseinjafaripour/SSH-Manager?color=green" alt="License" /></a>
  <img src="https://img.shields.io/badge/electron-45-47848F?logo=electron&logoColor=white" alt="Electron 45" />
  <img src="https://img.shields.io/badge/node-22+-339933?logo=nodedotjs&logoColor=white" alt="Node 22+" />
  <img src="https://img.shields.io/badge/tests-197%20passing-2dd4bf" alt="Tests" />
</p>

| Unlock | Servers |
| :---: | :---: |
| ![Unlock screen](docs/screenshots/unlock-screen.png) | ![Servers view](docs/screenshots/servers-view.png) |

## Supported platforms

| Platform | Install | Status |
| --- | --- | --- |
| **Windows** 10/11 (x64) | installer (NSIS) or portable `.exe` | ✅ fully supported — auto-update built in |
| **Linux** (x64) | `.AppImage` / `.deb` / `.rpm` | ✅ v0.7.0 |
| **macOS** (Intel & Apple Silicon) | `.dmg` | ✅ v0.7.0 (unsigned — see below) |

Unsigned builds: Windows SmartScreen ("More info → Run anyway") and macOS Gatekeeper
(System Settings → Privacy & Security → "Open Anyway") ask on first run. Code signing lands
when the project can afford a certificate.

## Highlights

- 🔐 **Encrypted vault** — Argon2id (64 MiB) + AES-256-GCM; every server, password, key and
  note sealed in one file with two rolling backups. Zero-knowledge: no master password, no data.
  **Change the master password** any time (Settings → Security): it asks for the current one as
  proof, then re-encrypts under the new password with a fresh salt.
- 🪟 **Split panes & broadcast input** — open two (or more) servers side by side in one tab and
  toggle **Broadcast** to type into all of them at once — the fleet-admin power tool.
- 👆 **Windows Hello unlock** — fingerprint / face / PIN instead of the master password
  (the key is wrapped with DPAPI + a Hello-verified prompt). The password keeps working as fallback.
- ⚡ **Auto-sudo** — land in a root shell automatically, with nonce-verified one-shot password
  delivery that never leaks to the screen and never retries (see [how it stays safe](#auto-sudo-how-it-stays-safe)).
- 🖥️ **Real terminal** — xterm.js: 256 color, copy-on-select, bracketed paste, in-terminal
  search, reconnect with backoff, PuTTY-style right-click.
- 🧠 **Ghost-text completions** — Copilot-style suggestions from your own history, a built-in
  command catalog (~120 commands) and *real remote paths* over SFTP. 100% local, no AI, no network.
- 📂 **SFTP file panel** — drag & drop folders, downloads, rename, chmod grid, conflict
  policies, resizable columns — in its own connection so transfers never slow your shell.
- 🔑 **Auth, all ways** — password, private key (PEM/OpenSSH, passphrase) or your system agent;
  keyboard-interactive prompts and OTP/2FA dialogs supported.
- 🛡️ **Host-key pinning (TOFU)** — approve a fingerprint before credentials ever travel;
  a changed key hard-refuses with a side-by-side compare + typed-confirmation replacement.
- 📦 **Migration** — encrypted `.sshvault` export (host keys ride along) or plaintext CSV;
  drag a file straight onto the import dialog. One-way **PuTTY** & `~/.ssh/config` import too.
- 🔄 **Self-updating** — checks GitHub Releases (a single anonymous HTTPS GET), downloads,
  verifies sha512, and never restarts on its own while sessions are live.
- 🌗 Dark / light / system themes; tray with live-session count; auto-lock on idle *and* on OS lock.

<details>
<summary><strong>All features in detail</strong></summary>

- **Master-password vault** — Argon2id + AES-256-GCM encrypted file at
  `%LOCALAPPDATA%\SSHVault\vault.bin` (Windows) or the platform's userData dir. Zero-knowledge:
  a forgotten master password means the vault cannot be recovered (stated at setup).
- **Servers, one click away** — named entries with host, port, username, tags and notes;
  add/edit/delete (delete requires typing the server name); instant search (`Ctrl+Shift+F`).
- **Tabbed terminals** — per-tab status (connecting / connected / **ROOT** / failed), and
  **split**: the ⊞ button opens another server beside the current one in the same tab.
- **Broadcast input** — with 2+ panes in a tab, the 📡 button (or `Ctrl+Shift+B`) mirrors every
  keystroke and paste to all panes; each pane header shows a live **LIVE** badge while on.
  Off by default; your focused pane always receives input regardless.
- **Windows Hello** — enable in **Settings → Security**. The vault key is wrapped under a
  random KEK; the KEK is DPAPI(CurrentUser)-protected and only released after a
  UserConsentVerifier prompt (fingerprint/face/PIN). Delete the enrollment any time; the
  master password path is untouched. Enrollment auto-invalidates when the vault is restored
  or replaced.
- **Auto-sudo elevation** — per server: `sudo -s`, `sudo -i`, `sudo su -` or a custom command;
  the sudo password defaults to the login password (a separate one can be stored).
- **Keyboard-interactive auth** — hidden `Password:` prompts are auto-answered; OTP/2FA
  challenges appear in a dialog honoring each prompt's echo flag.
- **Terminal search** — `Ctrl+Shift+F` walks the full scrollback with match-case/whole-word
  toggles and a live match counter.
- **Bulk health check** — **Check all** probes every server in parallel and shows a latency
  pill per row, `auth failed`, `down`, or `key changed`.
- **Inline suggestions** — `Tab` accepts, `→` accepts one path segment, `Esc` dismisses,
  `↑/↓` cycles candidates. Toggle in **Settings → Connection**.

  | You type | Ghost | Why |
  | --- | --- | --- |
  | `clea` | `r` | catalog command |
  | `systemctl re` | `start` | subcommand |
  | `cd lo` | `gs/` | remote directory (SFTP) |
  | `tail -f /var/log/ngi` | `nx/error.log` | remote path |

- **Sessions that survive being away** — SSH keepalives + `TMOUT=0`, then auto-reconnect with
  exponential backoff (1s → 30s, forever) keeping all previous output; root is re-elevated.
- **Upload conflict handling** — overwrite / keep both / skip, in the toolbar or on drop collision.
- **Clipboard done properly** — `Ctrl+Shift+C/V`, `Ctrl+Insert`/`Shift+Insert`, right-click
  copy-or-paste; plain `Ctrl+C` still sends SIGINT. Copied passwords auto-clear after 30s.
- **Drag & drop everywhere** — folders/boards onto terminal or Files panel to upload; an
  `.sshvault`/`.csv` onto the import dialog to import.

</details>

## Getting started

**Requirements:** Windows 10/11 x64 · any Linux (x64, glibc) · macOS 11+ (Intel/Apple Silicon).
Node.js 22+ to build from source.

Grab an installer from
[**Releases**](https://github.com/mohammadhosseinjafaripour/SSH-Manager/releases/latest):

| OS | File |
| --- | --- |
| Windows | `SSH-Vault-x.y.z-setup.exe` (installer) or `-portable.exe` (no install) |
| Linux | `SSH-Vault-x.y.z-linux-x64.AppImage` / `.deb` / `.rpm` |
| macOS | `SSH-Vault-x.y.z-mac-x64.dmg` (Intel) / `-mac-arm64.dmg` (Apple Silicon) |

Or build it yourself:

```bash
git clone https://github.com/mohammadhosseinjafaripour/SSH-Manager.git
cd SSH-Manager
npm install
npm run dev          # development (Electron + hot reload)
npm run verify       # typecheck + 197 unit tests + lint + audit
npm run package      # Windows: NSIS installer + portable exe → release/
npm run package:linux  # AppImage + deb + rpm
npm run package:mac    # dmg (x64 + arm64)
npm run smoke        # launch the packaged app and prove it renders
```

There is also a browser-only development mode with a mock SSH backend — handy for working on
the UI without touching real servers:

```bash
npm run dev:ui       # serves the renderer at http://localhost:5188
```

### If downloads stall

On networks that throttle large HTTPS downloads from GitHub/CDNs, `electron-builder` can hang
forever fetching the Electron runtime. A small static mirror works around it:

```bash
node scripts/local-mirror.mjs &     # serves .local-mirror/ on 127.0.0.1:8123
ELECTRON_MIRROR=http://127.0.0.1:8123/mirror/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=http://127.0.0.1:8123/bins/ \
  npm run package
```

## Moving to a new machine (import / export)

Settings → **Move your servers**:

- **Encrypted export** creates a `.sshvault` file containing all servers — passwords included —
  sealed with Argon2id + AES-256-GCM under a password you choose. Safe on a USB stick or cloud
  drive; without the password it is indistinguishable from random bytes. Pinned host keys can
  ride along so the new machine skips first-connect prompts.
- **Import file…** accepts that `.sshvault` (asks for the file's password) or a plain CSV —
  from the picker **or dropped straight onto the dialog**. Merge adds everything new and skips
  duplicates (name+host+port+username); Replace wipes first and requires typed confirmation.
- **Export as CSV** writes plaintext (`name,host,port,username,password,tags,notes,auto_sudo,
  sudo_command`) behind an "I understand the risk" checkbox — readable by anyone who opens it.

## System tray

Closing the window while sessions are connected does **not** exit the app — it hides to the
system tray and connections keep running (Windows). Click the tray icon to reopen; **Quit**
ends every connection. Closing with nothing connected exits normally.

## Updates

SSH Vault updates itself from GitHub Releases (Windows; other platforms download from the
releases page). Automatic checks are one anonymous HTTPS GET for `latest.yml` — nothing about
you is sent — and installing is always your decision: the app never restarts on its own while
sessions are live. See [docs/RELEASING.md](docs/RELEASING.md) to publish a version.

## Keyboard shortcuts

Inside the terminal, app shortcuts use `Ctrl+Shift+*` so plain `Ctrl+L`, `Ctrl+W`, `Ctrl+N`
reach your remote shell. Outside the terminal plain `Ctrl+*` also works.

| Action | Shortcut |
| --- | --- |
| Lock vault | `Ctrl+Shift+L` |
| Close tab | `Ctrl+Shift+W` |
| Search servers | `Ctrl+Shift+F` (plain `Ctrl+F` outside terminal) |
| New server | `Ctrl+Shift+N` (plain `Ctrl+N` outside terminal) |
| Cycle tabs | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Split tab (open another server) | ⊞ button in the tab bar |
| **Toggle broadcast** | `Ctrl+Shift+B` |
| Copy in terminal | select text (auto-copies), `Ctrl+Shift+C`, `Ctrl+Insert` |
| Paste in terminal | `Ctrl+Shift+V`, `Shift+Insert`, or right-click |
| Accept suggestion | `Tab` (whole) / `→` (one segment) / `Esc` dismiss |
| Cycle suggestions | `↑` / `↓` while a ghost is showing |

## Security design

**Threat model — defended against**

- *Vault theft at rest*: useless without your master password (Argon2id, 64 MiB / 3 passes /
  4 lanes; AES-256-GCM with the header bound as AAD — tampering and wrong password both fail
  authentication, indistinguishably).
- *Master-password rotation*: changing the password verifies the current one first, then
  re-derives the key under a **fresh salt** and re-seals the whole payload in one durable write —
  the old password stops working immediately, and a failed write rolls back to the old key.
- *Windows Hello enrollment*: the vault key is wrapped under a random 32-byte KEK; the KEK is
  DPAPI(CurrentUser)-protected with app-specific entropy and only unwrapped **after** a
  Windows-verified user-presence prompt. Nothing is stored in the cloud or the registry; the
  enrollment is one local file (`vault.bin.hello`) you can delete.
- *Casual shoulder-surfing*: lock screen hides all content; auto-lock after idle **and** on
  OS lock/suspend; passwords masked; clipboard secrets auto-wiped after 30s.
- *Host-key MITM on first connect*: fingerprint shown and approved **before** authentication —
  passwords never travel to an unverified host.
- *Password exposure during sudo*: the password is sent only after detecting sudo's unique
  per-attempt marker, exactly once, with echo disabled — never on screen, never on NOPASSWD
  servers, never retried (no `pam_faillock` feeding).
- *Malicious web content*: sandboxed renderer, `contextIsolation`, strict CSP, no remote
  content, single-instance lock, Electron fuses (no `runAsNode`, no inspect, ASAR-only with
  embedded integrity).

**Explicitly out of scope**: malware already running as your user can read keystrokes and
memory of any application, including this one. No local tool can defend against that.

## Auto-sudo: how it stays safe

```
stty -echo; sudo -S -k -v -p '[SSHVAULT:<nonce>]' && stty echo && sudo -s; stty echo
```

Two phases, because `sudo -s` runs a shell *inside* sudo:

1. `sudo -v` validates the password and caches a ticket.
2. On success, `stty echo` restores echo **in your own shell**, then the root shell starts
   with the cached ticket — echo stays on for the whole session.

- `-k` makes the prompt deterministic; the per-attempt `nonce` prevents false matches, and the
  detector ignores the marker when quoted (the terminal's own echo of the command)
- the password is written **only** on an exact bare-marker match — once, never on timeout,
  never retried, never speculatively
- no timed writes anywhere: a timed `stty echo` could be eaten by sudo as a second password
  attempt and lock the account
- rejection sends Ctrl+C and restores echo — the terminal is never left accepting invisible input
- NOPASSWD servers and missing sudo are detected and reported — nothing is ever written

Pinned by unit tests in `tests/elevate.test.ts`.

## Vault tools & backups

Every save writes: temp file → fsync → copy previous good file to `.bak` (rotating `.bak2`)
→ atomic replace. `Unlock → "Vault tools — restore a backup"` verifies a backup with your
master password and restores it; the displaced file is kept as `vault.bin.corrupt-<ts>`.

## Roadmap

- [ ] Port forwarding / tunnels (`-L`, `-D` SOCKS)
- [ ] Command snippets library (global + per server)
- [x] Change master password (re-encrypt in place)
- [ ] TOTP secrets in the vault, auto-filled on 2FA prompts
- [ ] Session logging to file
- [ ] Export vault → `~/.ssh/config`
- [ ] Code signing (Windows + macOS notarization)
- [ ] Linux/macOS auto-update parity

## License

MIT
