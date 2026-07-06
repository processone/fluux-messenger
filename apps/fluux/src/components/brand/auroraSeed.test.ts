import { describe, it, expect } from 'vitest'
import { mulberry32, starField } from './auroraSeed'

describe('mulberry32', () => {
  it('is deterministic for a fixed seed', () => {
    const a = mulberry32(31)
    const b = mulberry32(31)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('yields values in [0, 1)', () => {
    const r = mulberry32(7)
    for (let i = 0; i < 100; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('starField', () => {
  const region = { x: 56, y: 44, w: 150, h: 110 }

  it('is deterministic for a fixed seed', () => {
    expect(starField(31, 8, region)).toEqual(starField(31, 8, region))
  })

  it('produces count stars within the region and spec ranges', () => {
    const stars = starField(31, 8, region)
    expect(stars).toHaveLength(8)
    for (const s of stars) {
      expect(s.cx).toBeGreaterThanOrEqual(region.x)
      expect(s.cx).toBeLessThanOrEqual(region.x + region.w)
      expect(s.cy).toBeGreaterThanOrEqual(region.y)
      // stars sit in the upper 75% of the region (below feels like floor dust)
      expect(s.cy).toBeLessThanOrEqual(region.y + region.h * 0.75)
      expect(s.r).toBeGreaterThanOrEqual(0.5)
      expect(s.r).toBeLessThanOrEqual(1.3)
      expect(s.opacity).toBeGreaterThanOrEqual(0.2)
      expect(s.opacity).toBeLessThanOrEqual(0.75)
    }
  })
})
