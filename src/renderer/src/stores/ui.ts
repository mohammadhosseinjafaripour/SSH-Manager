import { create } from 'zustand'
import type { ServerView } from '@shared/types'

export interface HostKeyDialogState {
  sessionId: string
  serverId: string
  serverName: string
  kind: 'unknown' | 'changed'
  fingerprint: string
  pinnedFingerprint?: string
}

export interface KiDialogState {
  sessionId: string
  name: string
  instruction: string
  prompts: ReadonlyArray<{ prompt: string; echo: boolean }>
}

export interface TransferState {
  mode: 'export' | 'import' | 'csv-export'
}

/** Health-check progress, kept outside the vault store (ephemeral). */
export interface HealthState {
  running: boolean
  checkedAt: string | null
  results: Record<string, { status: string; latencyMs?: number; detail?: string }>
}

interface UiState {
  search: string
  activeTag: string | null
  serverFormOpen: boolean
  editing: ServerView | null
  deleteTarget: ServerView | null
  settingsOpen: boolean
  vaultToolsOpen: boolean
  transfer: TransferState | null
  hostkey: HostKeyDialogState | null
  ki: KiDialogState | null
  health: HealthState
  setHealth: (health: HealthState) => void
  setSearch: (search: string) => void
  setActiveTag: (tag: string | null) => void
  openServerForm: (editing: ServerView | null) => void
  closeServerForm: () => void
  openDelete: (server: ServerView) => void
  closeDelete: () => void
  setSettingsOpen: (open: boolean) => void
  setVaultToolsOpen: (open: boolean) => void
  openTransfer: (mode: TransferState['mode']) => void
  closeTransfer: () => void
  openHostKey: (state: HostKeyDialogState) => void
  closeHostKey: () => void
  openKi: (state: KiDialogState) => void
  closeKi: () => void
}

export const useUi = create<UiState>((set) => ({
  search: '',
  activeTag: null,
  serverFormOpen: false,
  editing: null,
  deleteTarget: null,
  settingsOpen: false,
  vaultToolsOpen: false,
  transfer: null,
  hostkey: null,
  ki: null,
  health: { running: false, checkedAt: null, results: {} },
  setHealth: (health) => set({ health }),
  setSearch: (search) => set({ search }),
  setActiveTag: (activeTag) => set({ activeTag }),
  openServerForm: (editing) => set({ serverFormOpen: true, editing }),
  closeServerForm: () => set({ serverFormOpen: false, editing: null }),
  openDelete: (deleteTarget) => set({ deleteTarget }),
  closeDelete: () => set({ deleteTarget: null }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setVaultToolsOpen: (vaultToolsOpen) => set({ vaultToolsOpen }),
  openTransfer: (mode) => set({ transfer: { mode } }),
  closeTransfer: () => set({ transfer: null }),
  openHostKey: (hostkey) => set({ hostkey }),
  closeHostKey: () => set({ hostkey: null }),
  openKi: (ki) => set({ ki }),
  closeKi: () => set({ ki: null })
}))
