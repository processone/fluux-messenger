import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Originally (Finding 4, Phase B1 final review): nothing STRUCTURAL stopped
 * a future base method (or a subclass) from calling
 * `this.hostStores.verifiedPeers.setVerified(...)` / `.clearVerified(...)`
 * directly and skipping the plugin-owned `VerifiedKeysCache`, inside THIS
 * package — so this test enumerated the sanctioned dual-write call sites and
 * failed if a new, unreviewed one appeared.
 *
 * Phase B2 Task 8 deleted `hostStores.verifiedPeers` entirely:
 * `OpenPGPHostStores` no longer declares the field, and
 * `setVerifiedDual`/`clearVerifiedDual` write only the plugin-owned cache.
 * The sanctioned list that finding produced is now empty by construction —
 * there is nothing left to enumerate. Rather than delete this guard, it is
 * retargeted to the inverse, stronger property: no reference to
 * `hostStores.verifiedPeers` exists ANYWHERE in this package's production
 * source, full stop. This keeps a live regression net against the coupling
 * coming back — e.g. a copy-pasted dual-write snippet from an old branch, or
 * a future contributor reinventing a "mirror" for some other consumer.
 *
 * Same production-source-only scope as before: test files and the
 * `testSupport`/`testing`/`fixtures` helper directories are excluded, since
 * a NEGATIVE fixture (proving some code path does NOT consult
 * `hostStores.verifiedPeers`) or a historical regression test may
 * legitimately still reference the now-removed shape in a comment or a
 * deliberately-absent mock.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url))
const REFERENCE_PATTERN = /hostStores\.verifiedPeers\b/g
const EXCLUDED_DIRS = new Set(['testSupport', 'testing', 'fixtures'])

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
 * `hostStores.verifiedPeers` in prose would otherwise be a false positive)
 * while leaving string/template literal CONTENTS alone, so a
 * comment-stripped slash inside a string doesn't corrupt the rest of the
 * file. Not a full TS tokenizer (doesn't special-case regex literals), but
 * sufficient for scanning this package's source for a specific dotted
 * property reference.
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

describe('legacy verified-peers mirror stays deleted (Finding 4 follow-up, Phase B2 Task 8)', () => {
  it('no hostStores.verifiedPeers reference remains in production source', () => {
    const files = collectProductionSourceFiles(SRC_DIR)
    const hits: string[] = []
    for (const file of files) {
      const content = stripComments(readFileSync(file, 'utf8'))
      const base = file.split('/').pop() as string
      for (const _match of content.matchAll(REFERENCE_PATTERN)) {
        hits.push(base)
      }
    }

    expect(
      hits,
      'A hostStores.verifiedPeers reference was found in production source. Phase B2 Task 8 deleted the ' +
        'legacy mirror entirely — OpenPGPHostStores no longer declares a verifiedPeers field, and ' +
        'setVerifiedDual/clearVerifiedDual write only the plugin-owned VerifiedKeysCache. Route ' +
        'verified-state writes through those two methods instead of reintroducing this reference.',
    ).toEqual([])
  })
})
