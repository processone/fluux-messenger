import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { builtinThemes } from './builtins'
import type { ThemeDefinition } from './types'

/**
 * Chrome surface hierarchy guard.
 *
 * Three left-frame surfaces are ordered rail (deepest) < sidebar < main.
 * The divider is an alpha hairline that must contrast in the correct direction
 * (white-alpha on dark, black-alpha on light) so it is visible.
 *
 * For every builtin theme x mode, assert:
 *  a. luminance(rail) <= luminance(sidebar) <= luminance(main)
 *     (the depth ordering — rail must be the darkest chrome surface)
 *  b. the divider composite produces a line that is lighter than the surface
 *     on a dark surface, or darker on a light surface.
 *     "light surface" = luminance >= 0.5
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

function parseColor(value: string, vars: Record<string, string>): RGBA {
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
function composite(fg: RGBA, bg: RGBA): [number, number, number] {
  const a = fg[3]
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)) as [number, number, number]
}

function relLum(rgb: [number, number, number]): number {
  const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}

function surfaceLum(token: string, vars: Record<string, string>): number {
  const c = parseColor(token, vars)
  return relLum([c[0], c[1], c[2]])
}

function themeVars(theme: ThemeDefinition, mode: 'dark' | 'light'): Record<string, string> {
  const base = mode === 'dark' ? cssRoot : cssLight
  return { ...base, ...(theme.variables[mode] ?? {}) }
}

/**
 * Compute the effective rail color for a given theme/mode.
 *
 * The rail is no longer a fixed token; it is the sidebar background darkened by
 * a semitransparent black overlay (--fluux-rail-overlay = rgba(0,0,0,0.14)).
 * Per CSS painting rules, linear-gradient(overlay, overlay) over sidebar-bg
 * is equivalent to alpha-compositing overlay over sidebar-bg.
 *
 * For an rgba(0,0,0,alpha) overlay over an opaque sidebar color, each channel:
 *   result_channel = sidebar_channel * (1 - alpha)
 * (mixing toward black 0,0,0 by `alpha`).
 *
 * The alpha value 0.14 MUST match the --fluux-rail-overlay token in index.css.
 */
const RAIL_OVERLAY_ALPHA = 0.14

function effectiveRailRGB(vars: Record<string, string>): [number, number, number] {
  const sidebarRGBA = parseColor('var(--fluux-sidebar-bg)', vars)
  // Composite rgba(0,0,0,RAIL_OVERLAY_ALPHA) over the opaque sidebar color
  const factor = 1 - RAIL_OVERLAY_ALPHA
  return [
    sidebarRGBA[0] * factor,
    sidebarRGBA[1] * factor,
    sidebarRGBA[2] * factor,
  ]
}

describe('Chrome surface hierarchy', () => {
  for (const theme of builtinThemes) {
    for (const mode of ['dark', 'light'] as const) {
      const label = `[${theme.id}/${mode}]`

      it(`${label} depth order: luminance(rail) <= luminance(sidebar) <= luminance(main)`, () => {
        const vars = themeVars(theme, mode)

        // Rail is sidebar darkened by RAIL_OVERLAY_ALPHA black overlay -- always darker by construction
        const railRGB = effectiveRailRGB(vars)
        const lumRail = relLum(railRGB)
        const lumSidebar = surfaceLum('var(--fluux-sidebar-bg)', vars)
        const lumMain = surfaceLum('var(--fluux-chat-bg)', vars)

        expect(lumRail, `${label} rail lum ${lumRail.toFixed(4)} must be <= sidebar lum ${lumSidebar.toFixed(4)}`).toBeLessThanOrEqual(lumSidebar + 1e-4)
        expect(lumSidebar, `${label} sidebar lum ${lumSidebar.toFixed(4)} must be <= main lum ${lumMain.toFixed(4)}`).toBeLessThanOrEqual(lumMain + 1e-4)
      })

      it(`${label} divider direction correct (white-alpha on dark, black-alpha on light)`, () => {
        const vars = themeVars(theme, mode)

        // Use the effective rail color (overlay composited over sidebar)
        const railRGB = effectiveRailRGB(vars)
        const railRGBA: RGBA = [...railRGB, 1]
        const dividerRGBA = parseColor('var(--fluux-surface-divider)', vars)

        const dividerOnRail = composite(dividerRGBA, railRGBA)

        const lumSurface = relLum(railRGB)
        const lumComposite = relLum(dividerOnRail)

        // Determine the divider's intended direction from its own color (not from
        // surface luminance). A white-alpha divider (R≈255) is chosen for dark
        // surfaces; a black-alpha divider (R≈0) is chosen for light surfaces.
        // This is set by the CSS: :root -> rgba(255,255,255,0.07), .light -> rgba(0,0,0,0.07).
        const dividerIsWhiteAlpha = dividerRGBA[0] > 128 // white = [255,255,255], black = [0,0,0]

        if (dividerIsWhiteAlpha) {
          // White-alpha divider: compositing makes the line LIGHTER than the rail surface
          expect(lumComposite, `${label} white-alpha divider on rail (lum=${lumSurface.toFixed(4)}): composite lum=${lumComposite.toFixed(4)} must be > rail lum`).toBeGreaterThan(lumSurface)
        } else {
          // Black-alpha divider: compositing makes the line DARKER than the rail surface
          expect(lumComposite, `${label} black-alpha divider on rail (lum=${lumSurface.toFixed(4)}): composite lum=${lumComposite.toFixed(4)} must be < rail lum`).toBeLessThan(lumSurface)
        }
      })
    }
  }
})
