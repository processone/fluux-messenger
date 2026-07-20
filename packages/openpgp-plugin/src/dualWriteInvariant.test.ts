import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Finding 4 (Phase B1 final review): nothing STRUCTURAL stops a future base
 * method (or a subclass) from calling
 * `this.hostStores.verifiedPeers.setVerified(...)` / `.clearVerified(...)`
 * directly and skipping the plugin-owned `VerifiedKeysCache`, inside THIS
 * package. Scope note (re-review Finding 4): this guard only scans
 * `packages/openpgp-plugin` — it does NOT scan `apps/fluux` and so could
 * never have caught the historical `ChatView.tsx` verify/revoke bypass,
 * which lived in the app. What it guards is narrower and still real: a
 * future addition inside this package that reaches past
 * `setVerifiedDual`/`clearVerifiedDual` and writes `hostStores.verifiedPeers`
 * directly, silently diverging the cache and the legacy mirror.
 *
 * This test is the durable guard: it reads every production source file in
 * this package and asserts the full set of `hostStores.verifiedPeers.*`
 * references is EXACTLY the five sanctioned ones in `OpenPGPPluginBase.ts`:
 *
 *   - `setVerifiedDual`'s body   → `.setVerified(...)`
 *   - `clearVerifiedDual`'s body → `.clearVerified(...)`
 *   - `init()`'s one-time seed   → `.getAll()`
 *   - `activateSubscriptions()`'s two `.subscribe(...)` registrations
 *
 * Every OTHER verified-state write must go through `setVerifiedDual` /
 * `clearVerifiedDual` (which keep the cache and the mirror consistent) —
 * never call `hostStores.verifiedPeers` directly from anywhere else. If
 * this test fails, a new call site was added that bypasses the dual-write
 * helpers; either route it through them, or through `verifiedKeys` directly
 * for a pure cache read, and update the sanctioned list below only if the
 * new site is a deliberate, reviewed addition to the dual-write contract.
 *
 * Test files (and the `testSupport`/`testing` helper directories used only
 * by tests) are excluded from the scan: they legitimately poke the legacy
 * mirror directly to set up fixtures (e.g. simulating pre-existing legacy
 * data before a plugin `init()` seeds from it, or recording calls through
 * an override), which isn't the production bypass this guard exists to
 * catch.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url))
const REFERENCE_PATTERN = /hostStores\.verifiedPeers\.(\w+)/g
const EXCLUDED_DIRS = new Set(['testSupport', 'testing', 'fixtures'])

const SANCTIONED = [
  'OpenPGPPluginBase.ts:clearVerified',
  'OpenPGPPluginBase.ts:getAll',
  'OpenPGPPluginBase.ts:setVerified',
  'OpenPGPPluginBase.ts:subscribe',
  'OpenPGPPluginBase.ts:subscribe',
].sort()

function collectProductionSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      out.push(...collectProductionSourceFiles(full))
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue
    out.push(full)
  }
  return out
}

/**
 * Strips line comments and block comments (a doc comment mentioning
 * `hostStores.verifiedPeers.getAll()` in prose would otherwise be a false
 * positive) while leaving string/template literal CONTENTS alone, so a
 * comment-stripped slash inside a string doesn't corrupt the rest of the
 * file. Not a full TS tokenizer (doesn't special-case regex literals), but
 * sufficient for scanning this package's source for a specific dotted call
 * expression.
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += c
      i++
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i]
          i++
          if (i < n) {
            out += src[i]
            i++
          }
          continue
        }
        out += src[i]
        i++
      }
      if (i < n) {
        out += src[i]
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

describe('dual-write invariant guard (Finding 4)', () => {
  it('every hostStores.verifiedPeers reference in production source is one of the five sanctioned dual-write sites', () => {
    const files = collectProductionSourceFiles(SRC_DIR)
    const hits: string[] = []
    for (const file of files) {
      const content = stripComments(readFileSync(file, 'utf8'))
      const base = file.split('/').pop() as string
      for (const match of content.matchAll(REFERENCE_PATTERN)) {
        hits.push(`${base}:${match[1]}`)
      }
    }

    expect(
      hits.sort(),
      'A hostStores.verifiedPeers reference was added outside the sanctioned dual-write sites. ' +
        'Writes must go through setVerifiedDual/clearVerifiedDual (or read through the ' +
        'VerifiedKeysCache) or the cache and the legacy mirror can silently diverge — this is ' +
        'exactly the class of bypass this guard exists to catch inside this package.',
    ).toEqual(SANCTIONED)
  })
})
