import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'

// The committed live icons (git HEAD) must equal the hollow variant's dist, so
// the shipped default can't silently drift from its source. Reads live bytes
// from git HEAD (not the working tree), so a local `plain` build does not trip
// this. hollow/dist is read from disk (it equals HEAD when committed).
const APP = process.cwd() // apps/fluux
const REPO = resolve(APP, '../..')
const HOLLOW_DIST = resolve(APP, 'src-tauri/icons/icon-variants/hollow/dist')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

describe('committed live icon default matches hollow/dist', () => {
  for (const kind of ['icons', 'public'] as const) {
    const base = join(HOLLOW_DIST, kind)
    for (const abs of walk(base)) {
      const rel = relative(base, abs)
      const repoRel =
        kind === 'icons'
          ? join('apps/fluux/src-tauri/icons', rel)
          : join('apps/fluux/public', rel)
      it(`live ${repoRel} == hollow/dist`, () => {
        const committed = execFileSync('git', ['show', `HEAD:${repoRel.split('\\').join('/')}`], {
          cwd: REPO,
          maxBuffer: 200 * 1024 * 1024,
        })
        expect(committed.equals(readFileSync(abs))).toBe(true)
      })
    }
  }
})
