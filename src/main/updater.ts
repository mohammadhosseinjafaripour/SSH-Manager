/**
 * Auto-update via GitHub Releases.
 *
 * Flow (all opt-out-able by the user):
 *   1. On launch, and every few hours, ask GitHub for the latest `latest.yml`.
 *   2. If a newer version exists, download the installer in the background.
 *   3. Tell the UI it is ready; the user chooses when to restart and install.
 *
 * Privacy: a check is a plain HTTPS GET to github.com for a public release
 * manifest — no identifiers, no telemetry. Users can disable it entirely in
 * Settings, in which case no request is ever made.
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { UpdateState } from '@shared/types'
import { describeNetworkError } from '@shared/network'

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours
/** Never check more often than this, even if the user spams the button. */
const MIN_MANUAL_INTERVAL_MS = 30_000

type GetSetting = () => boolean

export class UpdateService {
  private state: UpdateState = { phase: 'idle' }
  private timer: ReturnType<typeof setInterval> | null = null
  private lastCheck = 0
  private wc: BrowserWindow | null = null

  constructor(private readonly enabled: GetSetting) {}

  attach(win: BrowserWindow): void {
    this.wc = win
    autoUpdater.autoDownload = true
    // Installing must stay a deliberate user action: we never quit the app on
    // our own while they may have live SSH sessions open.
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false

    autoUpdater.on('checking-for-update', () => this.set({ phase: 'checking' }))
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.set({ phase: 'downloading', version: info.version, percent: 0 })
    })
    autoUpdater.on('download-progress', (p) => {
      this.set({
        phase: 'downloading',
        version: this.state.version,
        percent: Math.round(p.percent)
      })
    })
    autoUpdater.on('update-not-available', () => {
      this.set({ phase: 'up-to-date', checkedAt: new Date().toISOString() })
    })
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.set({ phase: 'ready', version: info.version })
    })
    autoUpdater.on('error', (err: Error) => {
      // A failed update check must never be disruptive — no dialog, just a
      // quiet status the Settings panel can show. Chromium net errors are
      // translated to plain language: users who are offline should not see
      // "net::ERR_CONNECTION_TIMED_OUT" and think the app is broken.
      this.set({ phase: 'error', error: describeNetworkError(err.message).text })
    })
  }

  /** Starts periodic checks if the user has them enabled. */
  start(): void {
    if (!this.enabled()) return
    // One check shortly after launch (delayed so it never competes with
    // startup work or the first SSH connection).
    setTimeout(() => void this.check(), 15_000)
    this.timer = setInterval(() => void this.check(), POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Checks for updates. Honours the user setting unless `manual` — pressing
   * "Check now" should work even right after disabling automatic checks.
   */
  async check(manual = false): Promise<UpdateState> {
    if (!manual && !this.enabled()) return { phase: 'disabled' }
    if (!app.isPackaged && !process.env.SSHVAULT_ALLOW_DEV_UPDATE) {
      // In dev there is no installed app to update; report honestly.
      return this.set({
        phase: 'disabled',
        error: 'Update checks are only available in an installed build'
      })
    }
    if (Date.now() - this.lastCheck < MIN_MANUAL_INTERVAL_MS) return this.state
    this.lastCheck = Date.now()
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      return this.set({
        phase: 'error',
        error: describeNetworkError(err instanceof Error ? err.message : 'Update check failed').text
      })
    }
    return this.state
  }

  /** Applies a downloaded update: quits and runs the installer. */
  install(): void {
    if (this.state.phase !== 'ready') return
    autoUpdater.quitAndInstall(false, true)
  }

  getState(): UpdateState {
    return this.state
  }

  /** Opens the GitHub releases page in the browser. */
  openReleasesPage(): void {
    void shell.openExternal('https://github.com/mohammadhosseinjafaripour/SSH-Manager/releases/latest')
  }

  private set(next: UpdateState): UpdateState {
    this.state = { ...next, checkedAt: next.checkedAt ?? this.state.checkedAt }
    try {
      if (this.wc && !this.wc.isDestroyed()) {
        this.wc.webContents.send('update:state', this.state)
      }
    } catch {
      /* window gone */
    }
    return this.state
  }
}

/** Registers the IPC surface for the updater. */
export function registerUpdateIpc(service: UpdateService): void {
  ipcMain.handle('update:state', () => service.getState())
  ipcMain.handle('update:check', () => service.check(true))
  ipcMain.handle('update:install', () => service.install())
  ipcMain.handle('update:open-releases', () => service.openReleasesPage())
}
