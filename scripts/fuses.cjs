// Hardens the packaged binary via @electron/fuses:
//  - runAsNode off: the exe can't be turned into a plain node runtime
//  - nodeCliInspect off: no --inspect debugger injection
//  - OnlyLoadAppFromAsar + embedded ASAR integrity: code can't be swapped
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

module.exports = async function afterPack(context) {
  const { electronAppExecutablePath } = context
  await flipFuses(electronAppExecutablePath, {
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
