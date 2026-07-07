import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { builtinThemes } from './builtins'

/**
 * Cross-theme aurora derivation guard.
 *
 * Non-Aurora themes derive the aurora quartet (--fluux-aurora-1..4) from their
 * own accent hue via a pure-CSS rule in index.css
 * (`:root[data-theme]:not([data-theme='fluux'])`). The dark ink icon on the
 * send-button solid fill (reduced-transparency / Linux fallback) sits on those
 * derived colours, so every possible derived stop must clear the WCAG 3:1 floor
 * for graphical objects. The derivation floors lightness (66%), which is what
 * makes that hold for every hue — this test pins both the floor value the CSS
 * uses and the contrast invariant it guarantees.
 */

const INK = '#08111F' // --fluux-aurora-ink
const AA_GRAPHIC = 3 // WCAG 2.1 non-text contrast

// Derivation constants — MUST match the index.css rule.
const HUE_OFFSETS = [-50, -18, 16, 50]
const L_FLOOR = 66
const L_ADD = 14
const L_CEIL = 80

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.css'), 'utf8')

type RGB = [number, number, number]
function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r: number, g: number, b: number
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}
function hexToRgb(hex: string): RGB {
  const h = hex.slice(1)
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function relLum([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
function clamp(min: number, v: number, max: number): number {
  return Math.max(min, Math.min(v, max))
}
function derivedStops(h: number, s: number, l: number): RGB[] {
  const L = clamp(L_FLOOR, l + L_ADD, L_CEIL)
  return HUE_OFFSETS.map((o) => hslToRgb(h + o, s / 100, L / 100))
}

const ink = hexToRgb(INK)

describe('cross-theme aurora derivation', () => {
  it('index.css uses the derivation this guard mirrors', () => {
    expect(css).toMatch(/:root\[data-theme\]:not\(\[data-theme='fluux'\]\)/)
    expect(css).toContain('clamp(66%, calc(var(--fluux-accent-l) + 14%), 80%)')
    // the four hue offsets
    for (const o of HUE_OFFSETS) {
      const sign = o < 0 ? `- ${Math.abs(o)}` : `+ ${o}`
      expect(css).toContain(`calc(var(--fluux-accent-h) ${sign})`)
    }
  })

  it('ink clears the 3:1 graphic floor on any derived stop (floor lightness, every hue/saturation)', () => {
    for (let h = 0; h < 360; h += 5) {
      for (let s = 0; s <= 100; s += 10) {
        const ratio = contrast(ink, hslToRgb(h, s / 100, L_FLOOR / 100))
        expect(ratio, `ink on hsl(${h} ${s}% ${L_FLOOR}%) = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA_GRAPHIC)
      }
    }
  })

  it("ink clears 3:1 on every builtin theme's derived stops (dark + light)", () => {
    for (const theme of builtinThemes) {
      if (theme.id === 'fluux') continue // Aurora keeps its explicit signature
      for (const mode of ['dark', 'light'] as const) {
        const v = theme.variables?.[mode]
        const h = parseFloat(v?.['--fluux-accent-h'] ?? '')
        const s = parseFloat(v?.['--fluux-accent-s'] ?? '')
        const l = parseFloat(v?.['--fluux-accent-l'] ?? '')
        if (Number.isNaN(h) || Number.isNaN(s) || Number.isNaN(l)) continue // inherits Aurora's accent
        for (const rgb of derivedStops(h, s, l)) {
          const ratio = contrast(ink, rgb)
          expect(ratio, `${theme.id}/${mode} ink on derived stop = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA_GRAPHIC)
        }
      }
    }
  })
})
