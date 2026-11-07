import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import { registerOsLock, clearClipboardOnQuit } from './security'
import { createEditorService, type EditorService } from './ssh/editor'
import { join } from 'node:path'
import { VAULT_LOCKED_CHANNEL } from '@shared/types'
import { registerIpc } from './ipc'
import { VaultStore } from './vault/store'
import { ConnectionManager } from './ssh/manager'
import { UpdateService, registerUpdateIpc } from './updater'

/**
 * Vault lives under %LOCALAPPDATA%\SSHVault (not the roaming profile), so a
 * domain account never copies the ciphertext between machines.
 */
const desiredUserData = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'SSHVault')
  : app.getPath('userData')
app.setPath('userData', desiredUserData)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let store: VaultStore | null = null
let manager: ConnectionManager | null = null
let lockTimer: ReturnType<typeof setInterval> | null = null
let updater: UpdateService | null = null
let tray: Tray | null = null
let editor: EditorService | null = null
let forceQuit = false
let trayNoticeShown = false

/**
 * Tray icon. While SSH sessions are alive, closing the window only hides it;
 * the tray keeps the app (and the connections) running, and its Quit action
 * ends everything explicitly.
 */
function trayIcon(): Electron.NativeImage {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "icons", "icon.png")
    : join(app.getAppPath(), 'build', 'icon.png')
  const img = nativeImage.createFromPath(iconPath)
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 })
}

/**
 * The window, but only if it is still usable.
 *
 * A BrowserWindow reference survives `destroy()` — calling `.restore()`,
 * `.focus()` or `.webContents.send()` on it afterwards throws
 * "Object has been destroyed" out of the main process, which Electron surfaces
 * to the user as the "A JavaScript error occurred in the main process" dialog.
 * Every path that touches the window outside a handler must go through this.
 */
function liveWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

function showMainWindow(): void {
  const existing = liveWindow()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }
  // Destroyed (or never created): rebuild and re-point every service at the
  // new webContents, or they would keep writing into the freed one.
  mainWindow = createWindow()
  manager?.refreshWebContents(mainWindow.webContents)
  updater?.attach(mainWindow)
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  tray = new Tray(trayIcon())
  tray.setToolTip('SSH Vault')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show SSH Vault', click: () => showMainWindow() },
      { type: "separator" },
      {
        label: 'Quit (closes all sessions)',
        click: () => {
          forceQuit = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
}

/**
 * Window close: with live sessions, hide to the tray and say so once. With
 * nothing connected, exit normally — exactly the behavior requested: the app
 * stays reachable from the tray only for as long as connections exist.
 */
function handleWindowClose(win: BrowserWindow): void {
  if (forceQuit) return
  const live = manager?.countLiveSessions() ?? 0
  if (live === 0) return
  win.hide()
  tray?.setToolTip(`SSH Vault — ${live} live session${live === 1 ? '' : 's'}`)
  if (!trayNoticeShown) {
    trayNoticeShown = true
    try {
      tray?.displayBalloon({
        iconType: 'info',
        title: 'SSH Vault is still connected',
        content: 'Your sessions keep running in the system tray. Quit from the tray menu to close everything.'
      })
    } catch {
      // displayBalloon is Windows-only; elsewhere the tray tooltip suffices.
    }
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    title: 'SSH Vault',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.on('close', () => handleWindowClose(win))
  // Drop the reference as soon as the window is gone. Leaving a destroyed
  // BrowserWindow in this variable is what allowed the second-instance crash:
  // every later `if (mainWindow)` check passed while the object was dead.
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // The app renders exactly one origin: block navigation and pop-ups.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env['ELECTRON_RENDERER_URL'] ?? ''
    if (url !== allowed && !url.startsWith('file://')) event.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function startAutoLock(): void {
  lockTimer = setInterval(() => {
    if (!store || !store.isUnlocked()) return
    const idleLimit = store.getPayload().settings.idleLockMinutes * 60_000
    if (store.idleMs() >= idleLimit) {
      store.lock()
      // `?.` alone is not enough: a destroyed window is non-null but throws
      // when its webContents is touched. Live sessions keep running, so this
      // timer can fire while the window is closed to the tray.
      const win = liveWindow()
      if (win) win.webContents.send(VAULT_LOCKED_CHANNEL)
    }
  }, 15_000)
}

/**
 * A second launch (shortcut, Start menu, pinned taskbar) reaches the running
 * instance here instead of starting a duplicate app. It must behave exactly
 * like the tray click: reveal the window, recreating it if the user closed it.
 *
 * This used to call `mainWindow.restore()/focus()` directly. After closing the
 * window to the tray, `mainWindow` was non-null but destroyed, so that threw
 * "Object has been destroyed" and Electron showed its main-process error
 * dialog — the bug this fixes.
 */
app.on('second-instance', () => {
  showMainWindow()
})

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)

  store = new VaultStore(app.getPath('userData'))
  mainWindow = createWindow()
  manager = new ConnectionManager(store, mainWindow.webContents)
  registerIpc(store, manager)

  // Auto-update: reads the user setting lazily so toggling it takes effect
  // without a restart.
  updater = new UpdateService(() => {
    try {
      return store!.getPayload().settings.autoUpdate !== false
    } catch {
      return true
    }
  })
  updater.attach(mainWindow)
  registerUpdateIpc(updater)
  updater.start()

  editor = createEditorService(store, () => mainWindow)

  createTray()

  // Lock on OS session lock / suspend: walking away always requires the
  // master password again. Live sessions keep running by design.
  registerOsLock(store, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vault:locked')
    }
  })

  startAutoLock()

  // macOS fires 'activate' when the dock icon is clicked. Reuse the same
  // recreation path as the tray/shortcut so the manager is re-pointed at the
  // new window instead of being replaced (which leaked the old one and left
  // IPC bound to the previous webContents).
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (lockTimer) clearInterval(lockTimer)
  manager?.closeAll()
  store?.lock()
  // With a tray, the app stays alive so the user can reopen it. Without one
  // (never created), exiting is the expected end.
  if (!tray) app.quit()
})

app.on('before-quit', () => {
  updater?.stop()
  editor?.stopAll()
  manager?.closeAll()
  store?.lock()
  clearClipboardOnQuit()
})
