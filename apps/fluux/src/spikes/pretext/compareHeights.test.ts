import { describe, it, expect } from 'vitest'
import { buildReport, type Sample } from './compareHeights'
import type { Prediction } from './predictTextHeight'

const pred = (h: number, lines: number): Prediction => ({ heightPx: h, lineCount: lines })

const samples: Sample[] = [
  { id: 'a', category: 'short', widthPx: 560, predicted: pred(20, 1), measuredHeightPx: 20, measuredLineCount: 1 },
  { id: 'b', category: 'wrap', widthPx: 560, predicted: pred(40, 2), measuredHeightPx: 41, measuredLineCount: 2 },
  { id: 'c', category: 'wrap', widthPx: 560, predicted: pred(40, 2), measuredHeightPx: 60, measuredLineCount: 3 }, // off by one line
  { id: 'd', category: 'code', widthPx: 560, predicted: pred(60, 3), measuredHeightPx: 120, measuredLineCount: 3 }, // out of scope
]

describe('buildReport', () => {
  it('computes per-category line-exactness and excludes non-text categories from the overall pass', () => {
    const r = buildReport(samples, { lineExactThresholdPct: 98, heightTolPx: 2, textCategories: ['short', 'wrap'] })
    expect(r.byCategory.short.lineExactPct).toBe(100)
    expect(r.byCategory.wrap.lineExactPct).toBe(50) // b exact, c off-by-line
    // overall text line-exact = 2 of 3 text samples = 66.7% -> below 98 -> fails
    expect(r.overall.textLineExactPct).toBeCloseTo(66.67, 1)
    expect(r.overall.passesThreshold).toBe(false)
    expect(r.byCategory.code).toBeDefined() // still reported, just not counted
  })

  it('passes when all text samples are line-exact within height tolerance', () => {
    const good: Sample[] = [
      { id: 'a', category: 'short', widthPx: 560, predicted: pred(20, 1), measuredHeightPx: 21, measuredLineCount: 1 },
      { id: 'b', category: 'wrap', widthPx: 560, predicted: pred(40, 2), measuredHeightPx: 40, measuredLineCount: 2 },
    ]
    const r = buildReport(good, { lineExactThresholdPct: 98, heightTolPx: 2, textCategories: ['short', 'wrap'] })
    expect(r.overall.passesThreshold).toBe(true)
  })
})
