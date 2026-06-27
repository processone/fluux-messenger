import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

/**
 * Scrollbar styling guard (index.css).
 *
 * The scrollbar is a thin, subtle, always-visible thumb. Auto-hide was tried
 * (transparent thumb revealed on :hover / [data-scrolling]) but did not work in
 * the desktop app's WebKit engine, so a regression toward it must be caught:
 * a transparent resting thumb makes the scrollbar disappear in WebKit, and a
 * fatter gutter undoes the "thin/subtle" intent. These assertions lock the
 * contract:
 *
 *  - thin gutter (<= 6px)
 *  - thumb visible at rest (resolves to the scrollbar-thumb token, not transparent)
 *  - brighter on hover
 *  - sidebar keeps its own theme token
 */

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../index.css')
const css = readFileSync(cssPath, 'utf8')

// --- minimal CSS rule parser (comments stripped, no nesting in this file) ---
type Rule = { selectors: string[]; decls: Record<string, string> }

const rules: Rule[] = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]+)\}/g)].map(
  m => {
    const decls: Record<string, string> = {}
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':')
      if (i === -1) continue
      decls[d.slice(0, i).trim()] = d.slice(i + 1).trim()
    }
    return { selectors: m[1].split(',').map(s => s.trim()).filter(Boolean), decls }
  },
)

/** The rule whose selector list contains exactly `selector`. */
function ruleFor(selector: string): Rule {
  const found = rules.find(r => r.selectors.includes(selector))
  if (!found) throw new Error(`no CSS rule for selector "${selector}"`)
  return found
}

describe('scrollbar styles (index.css)', () => {
  it('uses a thin gutter (<= 6px)', () => {
    const bar = ruleFor('::-webkit-scrollbar')
    expect(parseInt(bar.decls.width, 10)).toBeLessThanOrEqual(6)
    expect(parseInt(bar.decls.height, 10)).toBeLessThanOrEqual(6)
  })

  it('keeps the thumb visible at rest (not transparent)', () => {
    // A transparent resting thumb is the auto-hide regression that vanished the
    // scrollbar in WebKit. The thumb must paint the scrollbar-thumb token.
    const thumb = ruleFor('::-webkit-scrollbar-thumb')
    expect(thumb.decls.background).toBe('var(--scrollbar-thumb)')
    expect(thumb.decls.background).not.toBe('transparent')
  })

  it('brightens the thumb on hover', () => {
    expect(ruleFor('::-webkit-scrollbar-thumb:hover').decls.background).toBe(
      'var(--scrollbar-thumb-hover)',
    )
  })

  it('gives the sidebar its own visible thumb token', () => {
    expect(ruleFor('.sidebar-scroll::-webkit-scrollbar-thumb').decls.background).toBe(
      'var(--fluux-scrollbar-thumb-sidebar)',
    )
  })

  it('never groups ::-webkit-scrollbar selectors (WebKit drops grouped lists)', () => {
    // WebKit discards an entire comma list if it dislikes any ::-webkit-scrollbar
    // compound in it. Keep every scrollbar rule single-selector.
    const grouped = rules
      .filter(r => r.selectors.length > 1 && r.selectors.some(s => s.includes('::-webkit-scrollbar')))
      .map(r => r.selectors.join(', '))
    expect(grouped).toEqual([])
  })
})
