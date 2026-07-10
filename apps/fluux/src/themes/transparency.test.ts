import { describe, it, expect } from 'vitest'
import { resolveTransparency } from './transparency'

describe('resolveTransparency (reduced-wins merge)', () => {
  it('theme requesting reduced forces reduced even when user chose full', () => {
    expect(
      resolveTransparency({ themeWantsReduced: true, transparencyMode: 'full', systemReducedMatches: false }),
    ).toBe('reduced')
  })

  it('theme not requesting reduced defers to an explicit user setting', () => {
    expect(
      resolveTransparency({ themeWantsReduced: false, transparencyMode: 'full', systemReducedMatches: true }),
    ).toBe('full')
    expect(
      resolveTransparency({ themeWantsReduced: false, transparencyMode: 'reduced', systemReducedMatches: false }),
    ).toBe('reduced')
  })

  it('system mode resolves from the OS media query when the theme is neutral', () => {
    expect(
      resolveTransparency({ themeWantsReduced: false, transparencyMode: 'system', systemReducedMatches: true }),
    ).toBe('reduced')
    expect(
      resolveTransparency({ themeWantsReduced: false, transparencyMode: 'system', systemReducedMatches: false }),
    ).toBe('full')
  })

  it('a theme can never force full over a user/OS reduced preference', () => {
    expect(
      resolveTransparency({ themeWantsReduced: false, transparencyMode: 'reduced', systemReducedMatches: false }),
    ).toBe('reduced')
  })
})
