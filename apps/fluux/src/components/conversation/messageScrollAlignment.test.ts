import { describe, it, expect } from 'vitest'
import { anchorBottomScrollTop, markerScrollTop, prependAnchorScrollTop } from './messageScrollAlignment'

describe('messageScrollAlignment', () => {
  it('anchorBottomScrollTop puts the anchor bottom at its saved gap from the viewport bottom', () => {
    // anchor at offset 1000, height 40, was 12px above the viewport bottom, viewport 800 tall
    expect(anchorBottomScrollTop(1000, 40, 12, 800)).toBe(1000 + 40 + 12 - 800) // 252
  })

  it('markerScrollTop places the target ~1/3 from the top, clamped at 0', () => {
    expect(markerScrollTop(900, 600)).toBe(900 - 200) // 700
    expect(markerScrollTop(50, 600)).toBe(0)          // clamped
  })

  it('prependAnchorScrollTop keeps the anchor at the same offset-from-top after prepend', () => {
    expect(prependAnchorScrollTop(1500, 120)).toBe(1380)
  })
})
