// Hardens the packaged binary via @electron/fuses:
//  - runAsNode off: the exe can't be turned into a plain node runtime
//  - nodeCliInspect off: no --inspect debugger injection
//  - OnlyLoadAppFromAsar + embedded ASAR integrity: code can't be swapped
const { join } = require('node:path')
const { rmSync, statSync } = require('node:fs')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')


/**
 * Removes Electron runtime files this app never loads. Each entry must be a
 * genuine non-feature:
 *
 *  - dxcompiler.dll / d3dcompiler_47.dll : DirectX shader compilers used only
 *    by WebGPU / WebGL2. This app is a terminal + file manager; it never
 *    creates a webgl context (verified: no canvas/webgl usage in src/).
 *  - vk_swiftshader* : software Vulkan ICD, a GPU-less fallback for the above.
 *
 * Deliberately NOT removed: ffmpeg.dll (Chromium may reference it), icudtl.dat
 * (text/unicode data we do use), resources.pak (Chromium assets), or any
 * licence file (legal requirement).
 */
const REMOVABLE_RUNTIME_FILES = [
  'dxcompiler.dll',
  'd3dcompiler_47.dll',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll'
]

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

module.exports = async function afterPack(context) {
  const productFilename = context.packager.appInfo.productFilename
  const ext = process.platform === 'win32' ? '.exe' : ''
  const executablePath = join(context.appOutDir, productFilename + ext)

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
