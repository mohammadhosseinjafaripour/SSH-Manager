import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Windows Hello unlock.
 *
 * The vault key (the Argon2id-derived AES key) is wrapped with a fresh random
 * 32-byte KEK; the KEK itself is protected with DPAPI (CurrentUser scope) and
 * unwrapping it requires a Windows Hello prompt (fingerprint, face or PIN)
 * raised through UserConsentVerifier. The wrapped material lives beside the
 * vault as `vault.bin.hello` and can be deleted at any time — the master
 * password always remains a full, independent unlock path.
 *
 * Threat model: DPAPI CurrentUser means anything running as this user could
 * unwrap the KEK — which is exactly why the Hello consent prompt is mandatory,
 * not decorative: without a verified fingerprint/PIN the KEK never leaves the
 * protection call.
 */

export const HELLO_FILE = 'vault.bin.hello'

/** Domain separation: the wrap is bound to this app and this vault directory. */
export function helloEntropy(dir: string): Buffer {
  // Not secret — DPAPI entropy just stops other apps' blobs being reused here.
  return Buffer.from(`ssh-vault-hello:${join(dir, 'vault.bin')}`, 'utf8')
}

export interface HelloFile {
  version: 1
  provider: 'windows-dpapi-user'
  createdAt: string
  /** DPAPI(CurrentUser)-protected KEK, base64. */
  kekB64: string
  /** AES-256-GCM wrapped vault key under the KEK, base64 of {iv,tag,ct}. */
  wrappedB64: string
}

export class HelloDecryptError extends Error {
  constructor() {
    super('unlock-failed')
  }
}

const HELLO_AAD = 'ssh-vault-hello-v1'

/** Wraps the vault key under a KEK (pure — unit-testable without Windows). */
export function sealHelloFile(kek: Buffer, vaultKey: Buffer): Omit<HelloFile, 'kekB64'> {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', kek, iv)
  cipher.setAAD(Buffer.from(HELLO_AAD, 'utf8'))
  const ct = Buffer.concat([cipher.update(vaultKey), cipher.final()])
  const blob = Buffer.concat([
    iv,
    cipher.getAuthTag(),
    ct
  ])
  return {
    version: 1,
    provider: 'windows-dpapi-user',
    createdAt: new Date().toISOString(),
    wrappedB64: blob.toString('base64')
  }
}

/** Recovers the vault key; throws HelloDecryptError on any tamper. */
export function openHelloFile(file: HelloFile, kek: Buffer): Buffer {
  try {
    const blob = Buffer.from(file.wrappedB64, 'base64')
    const iv = blob.subarray(0, 12)
    const tag = blob.subarray(12, 28)
    const ct = blob.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', kek, iv)
    decipher.setAAD(Buffer.from(HELLO_AAD, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    throw new HelloDecryptError()
  }
}

// ---------------------------------------------------------------------------
// Windows adapter: DPAPI + UserConsentVerifier via PowerShell. The raw KEK
// only ever travels over stdio pipes, never over the command line.
// ---------------------------------------------------------------------------

const PROTECT_PS = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$in=[Console]::In.ReadToEnd().Trim()
$bytes=[Convert]::FromBase64String($in)
$entropy=[Convert]::FromBase64String($args[0])
$out=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))
`

const UNPROTECT_PS = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$in=[Console]::In.ReadToEnd().Trim()
$bytes=[Convert]::FromBase64String($in)
$entropy=[Convert]::FromBase64String($args[0])
$out=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))
`

// WinRT async bridging: PowerShell can't await IAsyncOperation natively, so we
// project it to a Task via WindowsRuntimeSystemExtensions.AsTask.
const CONSENT_PS = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'})[0]
function Await($op,$t){$task=$asTask.MakeGenericMethod($t).Invoke($null,@($op));$task.Wait(60000)|Out-Null;$task.Result}
$op=[Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($args[0])
$result=Await $op ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
"$result"
`

const CONSENT_AVAIL_PS = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'})[0]
function Await($op,$t){$task=$asTask.MakeGenericMethod($t).Invoke($null,@($op));$task.Wait(60000)|Out-Null;$task.Result}
$op=[Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()
$result=Await $op ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
"$result"
`

function ps(script: string, args: string[], stdin?: string): string {
  // The `& { }` wrapper is not cosmetic: with a bare -Command <script>, every
  // following argument is joined into the command text (and executed as
  // code); inside a script block they arrive properly as $args.
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `& { ${script} }`,
      ...args
    ],
    { encoding: 'utf8', input: stdin, timeout: 30_000 }
  )
  if (r.error || r.status !== 0) {
    throw new Error(`powershell failed: ${r.error?.message ?? r.stderr?.slice(0, 200) ?? r.status}`)
  }
  return (r.stdout ?? '').trim()
}

