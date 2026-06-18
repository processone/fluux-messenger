import { describe, it, expect } from 'vitest'
import { adjustMenuPositionToViewport } from './useMenuViewportClamp'

const VIEWPORT = { width: 400, height: 800 }
const MENU = { width: 160, height: 120 }

describe('adjustMenuPositionToViewport', () => {
  it('leaves a comfortably-placed menu untouched', () => {
    const result = adjustMenuPositionToViewport({ x: 50, y: 50 }, MENU, VIEWPORT)
    expect(result).toEqual({ x: 50, y: 50 })
  })

  it('shifts left when the menu would overflow the right edge', () => {
    // x=380 + width 160 = 540 > 400 - 8 → clamp to 400 - 160 - 8 = 232
    const result = adjustMenuPositionToViewport({ x: 380, y: 50 }, MENU, VIEWPORT)
    expect(result.x).toBe(232)
    expect(result.y).toBe(50)
  })

  it('flips above the click point when it would overflow the bottom edge', () => {
    // y=750 + height 120 = 870 > 800 - 8 → above = 750 - 120 = 630 (fits)
    const result = adjustMenuPositionToViewport({ x: 50, y: 750 }, MENU, VIEWPORT)
    expect(result.y).toBe(630)
  })

  it('pins to the bottom edge when it fits neither below nor above', () => {
    const tallMenu = { width: 160, height: 790 }
    // Below overflows; above (10 - 790 < padding) also fails → pin: 800 - 790 - 8 = 2, but floored at padding 8
    const result = adjustMenuPositionToViewport({ x: 50, y: 10 }, tallMenu, VIEWPORT)
    expect(result.y).toBe(8)
  })

  it('clamps both axes at once for a bottom-right long-press', () => {
    const result = adjustMenuPositionToViewport({ x: 390, y: 790 }, MENU, VIEWPORT)
    expect(result.x).toBe(232) // 400 - 160 - 8
    expect(result.y).toBe(670) // flipped above: 790 - 120
  })

  it('never pushes the menu past the left/top padding', () => {
    const hugeMenu = { width: 500, height: 120 }
    const result = adjustMenuPositionToViewport({ x: 390, y: 50 }, hugeMenu, VIEWPORT)
    // 400 - 500 - 8 = -108 → floored at padding 8
    expect(result.x).toBe(8)
  })

  it('respects a custom padding', () => {
    const result = adjustMenuPositionToViewport({ x: 380, y: 50 }, MENU, VIEWPORT, 20)
    // 380 + 160 = 540 > 400 - 20 → 400 - 160 - 20 = 220
    expect(result.x).toBe(220)
  })
})
