import { describe, it, expect } from 'vitest'
import { getLuminance, contrastRatio, ensureContrast, ensureContrastWithWhite, hexToRgb } from './contrastColor'

describe('contrastColor', () => {
  it('parses hex to rgb', () => {
    expect(hexToRgb('#ff8800')).toEqual({ r: 255, g: 136, b: 0 })
  })

  it('ensureContrastWithWhite darkens a light color until AA on white', () => {
    const out = ensureContrastWithWhite('#FFE066') // light yellow, fails on white
    const rgb = hexToRgb(out)!
    expect(contrastRatio(getLuminance(rgb.r, rgb.g, rgb.b), 1.0)).toBeGreaterThanOrEqual(4.5)
  })

  it('ensureContrast leaves an already-dark color unchanged', () => {
    expect(ensureContrast('#103060', 0.8)).toBe('#103060')
  })

  it('ensureContrast darkens until AA on the given background', () => {
    const out = ensureContrast('#66D08A', 0.8) // light green on a light bg
    const rgb = hexToRgb(out)!
    expect(contrastRatio(getLuminance(rgb.r, rgb.g, rgb.b), 0.8)).toBeGreaterThanOrEqual(4.5)
  })
})
