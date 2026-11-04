import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const alias = {
  '@shared': resolve('shared')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // The renderer runs sandboxed, which requires a CommonJS preload.
      // With "type": "module" electron-vite would otherwise emit ESM
      // (index.mjs) — unsupported with sandbox: true.
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    },
    resolve: { alias }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        ...alias,
        '@renderer': resolve('src/renderer/src')
      }
    }
  }
})
