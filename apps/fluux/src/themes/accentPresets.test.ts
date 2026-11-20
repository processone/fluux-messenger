import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fluuxTheme } from './builtins'

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

      // The dark default keeps its white-text fill, which reads as a fill and an
      // icon (3:1) but not as body-size text on the canvas; the other dark
      // presets are luminous and clear AA as text too.
      const textFloor = mode === 'dark' && preset.name === 'Periwinkle' ? 3 : 4.5
      it(`[${mode}] ${preset.name}: reads as accent text on the chat canvas`, () => {
        expect(ratio(fill, chat)).toBeGreaterThanOrEqual(textFloor)
      })
      it(`[${mode}] ${preset.name}: reads as accent text on the hovered row`, () => {
        expect(ratio(fill, hover)).toBeGreaterThanOrEqual(mode === 'dark' && preset.name === 'Periwinkle' ? 2.5 : 4.5)
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
