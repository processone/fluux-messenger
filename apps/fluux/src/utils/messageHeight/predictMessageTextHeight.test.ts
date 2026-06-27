import { describe, it, expect } from 'vitest'
import { predictMessageTextHeight, type FontSpec } from './predictMessageTextHeight'

const FONT: FontSpec = {
  fontFamily: 'Inter, sans-serif', fontSizePx: 16, fontWeight: 400,
  fontStyle: 'normal', lineHeightPx: 22, letterSpacingPx: 0, whiteSpace: 'pre-wrap',
}

// pretext needs a real Canvas 2D; jsdom's measureText returns 0. Gate numeric cases.
function canvasMeasures(): boolean {
  try {
    if (typeof document === 'undefined') return false
    const ctx = document.createElement('canvas').getContext('2d')
    return !!ctx && ctx.measureText('x').width > 0
  } catch { return false }
}
const canvasAvailable = canvasMeasures()

describe('predictMessageTextHeight', () => {
  it('exports a callable predictor', () => {
    expect(typeof predictMessageTextHeight).toBe('function')
  })

  it.runIf(canvasAvailable)('height = lineCount * lineBoxPx (uses the floored line box, not raw line-height)', () => {
    const p = predictMessageTextHeight('hello world', 560, FONT, 19)
    expect(p.lineCount).toBeGreaterThanOrEqual(1)
    expect(p.heightPx).toBe(p.lineCount * 19) // lineBoxPx, not FONT.lineHeightPx (22)
  })

  it.runIf(canvasAvailable)('wraps to more lines at a narrower width', () => {
    const wide = predictMessageTextHeight('the quick brown fox jumps over the lazy dog repeatedly', 700, FONT, 22)
    const narrow = predictMessageTextHeight('the quick brown fox jumps over the lazy dog repeatedly', 160, FONT, 22)
    expect(narrow.lineCount).toBeGreaterThanOrEqual(wide.lineCount)
  })

  it.runIf(!canvasAvailable)('degrades to a hard-line count without throwing when Canvas 2D is unavailable', () => {
    // jsdom has no canvas: the predictor must NOT throw (it runs on every virtualized render), and
    // falls back to counting explicit newlines.
    expect(() => predictMessageTextHeight('one line', 560, FONT, 20)).not.toThrow()
    expect(predictMessageTextHeight('one line', 560, FONT, 20)).toEqual({ lineCount: 1, heightPx: 20 })
    expect(predictMessageTextHeight('a\nb\nc', 560, FONT, 20)).toEqual({ lineCount: 3, heightPx: 60 })
  })
})
