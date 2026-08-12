import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `core/types` is the SDK's leaf layer: the domain vocabulary every other layer
 * names its own contracts in. A type declared here must not reach back into a
 * state implementation — doing so makes the whole core one mutually recursive
 * blob, forbids typechecking a protocol module in isolation, and hardwires
 * Zustand into a package documented as store-agnostic.
 *
 * Exactly one file is still allowed to, and it is tracked debt: `client.ts`
 * derives `StoreBindings` from the concrete store state types via
 * `Pick<ChatState, …>`. Emptying this allowlist is the point of that follow-up
 * work: the port has to be declared in domain terms, with the stores proving
 * conformance to it rather than the reverse.
 *
 * When you remove the last entry, assert an empty array — do not delete the
 * test.
 */
const ALLOWED_TO_IMPORT_STORES = ['client.ts']

const TYPES_DIR = dirname(fileURLToPath(import.meta.url))

/** Relative specifiers that resolve somewhere under `src/stores/`. */
function storeImportsOf(source: string): string[] {
  const specifiers = source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g)
  return [...specifiers].map(m => m[1]).filter(spec => spec.split('/').includes('stores'))
}

describe('core/types layering', () => {
  const files = readdirSync(TYPES_DIR).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('declares domain types without importing a store', () => {
    const offenders = Object.fromEntries(
      files
        .map(file => [file, storeImportsOf(readFileSync(join(TYPES_DIR, file), 'utf8'))] as const)
        .filter(([, imports]) => imports.length > 0)
    )

    expect(Object.keys(offenders).sort()).toEqual([...ALLOWED_TO_IMPORT_STORES].sort())
  })
})
