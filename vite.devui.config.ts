/**
 * Standalone dev server for the renderer only (UI work / browser smoke tests
 * without launching Electron). The dev mock bridge installs automatically
 * when `window.sshvault` is absent (see src/renderer/src/dev/install.ts).
 * Never used for production builds.
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  server: { port: 5188, strictPort: true }
})
