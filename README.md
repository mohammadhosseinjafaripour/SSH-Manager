# SSH Vault

A secure, minimal SSH connection manager for Windows — PuTTY's job, without the dialogs.

One master password unlocks an encrypted vault of servers; a single click opens a real terminal
tab; and with **auto-sudo** you land in a root shell without ever typing `sudo` or its password
again.

| Unlock | Servers |
| :---: | :---: |
| ![Unlock screen](docs/screenshots/unlock-screen.png) | ![Servers view](docs/screenshots/servers-view.png) |

## Getting started

**Requirements:** Windows 10/11 x64, Node.js 22+ (to build from source).

Download a prebuilt release (`SSH Vault-x.x.x-setup.exe` installer or the portable exe) from
[Releases](https://github.com/mohammadhosseinjafaripour/SSH-Manager/releases), or build it
yourself:

```bash
git clone https://github.com/mohammadhosseinjafaripour/SSH-Manager.git
cd SSH-Manager
npm install
npm run dev        # development (Electron + hot reload)
npm run verify     # typecheck + unit tests + lint + audit
npm run package    # NSIS installer + portable exe (release/)
```

There is also a browser-only development mode with a mock SSH backend — handy for working on
the UI without touching real servers:

```bash
npm run dev:ui     # serves the renderer at http://localhost:5188
```


## Features (MVP)

- **Master-password vault** — Argon2id + AES-256-GCM encrypted file at
  `%LOCALAPPDATA%\SSHVault\vault.bin`. Zero-knowledge: a forgotten master password means the
  vault cannot be recovered (stated at setup).
- **Servers, one click away** — named entries with host, port, username, tags and notes;
  add/edit/delete (delete requires typing the server name); instant search (`Ctrl+Shift+F`).
- **Tabbed terminals** — xterm.js with 256-color support, copy-on-select, right-click paste,
  reconnect, per-tab status (connecting / connected / **ROOT** / failed).
- **Auto-sudo elevation** — per server: `sudo -s`, `sudo -i`, `sudo su -` or a custom sudo
  command; the sudo password defaults to the login password (a separate one can be stored).
- **Host-key protection (TOFU)** — the SHA256 fingerprint is pinned on first connect and shown
  for approval; any later change hard-refuses the connection and offers a side-by-side
  comparison with a typed-confirmation replacement flow.
- **Auto-lock** — after a configurable idle time the vault re-locks; running sessions stay
  alive, reconnecting requires the master password. `Ctrl+Shift+L` locks immediately.
- **Keyboard-interactive auth** — hidden `Password:` prompts are auto-answered; OTP/2FA
  challenges appear in a dialog honoring each prompt's echo flag.
- Dark/light/system themes, durable vault writes with two backup generations.

## Keyboard shortcuts

Inside the terminal app shortcuts use `Ctrl+Shift+*` so plain `Ctrl+L`, `Ctrl+W`, `Ctrl+N`
always reach your remote shell. Outside the terminal plain `Ctrl+*` also works.

| Action | Shortcut |
| --- | --- |
| Lock vault | `Ctrl+Shift+L` |
| Close tab | `Ctrl+Shift+W` |
| Search | `Ctrl+Shift+F` (plain `Ctrl+F` outside terminal) |
| New server | `Ctrl+Shift+N` (plain `Ctrl+N` outside terminal) |
| Cycle tabs | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Copy in terminal | select text, or `Ctrl+Shift+C` |
| Paste in terminal | right-click or `Ctrl+Shift+V` |

## Security design

**Threat model — defended against**

- *Vault theft at rest*: the vault file is useless without your master password
  (Argon2id, 64 MiB / 3 passes / 4 lanes, 16-byte salt; AES-256-GCM with the header bound as
  AAD — tampering or a wrong password both fail authentication).
- *Casual shoulder-surfing*: lock screen hides all content; auto-lock after idle; passwords are
  masked in the UI.
- *Host-key MITM on first connect*: you see and approve the fingerprint before any credential
  is sent — host verification happens **before** authentication, so passwords never travel to
  an unverified host.
- *Password exposure during sudo*: elevation sends the password only after detecting sudo's
  unique per-attempt prompt marker, exactly once, with terminal echo disabled — it never
  appears on screen, and is never sent on NOPASSWD servers (no prompt, no send, ever).
  The sudo secret travels only inside the encrypted SSH channel.
- *Malicious web content*: the renderer is sandboxed with `contextIsolation`, no Node access,
  a strict CSP, no remote content, and a single-instance lock. Packaged builds flip Electron
  fuses (no `runAsNode`, no inspect, ASAR-only with embedded integrity).

**Explicitly out of scope**: malware already running as your Windows user can read keystrokes
and memory of any application, including this one. No local tool can defend against that.

**Update policy**: no auto-update (supply-chain risk); check releases manually and verify the
download. Production dependency audit: `npm audit --omit=dev` is clean at release.

## Auto-sudo: how it stays safe

```
stty -echo; sudo -S -k -p '[SSHVAULT:<nonce>]' -s; stty echo
```

- `-k` makes the prompt deterministic (kills cached sudo tickets)
- the per-attempt `nonce` prevents false matches on banners/MOTD; the detector ignores the
  marker when it appears quoted (the terminal's echo of the command itself)
- the password is written **only** on an exact match of the bare marker — once, never on
  timeout, never retried, never speculatively
- no timed writes anywhere: a timed `stty echo` could be eaten by sudo as a second password
  attempt and lock the account on slow-auth servers; echo is restored by the trailing
  `; stty echo` instead
- NOPASSWD servers (no prompt) and missing sudo are detected and reported — nothing is ever
  written into the live shell

This behavior is pinned by unit tests in `tests/elevate.test.ts`.

## Vault tools & backups

Every save writes: temp file → fsync → copy previous good file to `.bak` (rotating `.bak2`)
→ atomic replace. `Unlock → "Vault tools — restore a backup"` verifies a backup with your
master password and restores it; the displaced file is kept as `vault.bin.corrupt-<ts>`.

## Known limitations (MVP)

- No code signing yet — Windows SmartScreen will warn on first run
  ("More info → Run anyway").
- Password authentication only; SSH keys/agent, SFTP and port forwarding are on the v2 list.
- Automated E2E tests are not included; the security-critical modules (vault crypto, elevation
  detector, host-key verifier, schemas) are covered by 43 unit tests.

## License

MIT
