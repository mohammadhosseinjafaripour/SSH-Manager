/**
 * Single-instance / tray regression test.
 *
 * Reproduces the reported bug: the app is running (possibly hidden to the
 * tray), the user opens it again from the shortcut, and the second launch must
 * hand off to the first instance WITHOUT the main process throwing.
 *
 * The failure it guards against:
 *
 *   app.on('second-instance', () => {
 *     if (mainWindow) {                 // non-null, but `destroy()`ed
 *       mainWindow.restore()            // → "Object has been destroyed"
 *
 * After closing the window (with live sessions it hides; otherwise it is
 * destroyed) `mainWindow` was never cleared, so a later shortcut launch
 * dereferenced a dead BrowserWindow. Electron reports that as
 * "A JavaScript error occurred in the main process".
 *
 * What this test asserts:
 *   1. the first launch stays alive and serves a renderer,
 *   2. a second launch exits instead of opening a duplicate app,
 *   3. the first instance prints no "Object has been destroyed" / uncaught
 *      main-process exception,
 *   4. the renderer is still reachable afterwards (the window was re-shown).
 *
 *   node scripts/smoke-single-instance.cjs
 */
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const http = require('node:http')

const EXE = join(__dirname, '..', 'release', 'win-unpacked', 'SSH Vault.exe')
const PORT = 9334
const WAIT_MS = 25_000
const SECOND_EXIT_MS = 20_000

if (!existsSync(EXE)) {
  console.error(`smoke: packaged app not found at ${EXE}\n        run "npm run package" first`)
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function waitForRenderer(deadlineMs) {
  const started = Date.now()
  let targets = []
  while (Date.now() - started < deadlineMs) {
    await sleep(700)
    try {
      targets = await fetchTargets()
      if (targets.some((t) => t.type === 'page')) return targets
    } catch {
      /* endpoint not up yet */
    }
  }
  return targets
}

/** Resolves with the exit code, or 'timeout' if it never exited. */
function waitForExit(child, ms) {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        resolve('timeout')
      }
    }, ms)
    child.on('exit', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(code)
    })
  })
}

/**
 * Closes the app's window by evaluating `window.close()` over the DevTools
 * protocol. Node's built-in WebSocket (22+) is used so this needs no deps.
 *
 * Closing the last window is what destroys the BrowserWindow: with no live
 * sessions the close handler deliberately does not hide it, so the app
 * survives only in the tray. That is the exact state the reported bug needed.
 */
function closeWindowViaCdp(wsUrl) {
  if (!wsUrl) throw new Error('no DevTools websocket for the renderer')
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    let ws
    try {
      ws = new WebSocket(wsUrl)
    } catch {
      done()
      return
    }
    ws.onopen = () => {
      try {
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression: 'window.close()' }
          })
        )
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        done()
      }, 1200)
    }
    ws.onerror = done
    ws.onclose = done
    // Never hang the test if the socket stalls.
    setTimeout(done, 6000)
  })
}

;(async () => {
  const first = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  first.stderr.on('data', (d) => (stderr += d.toString()))

  const cleanup = () => {
    try {
      first.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }

  const targets = await waitForRenderer(WAIT_MS)
  const page = targets.find((t) => t.type === 'page')
  if (!page) {
    cleanup()
    console.error('FAIL: first instance never rendered a page')
    if (stderr.trim()) console.error(stderr.split('\n').slice(0, 8).join('\n'))
    process.exit(1)
  }

  // Close the window BEFORE relaunching. This is the part that matters:
  // with no live SSH sessions, closing destroys the BrowserWindow while the
  // app keeps running in the tray. `mainWindow` used to stay non-null and
  // destroyed, so the next shortcut launch threw "Object has been destroyed".
  // Without this step the test only exercises a visible, healthy window and
  // passes even on the buggy build.
  await closeWindowViaCdp(page.webSocketDebuggerUrl)
  await sleep(2500)

  const afterClose = await fetchTargets().catch(() => [])
  const windowGone = !afterClose.some((t) => t.type === 'page')

  // Second launch: the "open from the shortcut while in the tray" path.
  const second = spawn(EXE, [], { stdio: ['ignore', 'pipe', 'pipe'] })
  const secondCode = await waitForExit(second, SECOND_EXIT_MS)
  if (secondCode === 'timeout') {
    try {
      second.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    cleanup()
    console.error('FAIL: the second launch kept running — duplicate instance instead of hand-off')
    process.exit(1)
  }

  // Give the first instance a moment to handle 'second-instance'.
  await sleep(3000)

  // The decisive assertion: after the hand-off the running app must show a
  // window again. On the buggy build the handler threw on the destroyed
  // object, so no window was ever recreated.
  const after = await waitForRenderer(12_000)
  const windowBack = after.some((t) => t.type === 'page')

  const destroyed = /Object has been destroyed/i.test(stderr)
  const uncaught = /A JavaScript error occurred in the main process/i.test(stderr)

  cleanup()

  if (destroyed || uncaught) {
    console.error('FAIL: main process threw when the second launch was handled')
    const lines = stderr.split('\n').filter((l) => /destroyed|JavaScript error|TypeError/i.test(l))
    console.error(lines.slice(0, 6).join('\n'))
    process.exit(1)
  }
  if (!windowBack) {
    console.error(
      `FAIL: no window after hand-off (window was ${windowGone ? 'destroyed' : 'present'} before relaunch)` +
        ' — the second-instance handler did not reopen it'
    )
    process.exit(1)
  }

  console.log('PASS: shortcut launch reopened the running instance after its window was closed')
  process.exit(0)
})()
