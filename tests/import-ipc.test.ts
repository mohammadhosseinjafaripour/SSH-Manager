import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Regression tripwire for the "An object could not be cloned" import failure.
 *
 * `applyImport` is async. When the vaultImportApply handler stored its result
 * without awaiting (`const summary = applyImport(...)`), the IPC reply embeded
 * a live Promise, which can never survive Electron's structured clone — every
 * import died with:
 *
 *   Error invoking remote method 'vault:import-apply':
 *   Error: An object could not be cloned.
 *
 * The unit suite never caught it because nothing serialized the reply. This
 * pins the source shape that guarantees the bug cannot silently return.
 */
describe('vaultImportApply reply is serializable', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'main', 'ipc.ts'), 'utf8')

  it('awaits applyImport before building the reply', () => {
    expect(source).not.toContain('const summary = applyImport(')
    // A bare assignment of the async call is the exact bug shape: the Promise
    // ends up nested inside the reply. (`return applyImport(...)` is fine —
    // the handle() wrapper awaits the handler's return value itself.)
    const bareAssignments = source.match(/(?<!await )\w+ = applyImport\(/g) ?? []
    expect(bareAssignments).toHaveLength(0)
  })
})
