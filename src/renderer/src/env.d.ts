/// <reference types="vite/client" />

import type { Bridge } from '@shared/types'

declare global {
  interface Window {
    sshvault: Bridge
  }
}

export {}
