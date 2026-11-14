// Hardens the packaged binary via @electron/fuses:
//  - runAsNode off: the exe can't be turned into a plain node runtime
//  - nodeCliInspect off: no --inspect debugger injection
//  - OnlyLoadAppFromAsar + embedded ASAR integrity: code can't be swapped
const { join } = require('node:path')
const { readdirSync, rmSync, statSync } = require('node:fs')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

/**
 * Removes Electron runtime files this app never loads. Each entry must be a
 * genuine non-feature:
 *  - dxcompiler.dll / d3dcompiler_47.dll : DirectX shader compilers used only
 *    by WebGPU / WebGL2. This app is a terminal + file manager; it never
 *    creates a webgl context (verified: no canvas/webgl usage in src/).
 *  - vk_swiftshader* : software Vulkan ICD, a GPU-less fallback for the above.
 *
 * Windows-only names — Linux/mac builds don't ship these files at all, so the
 * list is skipped there rather than stat'd pointlessly.
 *
 * Deliberately NOT removed: ffmpeg.dll (Chromium may reference it), icudtl.dat
 * (text/unicode data we do use), resources.pak (Chromium assets), or any
 * licence file (legal requirement).
 */
const REMOVABLE_RUNTIME_FILES = process.platform === 'win32'
  ? [
      'dxcompiler.dll',
      'd3dcompiler_47.dll',
      'vk_swiftshader.dll',
      'vk_swiftshader_icd.json',
      'vulkan-1.dll'
    ]
  : []

function stripUnusedRuntime(appOutDir) {
  let saved = 0
  for (const name of REMOVABLE_RUNTIME_FILES) {
    const file = join(appOutDir, name)
    try {
      const size = statSync(file).size
      rmSync(file, { force: true })
      saved += size
    } catch {
      // File absent in this Electron version: nothing to do.
    }
  }
  return saved
}

/**
 * Locates the packed Electron binary from what electron-builder actually
 * wrote, instead of rebuilding the name from productFilename.
 *
 * The name differs per platform: Windows uses `SSH Vault.exe`, macOS the
 * `SSH Vault.app` bundle, but Linux derives it from the package `name`
 * (`ssh-vault`). Assuming productFilename everywhere made the Linux package
 * fail with ENOENT trying to open ".../linux-unpacked/SSH Vault".
 */
function findExecutable(context) {
  const { appOutDir } = context
  const productFilename = context.packager.appInfo.productFilename
  const candidates = (
    process.platform === 'darwin'
      ? [
          join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename),
          join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', context.packager.appInfo.sanitizedName)
        ]
      : process.platform === 'win32'
        ? [join(appOutDir, `${productFilename}.exe`)]
        : [
            context.packager.executableName
              ? join(appOutDir, context.packager.executableName)
              : null,
            join(appOutDir, context.packager.appInfo.sanitizedName),
            join(appOutDir, productFilename)
          ]
  ).filter(Boolean)

  for (const candidate of candidates) {
    // Never treat the output directory itself as the binary: `join(dir, '')`
    // collapses to dir and would pass an existsSync check.
    if (candidate === appOutDir) continue
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* not this one */
    }
  }
  // Last resort: the only top-level executable file in the bundle.
  const fallback = readdirSync(appOutDir).find((f) => {
    try {
      const st = statSync(join(appOutDir, f))
      if (!st.isFile()) return false
      return process.platform === 'win32' ? f.endsWith('.exe') : (st.mode & 0o111) !== 0
    } catch {
      return false
    }
  })
  if (fallback) return join(appOutDir, fallback)
  throw new Error(`afterPack: could not locate the packaged executable in ${appOutDir}`)
}

module.exports = async function afterPack(context) {
  const executablePath = findExecutable(context)

  // Trim runtime blobs before fuses are flipped (fuses touch the exe only).
  const saved = stripUnusedRuntime(context.appOutDir)
  if (saved > 0) console.log(`  • stripped unused runtime files: ${(saved / 1048576).toFixed(1)} MB`)

  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    resetAdHocDarwinSignature: false
  })
}
