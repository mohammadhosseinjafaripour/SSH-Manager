import { createMockBridge } from './mock'

export function ensureDevBridge(): void {
  if (!window.sshvault) {
    window.sshvault = createMockBridge()
  }
}
