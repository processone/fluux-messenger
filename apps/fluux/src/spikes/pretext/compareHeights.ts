import type { CorpusCategory } from './corpus'
import type { Prediction } from './predictTextHeight'

export interface Sample {
  id: string
  category: CorpusCategory
  widthPx: number
  predicted: Prediction
  measuredHeightPx: number
  measuredLineCount: number
}

export interface CategoryStat {
  count: number
  /**
   * RAW line-count-exact rate for this category: the percentage of samples
   * whose predicted `lineCount` equals the measured `lineCount`. This counts
   * line match ONLY and ignores height error entirely.
   *
   * Do NOT conflate with `Report.overall.textLineExactPct`, which is stricter:
   * it additionally requires the absolute height error to be within
   * `heightTolPx`. A category can report 100% here yet still contribute
   * failures to the overall metric.
   */
  lineExactPct: number
  p95AbsErrPx: number
  maxAbsErrPx: number
  worstId: string
}

export interface Report {
  generatedNote: string
  byCategory: Record<string, CategoryStat>
  overall: { textLineExactPct: number; passesThreshold: boolean }
  worstOffenders: Sample[]
}

function p95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)
  return sorted[idx]
}

export function buildReport(
  samples: Sample[],
  opts: { lineExactThresholdPct: number; heightTolPx: number; textCategories: CorpusCategory[] },
): Report {
  const byCategory: Record<string, CategoryStat> = {}
  const categories = [...new Set(samples.map((s) => s.category))]

  for (const cat of categories) {
    const inCat = samples.filter((s) => s.category === cat)
    const exact = inCat.filter((s) => s.predicted.lineCount === s.measuredLineCount)
    const absErrs = inCat.map((s) => Math.abs(s.predicted.heightPx - s.measuredHeightPx))
    let worstId = inCat[0]?.id ?? ''
    let worstErr = -1
    for (const s of inCat) {
      const e = Math.abs(s.predicted.heightPx - s.measuredHeightPx)
      if (e > worstErr) {
        worstErr = e
        worstId = s.id
      }
    }
    byCategory[cat] = {
      count: inCat.length,
      lineExactPct: inCat.length ? (exact.length / inCat.length) * 100 : 0,
      p95AbsErrPx: p95(absErrs),
      // `absErrs` is always non-empty here (a category exists only because it
      // has >= 1 sample); the `0` is just a defensive floor for the spread.
      maxAbsErrPx: Math.max(0, ...absErrs),
      worstId,
    }
  }

  const textSamples = samples.filter((s) => opts.textCategories.includes(s.category))
  const textExact = textSamples.filter(
    (s) =>
      s.predicted.lineCount === s.measuredLineCount &&
      Math.abs(s.predicted.heightPx - s.measuredHeightPx) <= opts.heightTolPx,
  )
  const textLineExactPct = textSamples.length ? (textExact.length / textSamples.length) * 100 : 0

  const worstOffenders = [...samples]
    .sort(
      (a, b) =>
        Math.abs(b.predicted.heightPx - b.measuredHeightPx) -
        Math.abs(a.predicted.heightPx - a.measuredHeightPx),
    )
    .slice(0, 10)

  return {
    generatedNote: 'pretext height spike report',
    byCategory,
    overall: { textLineExactPct, passesThreshold: textLineExactPct >= opts.lineExactThresholdPct },
    worstOffenders,
  }
}
