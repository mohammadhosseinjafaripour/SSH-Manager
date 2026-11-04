import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'node:path'
import { VAULT_LOCKED_CHANNEL } from '@shared/types'
import { registerIpc } from './ipc'
import { VaultStore } from './vault/store'
import { ConnectionManager } from './ssh/manager'

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
      mainWindow?.webContents.send(VAULT_LOCKED_CHANNEL)
    }
  }, 15_000)
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)

  store = new VaultStore(app.getPath('userData'))
  mainWindow = createWindow()
  manager = new ConnectionManager(store, mainWindow.webContents)
  registerIpc(store, manager)
  startAutoLock()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      manager = new ConnectionManager(store!, mainWindow.webContents)
    }
  })
})

app.on('window-all-closed', () => {
  if (lockTimer) clearInterval(lockTimer)
  manager?.closeAll()
  store?.lock()
  app.quit()
})

app.on('before-quit', () => {
  manager?.closeAll()
  store?.lock()
})
