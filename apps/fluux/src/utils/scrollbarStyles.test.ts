import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

/**
 * Scrollbar styling guard (index.css), FLM-318.
 *
 * The 6px strip is always reserved so the layout never changes width as scrolling
 * starts and stops; only the thumb is hidden at rest and revealed while the user
 * scrolls. WebKit does not repaint the bar when only a pseudo-element rule starts
 * to match, so every reveal rule must also change the box's own style, and none
 * may be grouped. This replaces the earlier "thumb visible at rest" contract.
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

  it('hides the thumb at rest', () => {
    expect(ruleFor('::-webkit-scrollbar-thumb').decls.background).toBe('transparent')
  })

  it('reveals the thumb with its theme token, and also changes the box style', () => {
    expect(ruleFor('[data-scrolling]::-webkit-scrollbar-thumb').decls.background).toBe(
      'var(--scrollbar-thumb)',
    )
    expect(ruleFor('[data-scrolling]').decls['--fluux-scroll-reveal']).toBe('1')
    expect(ruleFor(':root[data-scrollbars="always"] ::-webkit-scrollbar-thumb').decls.background).toBe(
      'var(--scrollbar-thumb)',
    )
    expect(ruleFor(':root[data-scrollbars="always"]').decls['--fluux-scroll-reveal']).toBe('1')
  })

  it('registers the reveal property as non-inherited', () => {
    expect(css).toMatch(/@property --fluux-scroll-reveal\s*\{[^}]*inherits:\s*false/)
  })

  it('brightens the thumb on hover', () => {
    expect(ruleFor('::-webkit-scrollbar-thumb:hover').decls.background).toBe(
      'var(--scrollbar-thumb-hover)',
    )
  })

  it('gives the sidebar its own thumb token when revealed', () => {
    expect(ruleFor('.sidebar-scroll[data-scrolling]::-webkit-scrollbar-thumb').decls.background).toBe(
      'var(--fluux-scrollbar-thumb-sidebar)',
    )
    expect(
      ruleFor(':root[data-scrollbars="always"] .sidebar-scroll::-webkit-scrollbar-thumb').decls.background,
    ).toBe('var(--fluux-scrollbar-thumb-sidebar)')
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
