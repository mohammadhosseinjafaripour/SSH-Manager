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
    build: {
      /*
       * Build the main process as CommonJS.
       *
       * The project is `"type": "module"`, so electron-vite defaults the main
       * bundle to ESM — which emits `import { autoUpdater } from
       * "electron-updater"`. That package is CommonJS with no `exports` field,
       * so Node's ESM loader cannot resolve it and the app dies at startup with
       * "SyntaxError: named export not found" BEFORE any error handler runs.
       *
       * CommonJS uses require(), which handles CommonJS dependencies natively.
       * The preload is already CJS for the sandbox, so this makes main and
       * preload consistent.
       */
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    },
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
