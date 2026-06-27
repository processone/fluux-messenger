import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { builtinThemes } from './builtins'
import type { ThemeDefinition } from './types'

/**
 * Glass surface cross-theme guard.
 *
 * .fluux-glass uses --fluux-chat-bg (the primary content surface) as its solid
 * fallback surface (and as the base for the frosted color-mix variant). That
 * surface is where --fluux-text-normal is contrast-guaranteed (themeContrast
 * asserts AAA) in every theme and BOTH modes. The lighter elevated surfaces
 * (bg-float base-50, bg-hover base-40) and the sidebar (bg-tertiary base-20) each
 * dip below AA for text in some theme/mode, so they are NOT used for the glass.
 * For every builtin theme x mode:
 *  a. normal text must clear WCAG AA on the solid fallback (--fluux-chat-bg)
 *  b. the glass border (--fluux-glass-border) composited over --fluux-chat-bg
 *     must be perceptible as a hairline (>= 1.25:1)
 */

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../index.css')
const css = readFileSync(cssPath, 'utf8')

// --- extract the :root (dark) and .light token blocks ---
function block(selector: string): Record<string, string> {
  const re = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([\\s\\S]*?)\\n\\}`)
  const body = css.match(re)?.[1] ?? ''
  const map: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) map[m[1]] = m[2].trim()
  return map
}
const cssRoot = block(':root')
const cssLight = { ...cssRoot, ...block('.light') }

// --- color resolution: hex / rgba / hsl, with var() expanded ---
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
    if (h.length === 3) {
      return [
        parseInt(h[0] + h[0], 16),
        parseInt(h[1] + h[1], 16),
        parseInt(h[2] + h[2], 16),
        1,
      ]
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]
  }
  const rgba = v.match(/^rgba?\(([^)]+)\)$/)
  if (rgba) {
    const p = rgba[1].split(',').map((x) => parseFloat(x.trim()))
    return [p[0], p[1], p[2], p[3] ?? 1]
  }
  const hsl = v.match(/^hsla?\(([^)]+)\)$/)
  if (hsl) {
    const p = hsl[1].split(',').map((x) => parseFloat(x.trim()))
    return [...hslToRgb(p[0], p[1], p[2]), p[3] ?? 1] as RGBA
  }
  throw new Error('unhandled color: ' + v + ' (from: ' + value + ')')
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))]
}

/** Alpha-composite fg (with alpha) over an opaque bg, return opaque RGB. */
function compositeAlphaOver(fg: RGBA, bg: RGBA): [number, number, number] {
  const a = fg[3]
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)) as [number, number, number]
}

function relLum(rgb: [number, number, number]): number {
  const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}

function contrast(fgRgba: RGBA, bgRgba: RGBA): number {
  // If fg is semi-transparent, composite it over bg first
  const fgOpaque = fgRgba[3] < 1
    ? compositeAlphaOver(fgRgba, bgRgba)
    : [fgRgba[0], fgRgba[1], fgRgba[2]] as [number, number, number]
  const l1 = relLum(fgOpaque)
  const l2 = relLum([bgRgba[0], bgRgba[1], bgRgba[2]])
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

function themeTokens(theme: ThemeDefinition, mode: 'dark' | 'light'): Record<string, string> {
  const base = mode === 'dark' ? cssRoot : cssLight
  return { ...base, ...(theme.variables[mode] ?? {}) }
}

describe('Glass surface cross-theme guard', () => {
  for (const theme of builtinThemes) {
    for (const mode of ['dark', 'light'] as const) {
      it(`${theme.id}/${mode}: text readable on glass fallback + border perceptible`, () => {
        const vars = themeTokens(theme, mode)
        // The glass surface is --fluux-chat-bg: the primary content surface where
        // --fluux-text-normal is contrast-guaranteed (AAA) in every theme + mode.
        // The elevated surfaces (base-40/50) and the sidebar (base-20) fall below
        // AA for text in some theme/mode, so they are not used for the glass panel.
        const glassBg = resolve_('var(--fluux-chat-bg)', vars)
        const text = resolve_('var(--fluux-text-normal)', vars)
        const textContrast = contrast(text, glassBg)
        expect(
          textContrast,
          `[${theme.id}/${mode}] --fluux-text-normal contrast on --fluux-chat-bg: ${textContrast.toFixed(2)}:1 (need >= 4.5)`
        ).toBeGreaterThanOrEqual(4.5)

        const glassBorder = resolve_('var(--fluux-glass-border)', vars)
        const borderComposited = compositeAlphaOver(glassBorder, glassBg)
        const borderContrast = contrast([...borderComposited, 1] as RGBA, glassBg)
        expect(
          borderContrast,
          `[${theme.id}/${mode}] --fluux-glass-border composited on --fluux-chat-bg: ${borderContrast.toFixed(2)}:1 (need >= 1.25)`
        ).toBeGreaterThanOrEqual(1.25)
      })
    }
  }
})
