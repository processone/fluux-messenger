import { describe, it, expect } from 'vitest'
import { resolveTransparency } from './transparency'

describe('resolveTransparency (reduced-wins merge)', () => {
  it('theme requesting reduced forces reduced even when user chose full', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: true,
        transparencyMode: 'full',
        systemReducedMatches: false,
        compositorCannotBlur: false,
      }),
    ).toBe('reduced')
  })

  it('theme not requesting reduced defers to an explicit user setting', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: false,
        transparencyMode: 'full',
        systemReducedMatches: true,
        compositorCannotBlur: false,
      }),
    ).toBe('full')
    expect(
      resolveTransparency({
        themeWantsReduced: false,
        transparencyMode: 'reduced',
        systemReducedMatches: false,
        compositorCannotBlur: false,
      }),
    ).toBe('reduced')
  })

  it('system mode resolves from the OS media query when the theme is neutral', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: false,
        transparencyMode: 'system',
        systemReducedMatches: true,
        compositorCannotBlur: false,
      }),
    ).toBe('reduced')
    expect(
      resolveTransparency({
        themeWantsReduced: false,
        transparencyMode: 'system',
        systemReducedMatches: false,
        compositorCannotBlur: false,
      }),
    ).toBe('full')
  })

  it('a theme can never force full over a user/OS reduced preference', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: false,
        transparencyMode: 'reduced',
        systemReducedMatches: false,
        compositorCannotBlur: false,
      }),
    ).toBe('reduced')
  })
})

describe('resolveTransparency (software-rendering probe)', () => {
  it('flattens glass in system mode when the compositor cannot blur', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: false,
        transparencyMode: 'system',
        systemReducedMatches: false,
        compositorCannotBlur: true,
      }),
    ).toBe('reduced')
  })

  it('leaves glass on in system mode when the compositor can blur', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: false,
        transparencyMode: 'system',
        systemReducedMatches: false,
        compositorCannotBlur: false,
      }),
    ).toBe('full')
  })

  it('lets an explicit full override the probe (escape hatch for false positives)', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: false,
        transparencyMode: 'full',
        systemReducedMatches: false,
        compositorCannotBlur: true,
      }),
    ).toBe('full')
  })

  it('still flattens on an explicit reduced regardless of the probe', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: false,
        transparencyMode: 'reduced',
        systemReducedMatches: false,
        compositorCannotBlur: false,
      }),
    ).toBe('reduced')
  })

  it('a theme forcing reduced still wins over everything', () => {
    expect(
      resolveTransparency({
        themeWantsReduced: true,
        transparencyMode: 'full',
        systemReducedMatches: false,
        compositorCannotBlur: false,
      }),
    ).toBe('reduced')
  })
})
