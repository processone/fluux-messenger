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
 * The layer is clean, and staying clean is the invariant. Two ways to break it:
 * importing a store directly, or importing a `core/` module that does (today
 * `clientConfig.ts`, which names the `SDKStores` bundle — that is exactly why
 * `XMPPClientConfig` lives there and not here).
 *
 * If you need a type here that a store also needs, declare it here and let the
 * store import it. Do not add an entry to either list below.
 */
const ALLOWED_TO_IMPORT_STORES: string[] = []

/** `core/` modules that reach a store, so importing them re-creates the edge. */
const CORE_MODULES_THAT_REACH_STORES = ['clientConfig']

const TYPES_DIR = dirname(fileURLToPath(import.meta.url))

function importSpecifiersOf(source: string): string[] {
  const specifiers = source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g)
  return [...specifiers].map(m => m[1])
}

/** Specifiers resolving somewhere under `src/stores/`. */
function storeImportsOf(source: string): string[] {
  return importSpecifiersOf(source).filter(spec => spec.split('/').includes('stores'))
}

/** Specifiers resolving to a `core/` module known to reach a store. */
function transitiveStoreImportsOf(source: string): string[] {
  return importSpecifiersOf(source).filter(spec =>
    CORE_MODULES_THAT_REACH_STORES.some(mod => spec === `../${mod}`)
  )
}

describe('core/types layering', () => {
  const files = readdirSync(TYPES_DIR).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))

  const offendersBy = (find: (source: string) => string[]) =>
    Object.fromEntries(
      files
        .map(file => [file, find(readFileSync(join(TYPES_DIR, file), 'utf8'))] as const)
        .filter(([, imports]) => imports.length > 0)
    )

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('declares domain types without importing a store', () => {
    expect(Object.keys(offendersBy(storeImportsOf)).sort()).toEqual(
      [...ALLOWED_TO_IMPORT_STORES].sort()
    )
  })

  it('does not reach a store through a core module either', () => {
    expect(Object.keys(offendersBy(transitiveStoreImportsOf))).toEqual([])
  })
})