export function helloPlatformSupported(): boolean {
  return process.platform === 'win32'
}

let availability: 'available' | 'unavailable' | 'unknown' = 'unknown'

/**
 * Whether this Windows user has Hello configured (PIN or biometric). Cached —
 * the check spawns PowerShell and the answer only changes in Settings.
 */
export function helloConsentAvailable(): boolean {
  if (!helloPlatformSupported()) return false
  if (availability !== 'unknown') return availability === 'available'
  try {
    const out = ps(CONSENT_AVAIL_PS, [])
    availability = out === 'Available' ? 'available' : 'unavailable'
  } catch {
    availability = 'unavailable'
  }
  return availability === 'available'
}

/** Test helper: forget the cached availability probe. */
export function resetHelloAvailabilityForTest(): void {
  availability = 'unknown'
}

/** Raises the Windows Hello prompt; true only when verification succeeded. */
function defaultConsent(prompt: string): boolean {
  if (!helloPlatformSupported()) return false
  try {
    return ps(CONSENT_PS, [prompt]) === 'Verified'
  } catch {
    return false
  }
}

/** Test seam: swap the modal prompt for a stub so pipelines run headless. */
let consentPrompt: (prompt: string) => boolean = defaultConsent

export function requestHelloConsent(prompt: string): boolean {
  return consentPrompt(prompt)
}

export function setHelloConsentPromptForTest(fn: ((prompt: string) => boolean) | null): void {
  consentPrompt = fn ?? defaultConsent
}

async function protectDpapi(data: Buffer, entropy: Buffer): Promise<Buffer> {
  const out = ps(PROTECT_PS, [entropy.toString('base64')], data.toString('base64'))
  return Buffer.from(out, 'base64')
}

async function unprotectDpapi(blob: Buffer, entropy: Buffer): Promise<Buffer> {
  try {
    const out = ps(UNPROTECT_PS, [entropy.toString('base64')], blob.toString('base64'))
    return Buffer.from(out, 'base64')
  } catch {
    throw new HelloDecryptError()
  }
}

export function helloFilePath(dir: string): string {
  return join(dir, HELLO_FILE)
}

export function helloEnabled(dir: string): boolean {
  return existsSync(helloFilePath(dir))
}

/** Writes the DPAPI-wrapped KEK + wrapped vault key. Vault must be unlocked. */
export async function enableHelloUnlock(dir: string, vaultKey: Buffer): Promise<void> {
  const kek = randomBytes(32)
  try {
    const blob = await protectDpapi(kek, helloEntropy(dir))
    const file: HelloFile = {
      ...sealHelloFile(kek, vaultKey),
      kekB64: blob.toString('base64')
    }
    writeFileSync(helloFilePath(dir), JSON.stringify(file, null, 2), 'utf8')
  } finally {
    kek.fill(0)
  }
}

/** Removes the Hello unlock (idempotent). */
export function disableHelloUnlock(dir: string): void {
  rmSync(helloFilePath(dir), { force: true })
}

/**
 * Runs the Hello consent prompt, unwraps the KEK via DPAPI and returns the
 * vault key. Throws HelloDecryptError when anything fails to unwrap and
 * `hello-cancelled` when the user dismissed the prompt.
 */
export async function unwrapHelloKey(dir: string): Promise<Buffer> {
  let file: HelloFile
  try {
    file = JSON.parse(readFileSync(helloFilePath(dir), 'utf8')) as HelloFile
  } catch {
    throw new HelloDecryptError()
  }
  if (file?.version !== 1 || typeof file.kekB64 !== 'string' || typeof file.wrappedB64 !== 'string') {
    throw new HelloDecryptError()
  }
  if (!requestHelloConsent('Unlock SSH Vault')) {
    throw new Error('hello-cancelled')
  }
  const kek = await unprotectDpapi(Buffer.from(file.kekB64, 'base64'), helloEntropy(dir))
  try {
    return openHelloFile(file, kek)
  } finally {
    kek.fill(0)
  }
}
