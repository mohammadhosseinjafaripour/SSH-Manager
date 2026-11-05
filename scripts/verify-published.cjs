/**
 * Verifies that a published release's assets are byte-identical to the local
 * build. Run after `gh release create` to prove the upload did not corrupt
 * anything — a truncated or mangled asset makes every auto-update fail its
 * sha512 check, and the failure surfaces only to the end user.
 *
 *   node scripts/verify-published.cjs [version]
 */
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const version = process.argv[2] ?? require('../package.json').version
const setup = join(__dirname, '..', 'release', `SSH-Vault-${version}-setup.exe`)
const manifestPath = join(__dirname, '..', 'release', 'latest.yml')

const manifest = readFileSync(manifestPath, 'utf8')
const expected = manifest.match(/sha512: (\S+)/)[1]
const expectedSize = Number(manifest.match(/size: (\d+)/)[1])

const localSize = statSync(setup).size
const localHash = createHash('sha512').update(readFileSync(setup)).digest('base64')

console.log(`local   size ${localSize}  sha512 ${localHash.slice(0, 16)}…`)
console.log(`manifest size ${expectedSize}  sha512 ${expected.slice(0, 16)}…`)

if (localSize !== expectedSize || localHash !== expected) {
  console.error('FAIL: local artifact does not match latest.yml')
  process.exit(1)
}
console.log('OK: local artifact matches the manifest')

// Download what users actually get and compare byte-for-byte.
const out = join(tmpdir(), `verify-${version}-setup.exe`)
const url = `https://github.com/mohammadhosseinjafaripour/SSH-Manager/releases/download/v${version}/SSH-Vault-${version}-setup.exe`
console.log(`downloading ${url}`)
try {
  execFileSync('curl', ['-sL', '--retry', '3', '--retry-all-errors', '-C', '-', url, '-o', out, '--max-time', '600'], {
    stdio: 'inherit'
  })
} catch {
  console.error('FAIL: download did not complete (network stall)')
  process.exit(1)
}

const dlSize = statSync(out).size
const dlHash = createHash('sha512').update(readFileSync(out)).digest('base64')
console.log(`downloaded size ${dlSize}  sha512 ${dlHash.slice(0, 16)}…`)

if (dlSize !== expectedSize || dlHash !== expected) {
  console.error('FAIL: published asset differs from the manifest — auto-update would break')
  process.exit(1)
}
console.log('PASS: published asset is byte-identical to the manifest')
