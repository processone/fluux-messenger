import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { builtinThemes } from './builtins'
import type { ThemeDefinition } from './types'

/**
 * Aurora theme contrast guard.
 *
 * The theme is token-driven, so contrast regressions are silent — a single edit
 * to index.css can make a control's border invisible or push body text below
 * WCAG AA without any visual diff in code review. This test resolves the CSS
 * custom properties for both modes and asserts the structural invariants the
 * 2026-06-26 Aurora audit established (docs/2026-06-26-aurora-theme-audit.md):
 *
 *  - a border drawn on a surface must read as a hairline (Pattern A)
 *  - body/muted informational text must clear WCAG AA (Pattern B)
 *
 * Numbers are exact WCAG 2.1, alpha composited over the real backdrop.
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

describe('Aurora theme contrast invariants', () => {
  // Pattern A — a border must define an edge against its surface in both modes.
  // 1.5:1 is a deliberately low bar (a hairline, not AA text); the regression we
  // guard against is the old black-on-dark border at ~1.0:1 (invisible).
  for (const [mode, vars] of [['dark', dark], ['light', light]] as const) {
    it(`[${mode}] border-color reads as a hairline on the chat surface`, () => {
      const r = contrast('var(--fluux-border-color)', 'var(--fluux-chat-bg)', vars)
      expect(r).toBeGreaterThanOrEqual(1.5)
    })

    it(`[${mode}] muted text clears WCAG AA on the chat surface`, () => {
      const r = contrast('var(--fluux-text-muted)', 'var(--fluux-chat-bg)', vars)
      expect(r).toBeGreaterThanOrEqual(4.5)
    })

    it(`[${mode}] normal text clears WCAG AAA on the chat surface`, () => {
      const r = contrast('var(--fluux-text-normal)', 'var(--fluux-chat-bg)', vars)
      expect(r).toBeGreaterThanOrEqual(7)
    })

    it(`[${mode}] white text clears WCAG AA on the accent fill`, () => {
      const r = contrast('var(--fluux-text-on-accent)', 'var(--fluux-bg-accent)', vars)
      expect(r).toBeGreaterThanOrEqual(4.5)
    })

    // --fluux-status-error doubles as a fill (danger button, toast border,
    // presence dnd dot) with white text on it. It must stay dark enough that
    // white clears AA — the constraint that pulls against error-as-text wanting
    // to be lighter, which is why the two are split (status-error fill vs
    // text-error text). See the dark text-error assertion in the Pattern B loop.
    it(`[${mode}] white text clears WCAG AA on the error fill`, () => {
      const r = contrast('#ffffff', 'var(--fluux-status-error)', vars)
      expect(r).toBeGreaterThanOrEqual(4.5)
    })

    // Pattern E — the focus ring is a non-text UI indicator and must clear the
    // WCAG 1.4.11 non-text contrast minimum (3:1) against the surfaces it rings.
    // It drives the universal `.user-interacted *:focus` outline, so this one
    // token governs focus visibility app-wide. (Was accent @ 0.5 alpha, ~1.9:1.)
    it(`[${mode}] focus ring clears 3:1 non-text contrast on the hover surface`, () => {
      const r = contrast('var(--fluux-focus-ring)', 'var(--fluux-bg-hover)', vars)
      expect(r).toBeGreaterThanOrEqual(3)
    })

    // Pattern B — informational text that renders on message rows must clear AA
    // against the darkest of those (the hover row), not just the resting surface.
    // Links and the own-name dipped below AA on the light-mode hover/active rows;
    // text-faint (the timestamp tier) failed in both modes at its old value.
    // text-error (delivery-failure text/icons) is its own token, split from the
    // status-error fill: as text it must be light enough to clear AA on the dark
    // rows, where the fill-tuned status-error reached only ~3.74:1 (the audit's
    // deferred dark-mode error-as-text item).
    for (const token of ['text-link', 'text-self', 'text-faint', 'text-error'] as const) {
      it(`[${mode}] ${token} clears WCAG AA on the hover row`, () => {
        const r = contrast(`var(--fluux-${token})`, 'var(--fluux-bg-hover)', vars)
        expect(r).toBeGreaterThanOrEqual(4.5)
      })
    }

    // Pattern C — MUC sender names are informational text. They render in the
    // message list on the chat surface AND on the hover/active row, so they must
    // clear AA against the darkest of those (bg-hover) in both modes.
    for (let i = 1; i <= 6; i++) {
      it(`[${mode}] sender-${i} clears WCAG AA on the hover row`, () => {
        const r = contrast(`var(--fluux-sender-${i})`, 'var(--fluux-bg-hover)', vars)
        expect(r).toBeGreaterThanOrEqual(4.5)
      })
    }
  }

  // Pattern C — status colors are used as text/icon labels on light surfaces
  // (settings cards, toasts, edit/encryption labels). The light theme's bright
  // green/yellow/red fail AA as text; assert the (darkened) light overrides.
  // (Error-as-text on the dark chat surface is handled by the dedicated
  // --fluux-text-error token, asserted in the Pattern B loop above.)
  for (const key of ['success', 'warning', 'error'] as const) {
    it(`[light] status-${key} clears WCAG AA as text on a card surface`, () => {
      const r = contrast(`var(--fluux-status-${key})`, 'var(--fluux-bg-primary)', light)
      expect(r).toBeGreaterThanOrEqual(4.5)
    })
  }
})

// Per-theme error-text guard. Every builtin theme overrides --fluux-color-red
// (so the bg-fluux-red fills follow its palette); the split means it must also
// tune --fluux-text-error so error TEXT stays legible. Themes that inherit the
// Aurora red (fluux, indigo) inherit its text-error too. Each theme's effective
// tokens = the index.css defaults overlaid with the theme's overrides.
//
// Surface = the resting chat surface (--fluux-chat-bg / base-30), where error
// text is read. The hover row (base-40) is an unusually light mid-tone on a few
// themes (e.g. Solarized), where no vivid red can also clear AA; rather than
// force a near-white error color, the hover state is left ungated and the
// resting surface is the contract. (Light mode clears AA on both anyway.)
function themeTokens(theme: ThemeDefinition, mode: 'dark' | 'light'): Record<string, string> {
  const base = mode === 'dark' ? dark : light
  return { ...base, ...(theme.variables[mode] ?? {}) }
}

describe('Builtin theme error-text contrast', () => {
  for (const theme of builtinThemes) {
    for (const mode of ['dark', 'light'] as const) {
      it(`[${theme.id}/${mode}] text-error clears WCAG AA on the chat surface`, () => {
        const r = contrast('var(--fluux-text-error)', 'var(--fluux-chat-bg)', themeTokens(theme, mode))
        expect(r).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})
