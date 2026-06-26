import { describe, it, expect } from 'vitest'
import { auroraSenderColor } from './senderColor'
import { getLuminance, contrastRatio, hexToRgb } from './contrastColor'

// Chat-row + hover-row luminances for AA assertions.
const DARK_HOVER_LUM = 0.02   // ~ --fluux-bg-hover (dark)
const LIGHT_HOVER_LUM = 0.80  // representative light row (white chat + slightly darker hover)

function lum(hex: string) {
  const c = hexToRgb(hex)!
  return getLuminance(c.r, c.g, c.b)
}

describe('auroraSenderColor', () => {
  it('is deterministic per identifier + mode', () => {
    expect(auroraSenderColor('alice@x', true)).toBe(auroraSenderColor('alice@x', true))
    expect(auroraSenderColor('alice@x', false)).toBe(auroraSenderColor('alice@x', false))
  })

  it('generally differs for different identifiers', () => {
    const a = auroraSenderColor('alice@x', true)
    const b = auroraSenderColor('bob@x', true)
    expect(a).not.toBe(b)
  })

  it('clears AA on the dark hover row (dark mode)', () => {
    for (const id of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi']) {
      expect(contrastRatio(lum(auroraSenderColor(id, true)), DARK_HOVER_LUM)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('clears AA on the light hover row (light mode)', () => {
    for (const id of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi']) {
      expect(contrastRatio(lum(auroraSenderColor(id, false)), LIGHT_HOVER_LUM)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
