import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `formatDateHeader` and `formatConversationTime` return relative labels ("Today",
 * "Yesterday") that are only correct at the instant they are computed. They are pure,
 * so nothing re-evaluates them when the local day rolls over — a window left open
 * overnight keeps rendering last night's answer.
 *
 * `useDayChange()` is the re-render trigger. This test is the structural guard: every
 * component that renders one of those labels must subscribe, so a sixth surface added
 * later cannot silently inherit the stale-label bug. It is deliberately a source scan
 * rather than five render tests — the property is "subscribes at all", and each of the
 * five components is separately covered for its own behaviour elsewhere.
 */

// vitest runs from apps/fluux; import.meta.url is not a file URL under jsdom
// (cf. e2ee/trustVisual.test.ts, which resolves sources the same way).
const SRC = join(process.cwd(), 'src')
const RELATIVE_FORMATTERS = ['formatDateHeader', 'formatConversationTime']

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    if (!/\.tsx?$/.test(entry)) return []
    if (/\.test\.tsx?$/.test(entry)) return []
    return [path]
  })
}

describe('relative date label freshness', () => {
  const consumers = sourceFiles(SRC)
    .filter((path) => !path.endsWith(join('utils', 'dateFormat.ts')))
    .filter((path) => {
      const source = readFileSync(path, 'utf8')
      return RELATIVE_FORMATTERS.some((fn) => source.includes(`${fn}(`))
    })

  it('finds the surfaces that render a relative date label', () => {
    // Guards the scan itself: an empty or collapsed list would make the assertion
    // below vacuously pass.
    expect(consumers.length).toBeGreaterThanOrEqual(5)
  })

  it.each(consumers.map((path) => [path.slice(SRC.length + 1), path]))(
    '%s subscribes to day changes',
    (_label, path) => {
      expect(readFileSync(path, 'utf8')).toContain('useDayChange()')
    }
  )
})
