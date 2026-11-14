/**
 * Startup smoke test — launches the packaged app via the DevTools protocol
 * and asserts a renderer page with a non-empty title exists. Catches
 * black-window bugs (main-process module loading crashes) that `npm run
 * verify` cannot see because it never boots the packaged app.
 *
 *   node scripts/smoke-startup.cjs
 */
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const http = require('node:http')

// Packaged exe location differs per platform (win-unpacked / linux-unpacked /
// the .app bundle on macOS).
const EXE =
  process.platform === 'win32'
    ? join(__dirname, '..', 'release', 'win-unpacked', 'SSH Vault.exe')
    : process.platform === 'darwin'
      ? join(__dirname, '..', 'release', 'mac', 'SSH Vault.app', 'Contents', 'MacOS', 'SSH Vault')
      : join(__dirname, '..', 'release', 'linux-unpacked', 'ssh-vault')
const PORT = 9333
const WAIT_MS = 25_000

if (!existsSync(EXE)) {
  console.error(`smoke: packaged app not found at ${EXE}\n        run "npm run package" first`)
  process.exit(1)
}

function fetchTargets() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${PORT}/json/list`, { timeout: 2000 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve([])
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  // A separate profile: the app is single-instance per userData dir, so a
  // copy that happens to be running (or installed) would make this build exit
  // immediately and fail the smoke test for the wrong reason.
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // main/index.ts derives the vault dir from LOCALAPPDATA; isolate the
      // smoke run so a real install holding the single-instance lock can't
      // make this build exit immediately (false FAIL).
      LOCALAPPDATA: join(tmpdir(), 'sshvault-smoke-profile')
    }
  })

  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d.toString()))

  const started = Date.now()
  let targets = []
  while (Date.now() - started < WAIT_MS) {
    await sleep(1000)
    try {
      targets = await fetchTargets()
      if (targets.some((t) => t.type === 'page')) break
    } catch {
      // DevTools endpoint not up yet; keep waiting.
    }
  }

  // Always clean up, whatever the verdict.
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }

  const page = targets.find((t) => t.type === 'page')
  const fatal = /SyntaxError|Named export .* not found|Cannot find module/i.test(stderr)

  if (fatal) {
    console.error('FAIL: main process threw a fatal module error:')
    console.error(stderr.split('\n').filter((l) => /Error|export|module/i.test(l)).slice(0, 5).join('\n'))
    process.exit(1)
  }
  if (!page) {
    console.error('FAIL: no renderer target appeared within', WAIT_MS / 1000, 'seconds')
    if (stderr.trim()) console.error(stderr.split('\n').slice(0, 10).join('\n'))
    process.exit(1)
  }
  if (!page.title || page.title === 'undefined') {
    console.error('FAIL: renderer loaded but has no title — the UI likely crashed on mount')
    process.exit(1)
  }

  console.log(`PASS: app started, renderer title "${page.title}"`)
  process.exit(0)
})()
