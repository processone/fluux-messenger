import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { builtinThemes, fluuxTheme } from './builtins'
import { DEFAULT_ACCENT_PRESETS } from './defaultAccents'

/**
 * Aurora accent presets must each look right on their own and as a family.
 *
 * - Every fill carries readable text: the app picks black or white by contrast
 *   (useTheme's contrastColorForHsl), so the better of the two must clear AA.
 * - Accent doubles as text and icon color, so it must clear AA on the chat
 *   canvas and on the hovered message row.
 * - Presets sit side by side in the picker: within a mode they share one
 *   lightness band, so none glows or sinks next to the others.
 *
 * Surfaces are read from index.css so a ramp change re-runs these checks.
 */

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.css'), 'utf8')
function token(selector: string, name: string): string {
  const body = css.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
  const value = body.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6});`))?.[1]
  if (!value) throw new Error(`${name} not found in ${selector}`)
  return value
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))]
}
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
function ratio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const presets = fluuxTheme.accentPresets ?? []

// Aurora dark lifts accent TEXT above a deep, white-text fill (index.css), and
// useTheme keeps that lift for such presets. Luminous fills are their own text.
const auroraDarkTextLift = Number(
  css.match(/:root\[data-theme='fluux'\]:not\(\.light\)\s*\{[^}]*calc\(var\(--fluux-accent-l\) \+ (\d+)%\)/)?.[1] ?? 0,
)
function textLuminance(h: number, s: number, l: number, liftsDeepFills: boolean): number {
  const fill = luminance(hslToRgb(h, s, l))
  const deep = ratio(fill, 1) > ratio(fill, 0)
  return liftsDeepFills && deep ? luminance(hslToRgb(h, s, l + auroraDarkTextLift)) : fill
}
const surfaces = {
  dark: { chat: token(':root', '--fluux-base-30'), hover: token(':root', '--fluux-base-50') },
  light: { chat: token('.light', '--fluux-base-30'), hover: token('.light', '--fluux-base-50') },
}

describe('Aurora accent presets', () => {
  it('ships Periwinkle first, matching the CSS default accent', () => {
    expect(presets[0]?.name).toBe('Periwinkle')
    expect(presets[0]?.dark).toEqual({ h: 231, s: 100, l: 64 })
    expect(presets[0]?.light).toEqual({ h: 231, s: 85, l: 58 })
  })

  for (const mode of ['dark', 'light'] as const) {
    const chat = luminance(hexToRgb(surfaces[mode].chat))
    const hover = luminance(hexToRgb(surfaces[mode].hover))

    for (const preset of presets) {
      const { h, s, l } = preset[mode]
      const fill = luminance(hslToRgb(h, s, l))

      it(`[${mode}] ${preset.name}: text on the fill clears AA`, () => {
        expect(Math.max(ratio(fill, 0), ratio(fill, 1))).toBeGreaterThanOrEqual(4.5)
      })

      if (mode === 'light') {
        it(`[light] ${preset.name}: takes white text, like every light preset`, () => {
          expect(ratio(fill, 1)).toBeGreaterThan(ratio(fill, 0))
        })
      }

      // The dark default keeps its deep white-text fill; its text is lifted.
      const text = textLuminance(h, s, l, mode === 'dark')
      it(`[${mode}] ${preset.name}: reads as accent text on the chat canvas`, () => {
        expect(ratio(text, chat)).toBeGreaterThanOrEqual(4.5)
      })
      it(`[${mode}] ${preset.name}: reads as accent text on the hovered row`, () => {
        expect(ratio(text, hover)).toBeGreaterThanOrEqual(4.5)
      })
    }

    it(`[${mode}] presets share one lightness band`, () => {
      const family = presets.filter((p) => mode === 'light' || p.name !== 'Periwinkle')
      const values = family.map((p) => luminance(hslToRgb(p[mode].h, p[mode].s, p[mode].l)))
      // Light: white text sits between 5.5:1 and 6.5:1 on every fill.
      // Dark: luminous fills within a narrow luminance range.
      const [lo, hi] = mode === 'light' ? [1.05 / 6.5 - 0.05, 1.05 / 5.5 - 0.05] : [0.33, 0.48]
      for (const v of values) {
        expect(v).toBeGreaterThanOrEqual(lo)
        expect(v).toBeLessThanOrEqual(hi)
      }
    })
  }
})

/**
 * The shared default list serves every built-in theme without its own presets,
 * so it is checked on each of their chat canvases, not on one palette.
 */
describe('Default accent presets, on every theme that uses them', () => {
  const users = builtinThemes.filter((t) => !t.accentPresets)

  it('serves the built-in themes without a curated list', () => {
    expect(users.length).toBeGreaterThan(10)
  })

  for (const mode of ['dark', 'light'] as const) {
    const sel = mode === 'dark' ? ':root' : '.light'
    const values = DEFAULT_ACCENT_PRESETS.map((p) => ({ name: p.name, y: luminance(hslToRgb(p[mode].h, p[mode].s, p[mode].l)) }))

    for (const { name, y } of values) {
      it(`[${mode}] ${name}: takes ${mode === 'dark' ? 'black' : 'white'} text at AA`, () => {
        const onFill = mode === 'dark' ? ratio(y, 0) : ratio(y, 1)
        expect(onFill).toBeGreaterThan(mode === 'dark' ? ratio(y, 1) : ratio(y, 0))
        expect(onFill).toBeGreaterThanOrEqual(4.5)
      })
    }

    it(`[${mode}] presets share one lightness band`, () => {
      // Dark: luminous fills within 0.50 to 0.60. Light: white text at 6.0 to 6.8:1.
      const [lo, hi] = mode === 'dark' ? [0.5, 0.6] : [1.05 / 6.8 - 0.05, 1.05 / 6.0 - 0.05]
      for (const { y } of values) {
        expect(y).toBeGreaterThanOrEqual(lo)
        expect(y).toBeLessThanOrEqual(hi)
      }
    })

    for (const theme of users) {
      const vars = theme.variables[mode] ?? {}
      const read = (name: string): string => {
        const v = vars[name]
        if (v?.startsWith('var(')) return read(v.slice(4, -1))
        return v ?? token(sel, name)
      }
      const chatToken = vars['--fluux-chat-bg']
      const chat = luminance(hexToRgb(chatToken?.startsWith('#') ? chatToken : read('--fluux-base-30')))

      it(`[${mode}] ${theme.name}: every preset reads as accent text on the chat canvas`, () => {
        for (const { name, y } of values) {
          expect(ratio(y, chat), name).toBeGreaterThanOrEqual(4.5)
        }
      })
    }
  }
})

/**
 * Each theme's own default accent is also its text and icon color
 * (text-fluux-brand), so it must read on the theme's chat canvas and carry
 * readable text on fills.
 */
describe('Theme default accents', () => {
  it('Aurora dark lifts the text of its deep default fill', () => {
    expect(auroraDarkTextLift).toBeGreaterThan(0)
  })

  for (const theme of builtinThemes) {
    for (const mode of ['dark', 'light'] as const) {
      const sel = mode === 'dark' ? ':root' : '.light'
      const vars = theme.variables[mode] ?? {}
      const read = (name: string): string => {
        const v = vars[name]
        if (v?.startsWith('var(')) return read(v.slice(4, -1))
        return v ?? token(sel, name)
      }
      const num = (name: string): number => {
        const own = vars[name]
        if (own) return parseFloat(own)
        const pick = (s: string) => parseFloat(css.match(new RegExp(`${s.replace('.', '\\.')}\\s*\\{[\\s\\S]*?${name}:\\s*([\\d.]+)`))?.[1] ?? 'NaN')
        const v = mode === 'light' ? pick('.light') : NaN
        return Number.isNaN(v) ? pick(':root') : v
      }
      const [h, s, l] = [num('--fluux-accent-h'), num('--fluux-accent-s'), num('--fluux-accent-l')]
      const fill = luminance(hslToRgb(h, s, l))
      const text = textLuminance(h, s, l, theme.id === 'fluux' && mode === 'dark')
      const chatToken = vars['--fluux-chat-bg']
      const chat = luminance(hexToRgb(chatToken?.startsWith('#') ? chatToken : read('--fluux-base-30')))

      it(`[${mode}] ${theme.name}: text on the accent fill clears AA`, () => {
        expect(Math.max(ratio(fill, 0), ratio(fill, 1))).toBeGreaterThanOrEqual(4.5)
      })
      it(`[${mode}] ${theme.name}: accent reads as text on the chat canvas`, () => {
        expect(ratio(text, chat)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})
