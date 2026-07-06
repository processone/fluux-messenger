import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

/**
 * Aurora identity token guard.
 *
 * The aurora quartet feeds the login mark, the horizon hairline, and the send
 * button. Two invariants:
 *  a. all aurora tokens exist in both modes (dark :root + .light overrides for
 *     the base and rim quartets; ink is mode-stable),
 *  b. the ink icon clears WCAG 3:1 (UI component floor) on EVERY stop of the
 *     reduced-transparency send-button fallback gradient, in both modes,
 *  c. a white icon clears 3:1 on the dark-mode glass send button worst case
 *     (stop at 50% strength over the composer surface, under 10% white glass).
 */

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
const light = { ...dark, ...block('.light') }

type RGB = [number, number, number]
function hex(v: string): RGB {
  const h = v.trim().slice(1)
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function lum([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
function over(fg: RGB, alpha: number, bg: RGB): RGB {
  return [0, 1, 2].map((i) => Math.round(fg[i] * alpha + bg[i] * (1 - alpha))) as RGB
}

const QUARTET = [1, 2, 3, 4].map((i) => `--fluux-aurora-${i}`)
const RIM = [1, 2, 3, 4].map((i) => `--fluux-aurora-rim-${i}`)

describe('aurora identity tokens', () => {
  it('base + rim quartets and ink exist in both modes', () => {
    for (const t of [...QUARTET, ...RIM, '--fluux-aurora-ink']) {
      expect(dark[t], `${t} missing in :root`).toBeDefined()
      expect(light[t], `${t} missing in light resolution`).toBeDefined()
    }
    // light mode overrides the palette (muted dawn), so values must differ
    expect(light['--fluux-aurora-1']).not.toBe(dark['--fluux-aurora-1'])
    expect(light['--fluux-aurora-rim-1']).not.toBe(dark['--fluux-aurora-rim-1'])
  })

  it('ink clears 3:1 on every solid-fallback gradient stop, both modes', () => {
    for (const [name, vars] of [['dark', dark], ['light', light]] as const) {
      const ink = hex(vars['--fluux-aurora-ink'])
      for (const t of QUARTET) {
        const ratio = contrast(ink, hex(vars[t]))
        expect(ratio, `${name} ink on ${t} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('white icon clears 3:1 on the dark glass send-button worst case', () => {
    const composer = hex('#0D1428') // dark composer surface (--fluux-base-05 family)
    const white: RGB = [255, 255, 255]
    for (const t of QUARTET) {
      // glow stop at 50% strength over the composer, then 10% white glass on top
      const backdrop = over(white, 0.1, over(hex(dark[t]), 0.5, composer))
      const ratio = contrast(white, backdrop)
      expect(ratio, `white on glass over ${t} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('send-button fallback CSS', () => {
  it('reduced transparency reverts the glass send button to the solid aurora fill', () => {
    expect(css).toMatch(/\[data-transparency="reduced"\]\s+\.send-aurora:not\(:disabled\)/)
    expect(css).toMatch(/\[data-transparency="reduced"\]\s+\.send-aurora-glow/)
  })

  // Spec §5b: Linux (WebKitGTK) disables the liquid glass tier the same way
  // reduced-transparency does, so the send button must get the identical solid
  // aurora fallback there too, not just under the a11y opt-out.
  it('Linux reverts the glass send button to the solid aurora fill', () => {
    expect(css).toMatch(/:root\[data-platform="linux"\]\s+\.send-aurora:not\(:disabled\)/)
    expect(css).toMatch(/:root\[data-platform="linux"\]\s+\.send-aurora-glow/)
  })
})
