/**
 * Occupant panel contrast guards (Aurora Occupant Panel slice).
 *
 * OccupantRow colours its fallback avatar with auroraSenderColor(nick, isDark),
 * picks a letter colour via bestTextColor(fill), and renders the occupant NAME in
 * that same auroraSenderColor on the panel surface. Two distinct contrast pairs
 * need guarding:
 *
 *  1. LETTER on the avatar FILL — theme-INDEPENDENT. auroraSenderColor targets
 *     fixed luminances (DARK_ROW_LUMINANCE / LIGHT_ROW_LUMINANCE) and bestTextColor
 *     picks #000/#fff; neither reads CSS custom properties, so one dark/light sweep
 *     covers every theme without iterating builtinThemes.
 *
 *  2. NAME on the panel SURFACE — theme-DEPENDENT. The OccupantPanel container
 *     renders on the conversation/chat surface (bg-fluux-chat → --fluux-chat-bg),
 *     the same AA-guaranteed text surface the message area uses. This was a
 *     deliberate fix: the panel previously sat on bg-fluux-sidebar
 *     (--fluux-sidebar-bg → --fluux-base-20), but 12 of 13 builtin themes override
 *     base-20 with their own light values (gruvbox #d5c4a1, tokyo-night #c4c8da,
 *     etc. — materially darker than Aurora's #EEF0F8), and base-20 is darker than
 *     base-30 in light mode, so the worst-case auroraSenderColor dropped below AA
 *     on five themes' light panel. Anchoring the panel to --fluux-chat-bg makes
 *     the name sit on the surface themeContrast.test.ts already guarantees is AA
 *     for sender colours. This guard asserts that contract directly for the panel:
 *     for every builtin theme x both modes, the worst-case auroraSenderColor must
 *     clear AA on --fluux-chat-bg. (Mirrors the per-theme CSS resolution in
 *     themeContrast.test.ts: themeTokens() overlays the theme overrides on the
 *     index.css defaults, then var()s are textually expanded and composited.)
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { builtinThemes } from './builtins'
import { auroraSenderColor } from '../utils/senderColor'
import { bestTextColor, hexToRgb, getLuminance, contrastRatio } from '../utils/contrastColor'
import type { ThemeDefinition } from './types'

// Mirror the sample-id approach from themeContrast.test.ts: 2000 identifiers
// distributes djb2 evenly across the hue wheel, hitting every bucket.
const SAMPLE_IDS = Array.from({ length: 2000 }, (_, i) => `user${i}@example.com`)

// ── Guard 1: letter on the avatar fill (theme-independent) ────────────────────

/** WCAG contrast between two opaque hex colours. */
function hexContrast(hexA: string, hexB: string): number {
  const a = hexToRgb(hexA)
  const b = hexToRgb(hexB)
  if (!a || !b) throw new Error(`unparseable hex: ${hexA} / ${hexB}`)
  return contrastRatio(getLuminance(a.r, a.g, a.b), getLuminance(b.r, b.g, b.b))
}

describe('Occupant fallback-avatar letter contrast', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`letter clears WCAG AA (4.5:1) on the avatar fill (${mode})`, () => {
      let worst = Infinity
      let worstId = ''
      let worstFill = ''
      let worstLetter = ''

      for (const id of SAMPLE_IDS) {
        const fill = auroraSenderColor(id, mode === 'dark')
        const letter = bestTextColor(fill)
        const ratio = hexContrast(letter, fill)
        if (ratio < worst) {
          worst = ratio
          worstId = id
          worstFill = fill
          worstLetter = letter
        }
      }

      expect(
        worst,
        `worst case: ${worstId} fill=${worstFill} letter=${worstLetter} ratio=${worst.toFixed(2)}`
      ).toBeGreaterThanOrEqual(4.5)
    })
  }
})

// ── Guard 2: occupant name on the panel surface (per theme) ───────────────────
// CSS resolution mirrored from themeContrast.test.ts: resolve the :root (dark) and
// .light token blocks from index.css, overlay each theme's overrides, textually
// expand var() (including inside hsl()/rgba()), composite alpha, then WCAG-contrast.

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../index.css')
const css = readFileSync(cssPath, 'utf8')

function block(selector: string): Record<string, string> {
  const re = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([\\s\\S]*?)\\n\\}`)
  const body = css.match(re)?.[1] ?? ''
  const map: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) map[m[1]] = m[2].trim()
  return map
}
const dark = block(':root')
const light = { ...dark, ...block('.light') } // light inherits :root where not overridden

type RGBA = [number, number, number, number]
function expand(value: string, vars: Record<string, string>, depth = 0): string {
  if (depth > 16) throw new Error('var() cycle: ' + value)
  return value.replace(/var\((--[\w-]+)\)/g, (_, k: string) => {
    if (!(k in vars)) throw new Error('undefined token: ' + k)
    return expand(vars[k], vars, depth + 1)
  })
}
function resolve_(value: string, vars: Record<string, string>): RGBA {
  const v = expand(value, vars).trim()
  if (v.startsWith('#')) {
    const h = v.slice(1)
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]
  }
  const rgba = v.match(/^rgba?\(([^)]+)\)$/)
  if (rgba) {
    const p = rgba[1].split(',').map((x) => parseFloat(x))
    return [p[0], p[1], p[2], p[3] ?? 1]
  }
  const hsl = v.match(/^hsla?\(([^)]+)\)$/)
  if (hsl) {
    const p = hsl[1].split(',').map((x) => parseFloat(x))
    return [...hslToRgb(p[0], p[1], p[2]), p[3] ?? 1] as RGBA
  }
  throw new Error('unhandled color: ' + value)
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))]
}
function over(fg: RGBA, bg: RGBA): [number, number, number] {
  const a = fg[3]
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)) as [number, number, number]
}
function relLum([r, g, b]: number[]): number {
  const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
function contrast(fg: string, bg: string, vars: Record<string, string>): number {
  const bgc = resolve_(bg, vars)
  const fgc = resolve_(fg, vars)
  const top = fgc[3] < 1 ? over(fgc, bgc) : [fgc[0], fgc[1], fgc[2]]
  const l1 = relLum(top), l2 = relLum([bgc[0], bgc[1], bgc[2]])
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}
function themeTokens(theme: ThemeDefinition, mode: 'dark' | 'light'): Record<string, string> {
  const base = mode === 'dark' ? dark : light
  return { ...base, ...(theme.variables[mode] ?? {}) }
}

describe('Builtin theme occupant-name contrast on the panel surface', () => {
  for (const theme of builtinThemes) {
    for (const mode of ['dark', 'light'] as const) {
      it(`[${theme.id}/${mode}] worst-case occupant name clears WCAG AA on --fluux-chat-bg`, () => {
        const vars = themeTokens(theme, mode)
        let worst = Infinity
        let worstId = ''
        for (const id of SAMPLE_IDS) {
          const hex = auroraSenderColor(id, mode === 'dark')
          const r = contrast(hex, 'var(--fluux-chat-bg)', vars)
          if (r < worst) { worst = r; worstId = id }
        }
        expect(
          worst,
          `${theme.id}/${mode}: worst sender ${auroraSenderColor(worstId, mode === 'dark')} on chat-bg ${expand('var(--fluux-chat-bg)', vars)} = ${worst.toFixed(2)}`
        ).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})
