import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, relative } from 'path'

/**
 * Single-source guard for the frosted-glass modal chrome.
 *
 * The glass treatment (the `.modal-scrim` frosted backdrop + the `.fluux-glass`
 * translucent panel) once lived as a copy-pasted literal across every modal.
 * That duplication let individual dialogs silently drift — e.g. the verify-peer
 * dialog rendered a flat `bg-fluux-sidebar` panel while the command palette
 * rendered real glass, so the two had visibly different "intensity".
 *
 * The fix routed every modal through the shared <ModalOverlay> primitive. These
 * tests keep it that way: the glass class literals may appear ONLY in the two
 * shared primitives, and no component may hand-roll the old flat-panel chrome.
 * A new modal that types `modal-scrim`/`fluux-glass`/`bg-fluux-sidebar` directly
 * fails here, with the fix being "render through <ModalOverlay>".
 */

const componentsDir = dirname(fileURLToPath(import.meta.url))

// The only files allowed to reference the glass chrome literals: the shared
// modal primitive and the mobile bottom-sheet primitive (a distinct surface
// that intentionally reuses the same glass tokens). Both are centrally
// maintained — they are primitives, not per-call-site duplication.
const PRIMITIVES = new Set(['ModalOverlay.tsx', 'ui/BottomSheet.tsx'])

const GLASS_LITERALS = ['modal-scrim', 'fluux-glass']

// The hand-rolled flat panel that the migration eliminated. Banned everywhere:
// a modal panel must be the <ModalOverlay> glass surface, never this.
const FLAT_PANEL = 'relative z-10 bg-fluux-sidebar'

function walkComponents(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walkComponents(full))
    } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

const files = walkComponents(componentsDir)
const rel = (f: string) => relative(componentsDir, f).replace(/\\/g, '/')

describe('modal glass chrome is single-sourced', () => {
  for (const literal of GLASS_LITERALS) {
    it(`"${literal}" appears only in the shared modal primitives`, () => {
      const offenders = files
        .filter((f) => !PRIMITIVES.has(rel(f)) && readFileSync(f, 'utf8').includes(literal))
        .map(rel)
      expect(
        offenders,
        `"${literal}" must not be hand-rolled. Render through <ModalOverlay> instead. Offenders: ${offenders.join(', ')}`,
      ).toEqual([])
    })
  }

  it('no component hand-rolls the old flat bg-fluux-sidebar modal panel', () => {
    const offenders = files
      .filter((f) => readFileSync(f, 'utf8').includes(FLAT_PANEL))
      .map(rel)
    expect(
      offenders,
      `Flat modal panel found; route through <ModalOverlay> for the glass surface. Offenders: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('ModalOverlay actually owns the glass chrome (the guard is meaningful)', () => {
    const src = readFileSync(join(componentsDir, 'ModalOverlay.tsx'), 'utf8')
    for (const literal of GLASS_LITERALS) {
      expect(src, `ModalOverlay must define the "${literal}" chrome`).toContain(literal)
    }
  })
})
