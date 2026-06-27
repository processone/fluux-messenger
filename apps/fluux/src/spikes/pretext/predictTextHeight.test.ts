import { describe, it, expect } from 'vitest'
import { predictTextHeight, type FontSpec } from './predictTextHeight'

const FONT: FontSpec = {
  fontFamily: 'Inter, sans-serif',
  fontSizePx: 14,
  fontWeight: 400,
  fontStyle: 'normal',
  lineHeightPx: 14 * 1.375,
  letterSpacingPx: 0,
  whiteSpace: 'pre-wrap',
}

// pretext uses Canvas 2D measureText. jsdom exposes `document` but its canvas
// returns width 0, so gate on whether measureText actually returns a width.
// In the app's jsdom vitest these numeric cases SKIP; real numeric validation
// happens in the browser harness (Tasks 5 and 6).
function canvasMeasures(): boolean {
  try {
    if (typeof document === 'undefined') return false
    const ctx = document.createElement('canvas').getContext('2d')
    return !!ctx && ctx.measureText('x').width > 0
  } catch {
    return false
  }
}
const canvasAvailable = canvasMeasures()

describe('predictTextHeight', () => {
  it.runIf(canvasAvailable)('returns >0 height and >=1 line for non-empty text', () => {
    const p = predictTextHeight('hello world', 560, FONT)
    expect(p.heightPx).toBeGreaterThan(0)
    expect(p.lineCount).toBeGreaterThanOrEqual(1)
  })

  it.runIf(canvasAvailable)('wraps to more lines at a narrower width', () => {
    const wide = predictTextHeight('the quick brown fox jumps over the lazy dog repeatedly', 700, FONT)
    const narrow = predictTextHeight('the quick brown fox jumps over the lazy dog repeatedly', 160, FONT)
    expect(narrow.lineCount).toBeGreaterThanOrEqual(wide.lineCount)
  })

  it('exports a callable predictor', () => {
    expect(typeof predictTextHeight).toBe('function')
  })
})
