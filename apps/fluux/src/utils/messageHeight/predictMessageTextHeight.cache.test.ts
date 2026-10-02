/**
 * @vitest-environment jsdom
 *
 * Cost bounds of the predictor. pretext is replaced by a fixed-advance line breaker so the calls
 * it receives can be counted; jsdom has no Canvas 2D, so getContext is stubbed to let the
 * predictor take its pretext path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const CHAR_PX = 8

vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ text })),
  layout: vi.fn((prepared: { text: string }, maxWidth: number, lineHeight: number) => {
    const perLine = Math.max(1, Math.floor(maxWidth / CHAR_PX))
    const lineCount = prepared.text.split('\n')
      .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / perLine)), 0)
    return { lineCount, height: lineCount * lineHeight }
  }),
}))

import { layout, prepare } from '@chenglou/pretext'
import {
  CAPPED_PREDICTION_PREFIX_CHARS, clearPredictionCache, predictMessageTextHeight, type FontSpec,
} from './predictMessageTextHeight'

const FONT: FontSpec = {
  fontFamily: 'Inter, sans-serif', fontSizePx: 16, fontWeight: 400,
  fontStyle: 'normal', lineHeightPx: 22, letterSpacingPx: 0, whiteSpace: 'pre-wrap',
}

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
})
afterAll(() => vi.restoreAllMocks())
beforeEach(() => {
  clearPredictionCache()
  vi.mocked(prepare).mockClear()
  vi.mocked(layout).mockClear()
})

describe('predictMessageTextHeight cost', () => {
  it('runs pretext once for repeated predictions of the same body, width and font', () => {
    const body = 'the quick brown fox jumps over the lazy dog '.repeat(20)
    const first = predictMessageTextHeight(body, 560, FONT, 22)
    const second = predictMessageTextHeight(body, 560, FONT, 22)
    expect(second).toEqual(first)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(layout).toHaveBeenCalledTimes(1)
  })

  it('predicts again when the width, the font or the line box changes', () => {
    const body = 'hello world'
    predictMessageTextHeight(body, 560, FONT, 22)
    predictMessageTextHeight(body, 400, FONT, 22)
    predictMessageTextHeight(body, 560, { ...FONT, fontSizePx: 18 }, 22)
    predictMessageTextHeight(body, 560, FONT, 21)
    expect(prepare).toHaveBeenCalledTimes(4)
  })

  it('reuses fallback and calibrated widths when a conversation reopens', () => {
    const body = 'the quick brown fox jumps over the lazy dog '.repeat(20)
    const fallback = predictMessageTextHeight(body, 560, FONT, 22, 500)
    const calibrated = predictMessageTextHeight(body, 800, FONT, 22, 500)
    expect(predictMessageTextHeight(body, 560, FONT, 22, 500)).toBe(fallback)
    expect(predictMessageTextHeight(body, 800, FONT, 22, 500)).toBe(calibrated)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(layout).toHaveBeenCalledTimes(2)
  })

  it('keeps four contexts per body and evicts the least recently used', () => {
    const body = 'hello world'
    for (const width of [400, 560, 800, 1000]) predictMessageTextHeight(body, width, FONT, 22)
    predictMessageTextHeight(body, 400, FONT, 22)
    predictMessageTextHeight(body, 1200, FONT, 22)
    for (const width of [400, 800, 1000, 1200]) predictMessageTextHeight(body, width, FONT, 22)
    expect(prepare).toHaveBeenCalledTimes(5)
    predictMessageTextHeight(body, 560, FONT, 22)
    expect(prepare).toHaveBeenCalledTimes(6)
  })

  it('counts each body once toward the character budget across contexts', () => {
    const bodies = ['a', 'b'].map(c => c.repeat(4_000_000))
    for (const body of bodies) {
      for (const width of [400, 560, 800, 1000]) predictMessageTextHeight(body, width, FONT, 22, 500)
    }
    for (const body of bodies) {
      for (const width of [400, 560, 800, 1000]) predictMessageTextHeight(body, width, FONT, 22, 500)
    }
    expect(prepare).toHaveBeenCalledTimes(8)
  })

  it('counts bodies rather than contexts toward the entry limit', () => {
    for (let i = 0; i < 1000; i++) {
      predictMessageTextHeight(`body ${i}`, 560, FONT, 22)
      predictMessageTextHeight(`body ${i}`, 800, FONT, 22)
    }
    vi.mocked(prepare).mockClear()
    predictMessageTextHeight('body 0', 560, FONT, 22)
    predictMessageTextHeight('body 0', 800, FONT, 22)
    expect(prepare).not.toHaveBeenCalled()
    predictMessageTextHeight('body 1000', 560, FONT, 22)
    predictMessageTextHeight('body 0', 560, FONT, 22)
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('evicts the oldest bodies once the cached characters pass the budget', () => {
    const bodies = ['a', 'b', 'c'].map(c => c.repeat(3_000_000))
    for (const body of bodies) predictMessageTextHeight(body, 560, FONT, 22, 500)
    vi.mocked(prepare).mockClear()
    predictMessageTextHeight(bodies[2], 560, FONT, 22, 500)
    expect(prepare).not.toHaveBeenCalled()
    predictMessageTextHeight(bodies[0], 560, FONT, 22, 500)
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('bounds a 100 KB body to the cap and hands pretext only a prefix', () => {
    const body = 'x'.repeat(100 * 1024)
    const prediction = predictMessageTextHeight(body, 560, FONT, 22, 500)
    expect(prediction.heightPx).toBeLessThanOrEqual(500)
    expect(prediction.exceedsMax).toBe(true)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(vi.mocked(prepare).mock.calls[0][0].length).toBeLessThanOrEqual(CAPPED_PREDICTION_PREFIX_CHARS)
  })

  it('extrapolates past the prefix when the prefix alone stays under the cap', () => {
    // 3000 chars at 1600 px (200 chars a line) is 15 lines = 330 px; 6000 chars is 30 lines.
    const prediction = predictMessageTextHeight('x'.repeat(6000), 1600, FONT, 22, 1000)
    expect(prediction).toEqual({ lineCount: 30, heightPx: 660 })
  })

  it('leaves a body under the cap exact and unflagged', () => {
    const prediction = predictMessageTextHeight('x'.repeat(700), 560, FONT, 22, 500)
    expect(prediction).toEqual({ lineCount: 10, heightPx: 220 })
  })
})
