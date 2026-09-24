import { describe, it, expect } from 'vitest'
import { messageMenuLayout } from './messageMenuLayout'

const viewport = { left: 12, top: 12, width: 366, height: 820 }

describe('messageMenuLayout', () => {
  it('preserves the source position and width when controls fit around it', () => {
    const layout = messageMenuLayout({ left: 76, top: 240, width: 260, height: 90 }, viewport, 58, 180, 90, 288)
    expect(layout.x + layout.previewOffset).toBe(76)
    expect(layout.y + 58 + 8).toBe(240)
    expect(layout.previewWidth).toBe(260)
    expect(layout.previewMaxHeight).toBeGreaterThanOrEqual(90)
  })

  it('moves the group only as far as necessary at the bottom', () => {
    const layout = messageMenuLayout({ left: 76, top: 750, width: 260, height: 90 }, viewport, 58, 180, 90, 288)
    expect(layout.y + 58 + 16 + 90 + 180).toBe(832)
  })

  it('does not truncate a tall preview when the whole group fits', () => {
    const layout = messageMenuLayout({ left: 40, top: 90, width: 320, height: 480 }, viewport, 58, 180, 480, 288)
    expect(layout.y + 58 + 8).toBe(90)
    expect(layout.previewMaxHeight).toBeGreaterThanOrEqual(480)
  })

  it('truncates the preview to the remaining space after the menus', () => {
    const layout = messageMenuLayout({ left: 40, top: 90, width: 320, height: 1200 }, viewport, 58, 180, 1200, 288)
    expect(layout.previewMaxHeight).toBe(566)
    expect(layout.y).toBe(12)
  })

  it('keeps context and scrollable actions inside a short keyboard viewport', () => {
    const layout = messageMenuLayout({ left: 40, top: 400, width: 320, height: 500 }, { ...viewport, top: 20, height: 250 }, 58, 453, 500, 352)
    expect(layout.previewMaxHeight).toBe(64)
    expect(layout.actionsMaxHeight).toBe(112)
    expect(layout.y).toBe(20)
  })
})
