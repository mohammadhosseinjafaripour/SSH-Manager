import { create } from 'zustand'
import type { ServerUpsertInput, ServerView, VaultSettings } from '@shared/types'

export type VaultPhase = 'loading' | 'setup' | 'locked' | 'unlocked'

interface VaultState {
  phase: VaultPhase
  settings: VaultSettings
  servers: ServerView[]
  init: () => Promise<void>
  create: (masterPassword: string) => Promise<void>
  unlock: (masterPassword: string) => Promise<void>
  applyLocked: () => void
  setServers: (servers: ServerView[]) => void
  upsert: (input: ServerUpsertInput) => Promise<string>
  remove: (id: string) => Promise<void>
  updateSettings: (patch: Partial<VaultSettings>) => Promise<VaultSettings>
}

export const useVault = create<VaultState>((set) => ({
  phase: 'loading',
  settings: {
    idleLockMinutes: 10,
    theme: 'dark',
    keepAlive: true,
    autoReconnect: true,
    autocomplete: true,
    autoUpdate: true
  },
  servers: [],

  init: async () => {
    const { exists } = await window.sshvault.vaultStatus()
    set({ phase: exists ? 'locked' : 'setup' })
  },

  create: async (masterPassword) => {
    const state = await window.sshvault.vaultCreate(masterPassword)
    set({ phase: 'unlocked', settings: state.settings, servers: state.servers })
  },

  unlock: async (masterPassword) => {
    const state = await window.sshvault.vaultUnlock(masterPassword)
    set({ phase: 'unlocked', settings: state.settings, servers: state.servers })
  },

  applyLocked: () => set({ phase: 'locked' }),

  setServers: (servers) => set({ servers }),

  upsert: async (input) => {
    const { servers, id } = await window.sshvault.serversUpsert(input)
    set({ servers })
    return id
  },

  remove: async (id) => {
    const { servers } = await window.sshvault.serversDelete(id)
    set({ servers })
  },

  updateSettings: async (patch) => {
    const settings = await window.sshvault.settingsUpdate(patch)
    set({ settings })
    return settings
  }
}))

export function serverById(id: string): ServerView | undefined {
  return useVault.getState().servers.find((s) => s.id === id)
}
