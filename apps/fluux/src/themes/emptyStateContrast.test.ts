import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { builtinThemes } from './builtins'
import type { ThemeDefinition } from './types'

/**
 * Empty-state text contrast guard.
 *
 * The hero EmptyState component renders on the main conversation surface
 * (bg-fluux-chat -> --fluux-chat-bg). Two text tiers are used:
 *
 *  - --fluux-text-normal  : the display title (large, bold)
 *  - --fluux-text-muted   : the prompt/sub-title — the load-bearing check,
 *                           since the muted tier is dimmer and may not be
 *                           guarded on chat-bg elsewhere.
 *
 * For every builtin theme x both modes, both tokens must clear WCAG AA
 * (>= 4.5:1) on BOTH --fluux-chat-bg AND --fluux-sidebar-bg.
 *
 * --fluux-text-muted is used app-wide (timestamps, labels, placeholders,
 * rail icons). The sidebar surface is the harder constraint in light mode
 * since it sits between two lighter steps on the ramp. Testing both surfaces
 * here ensures a theme fix does not leave the sidebar sub-AA.
 *
 * Helpers are copied verbatim from themeContrast.test.ts; that is the
 * established pattern in sibling guards (occupantAvatarContrast.test.ts,
 * surfaceHierarchy.test.ts, glass.test.ts).
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
const dark = block(':root')
const light = { ...dark, ...block('.light') } // light inherits :root where not overridden

// --- color resolution: hex / rgba / hsl, with var() expanded anywhere ---
type RGBA = [number, number, number, number]

// Textually expand every var(--x) in a value (including inside hsl()/rgba() args).
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

// Each theme's effective tokens = the index.css defaults overlaid with the
// theme's overrides (mirrors themeContrast.test.ts / occupantAvatarContrast.test.ts).
function themeTokens(theme: ThemeDefinition, mode: 'dark' | 'light'): Record<string, string> {
  const base = mode === 'dark' ? dark : light
  return { ...base, ...(theme.variables[mode] ?? {}) }
}

describe('empty-state text contrast on the main surface', () => {
  for (const theme of builtinThemes) {
    for (const mode of ['dark', 'light'] as const) {
      it(`${theme.id}/${mode}: title + prompt clear AA on chat-bg`, () => {
        const vars = themeTokens(theme, mode)
        const chatBg = 'var(--fluux-chat-bg)'

        const titleRatio = contrast('var(--fluux-text-normal)', chatBg, vars)
        expect(
          titleRatio,
          `${theme.id}/${mode}: text-normal (title) on chat-bg = ${titleRatio.toFixed(2)} (need >= 4.5)`
        ).toBeGreaterThanOrEqual(4.5)

        const promptRatio = contrast('var(--fluux-text-muted)', chatBg, vars)
        expect(
          promptRatio,
          `${theme.id}/${mode}: text-muted (prompt) on chat-bg = ${promptRatio.toFixed(2)} (need >= 4.5)`
        ).toBeGreaterThanOrEqual(4.5)
      })

      it(`${theme.id}/${mode}: title + prompt clear AA on sidebar-bg`, () => {
        const vars = themeTokens(theme, mode)
        const sidebarBg = 'var(--fluux-sidebar-bg)'

        const titleRatio = contrast('var(--fluux-text-normal)', sidebarBg, vars)
        expect(
          titleRatio,
          `${theme.id}/${mode}: text-normal (title) on sidebar-bg = ${titleRatio.toFixed(2)} (need >= 4.5)`
        ).toBeGreaterThanOrEqual(4.5)

        const promptRatio = contrast('var(--fluux-text-muted)', sidebarBg, vars)
        expect(
          promptRatio,
          `${theme.id}/${mode}: text-muted (prompt) on sidebar-bg = ${promptRatio.toFixed(2)} (need >= 4.5)`
        ).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})
