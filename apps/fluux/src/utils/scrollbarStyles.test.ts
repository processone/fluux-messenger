import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { SCROLLING_ATTR } from './scrollbarAutohide'

/**
 * Scrollbar styling guard (index.css).
 *
 * The auto-hide behaviour is a CSS contract that no visual diff in review would
 * catch if it regressed: making the resting thumb opaque turns the scrollbar
 * always-on again, fattening the gutter undoes the "subtle" intent, and the
 * reveal rules are coupled to the `data-scrolling` attribute written by
 * scrollbarAutohide.ts — rename one side and the thumb silently never appears.
 * These assertions lock the contract:
 *
 *  - thin gutter (<= 6px)
 *  - thumb transparent at rest (hidden)
 *  - revealed on hover AND on [data-scrolling]
 *  - the CSS selector matches the JS attribute constant
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

  it('hides the thumb at rest (transparent background)', () => {
    expect(ruleFor('::-webkit-scrollbar-thumb').decls.background).toBe('transparent')
  })

  it('reveals the thumb while actively scrolling', () => {
    const rule = ruleFor(`[${SCROLLING_ATTR}]::-webkit-scrollbar-thumb`)
    expect(rule.decls.background).toBe('var(--scrollbar-thumb)')
    expect(rule.decls.background).not.toBe('transparent')
  })

  it('reveals the thumb on hover', () => {
    const rule = ruleFor(':hover::-webkit-scrollbar-thumb')
    expect(rule.decls.background).toBe('var(--scrollbar-thumb)')
  })

  it('couples the reveal selector to the JS data-scrolling attribute', () => {
    // If scrollbarAutohide.ts renames the attribute, the CSS selector keyed on
    // the old name would no longer match and the thumb would never reveal.
    expect(css).toContain(`[${SCROLLING_ATTR}]::-webkit-scrollbar-thumb`)
  })

  it('reveals the sidebar thumb with its own theme color', () => {
    const rule = ruleFor(`.sidebar-scroll[${SCROLLING_ATTR}]::-webkit-scrollbar-thumb`)
    expect(rule.decls.background).toBe('var(--fluux-scrollbar-thumb-sidebar)')
  })
})
