import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Finding 4 (Phase B1 final review): nothing STRUCTURAL stops a future base
 * method (or a subclass) from calling
 * `this.hostStores.verifiedPeers.setVerified(...)` / `.clearVerified(...)`
 * directly and skipping the plugin-owned `VerifiedKeysCache` — the exact
 * gap that let the `ChatView` verify/revoke bypass reach review undetected.
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

describe('dual-write invariant guard (Finding 4)', () => {
  it('every hostStores.verifiedPeers reference in production source is one of the five sanctioned dual-write sites', () => {
    const files = collectProductionSourceFiles(SRC_DIR)
    const hits: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
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
        'exactly the bypass class that slipped past review in ChatView.tsx before Finding 1/2 fixed it.',
    ).toEqual(SANCTIONED)
  })
})
