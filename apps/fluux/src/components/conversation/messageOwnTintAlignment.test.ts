// @vitest-environment node
// Pure file-parsing test — the app's default happy-dom env rewrites
// `import.meta.url` to a non-file URL, which breaks fileURLToPath; node env
// keeps it a real file:// URL.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The emphasis-bottom alignment fix is pure CSS (jsdom can't compute it), so we
// guard the invariant by parsing index.css directly. Comments are stripped so a
// prose mention of a property name can never be mistaken for a declaration.
const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** Read a single declaration value out of a named rule block. */
function decl(selector: string, prop: string): string | null {
  const sel = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${sel}\\s*\\{([^}]*)\\}`).exec(css)
  if (!block) return null
  const m = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`).exec(block[1])
  return m ? m[1].trim() : null
}

describe('Own-message emphasis bottom alignment', () => {
  // Regression: a group-end own message must extend its tint down through the
  // row's group-end padding so the emphasis bottom meets the hover-row highlight
  // instead of floating a few px above it. It's done with padding-bottom (paints
  // the wash lower) plus an EQUAL negative margin-bottom (so the row height — and
  // the virtualizer's measurements — stay unchanged). Those values must MIRROR
  // .message-group-end exactly; otherwise the emphasis over/under-shoots the
  // highlight, or the negative margin no longer cancels the padding and row
  // heights drift (breaking the scroll invariants).
  it('mirrors .message-group-end padding on .message-own-tint-end (comfortable)', () => {
    const gap = decl('.message-group-end', 'padding-bottom')
    expect(gap).not.toBeNull()
    expect(decl('.message-own-tint-end', 'padding-bottom')).toBe(gap)
    expect(decl('.message-own-tint-end', 'margin-bottom')).toBe(`-${gap}`)
  })

  it('mirrors the compact-density group-end padding on .message-own-tint-end', () => {
    const gap = decl('[data-density="compact"] .message-group-end', 'padding-bottom')
    expect(gap).not.toBeNull()
    expect(decl('[data-density="compact"] .message-own-tint-end', 'padding-bottom')).toBe(gap)
    expect(decl('[data-density="compact"] .message-own-tint-end', 'margin-bottom')).toBe(`-${gap}`)
  })
})
