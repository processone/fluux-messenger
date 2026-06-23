import { describe, it, expect } from 'vitest'
import { anchorMenuToTrigger } from './useAnchoredMenu'

// A roomy viewport where nothing needs clamping unless the test forces it.
const VIEWPORT = { width: 1000, height: 800 }
const MENU = { width: 200, height: 150 }
const GAP = 4
const PADDING = 8

describe('anchorMenuToTrigger', () => {
  it('opens downward just below the trigger by default', () => {
    const trigger = { left: 100, top: 40, bottom: 70 }
    const pos = anchorMenuToTrigger(trigger, MENU, VIEWPORT)
    expect(pos).toEqual({ x: 100, y: 70 + GAP })
  })

  it('opens upward with the menu bottom above the trigger top', () => {
    const trigger = { left: 100, top: 400, bottom: 430 }
    const pos = anchorMenuToTrigger(trigger, MENU, VIEWPORT, 'up')
    expect(pos).toEqual({ x: 100, y: 400 - GAP - MENU.height })
  })

  it('shifts left when the menu would overflow the right edge', () => {
    const trigger = { left: 900, top: 40, bottom: 70 }
    const pos = anchorMenuToTrigger(trigger, MENU, VIEWPORT)
    expect(pos.x).toBe(VIEWPORT.width - MENU.width - PADDING) // 792
    expect(pos.x + MENU.width).toBeLessThanOrEqual(VIEWPORT.width - PADDING)
  })

  it('never positions past the left edge', () => {
    const trigger = { left: -50, top: 40, bottom: 70 }
    const pos = anchorMenuToTrigger(trigger, MENU, VIEWPORT)
    expect(pos.x).toBe(PADDING)
  })

  it('flips a downward menu above the trigger when there is no room below', () => {
    const trigger = { left: 100, top: 700, bottom: 740 }
    const pos = anchorMenuToTrigger(trigger, MENU, VIEWPORT)
    // below (744) + 150 = 894 > 800-8, so it flips above.
    expect(pos.y).toBe(700 - GAP - MENU.height)
  })

  it('flips an upward menu below the trigger when there is no room above', () => {
    const trigger = { left: 100, top: 40, bottom: 70 }
    const pos = anchorMenuToTrigger(trigger, MENU, VIEWPORT, 'up')
    // above (40-4-150 = -114) < padding, so it flips below.
    expect(pos.y).toBe(70 + GAP)
  })

  it('pins inside the viewport when the menu fits on neither side', () => {
    const tallMenu = { width: 200, height: 790 }
    const trigger = { left: 100, top: 400, bottom: 430 }
    const pos = anchorMenuToTrigger(trigger, tallMenu, VIEWPORT, 'up')
    expect(pos.y).toBe(PADDING) // max(8, 800 - 790 - 8) = max(8, 2) = 8
  })

  it('respects a custom gap and padding', () => {
    const trigger = { left: 100, top: 40, bottom: 70 }
    const pos = anchorMenuToTrigger(trigger, MENU, VIEWPORT, 'down', 12, 16)
    expect(pos).toEqual({ x: 100, y: 70 + 12 })
  })
})
