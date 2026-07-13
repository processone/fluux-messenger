import { describe, it, expect, vi } from 'vitest'
import { createUploadProgressReporter } from './uploadProgressReporter'

describe('createUploadProgressReporter', () => {
  it('skips emits when the rounded overall percent is unchanged', () => {
    const emit = vi.fn()
    const reporter = createUploadProgressReporter(100, 0, emit)

    reporter.setMain(0)  // overall 0 — matches the initial 0 baseline → skip
    reporter.setMain(5)  // → 5
    reporter.setMain(5)  // same integer repeats (the redundant-render case) → skip
    reporter.setMain(42) // → 42

    expect(emit.mock.calls.map(c => c[0])).toEqual([5, 42])
  })

  it('weights main and thumbnail progress by their byte size', () => {
    const emit = vi.fn()
    // 75-byte main + 25-byte thumb → main weight 0.75, thumb weight 0.25.
    const reporter = createUploadProgressReporter(75, 25, emit)

    reporter.setMain(100)      // round(100*0.75 + 0*0.25) = 75
    reporter.setThumbnail(100) // round(100*0.75 + 100*0.25) = 100

    expect(emit.mock.calls.map(c => c[0])).toEqual([75, 100])
  })

  it('reports raw main percent when there is no thumbnail', () => {
    const emit = vi.fn()
    const reporter = createUploadProgressReporter(100, 0, emit)

    reporter.setMain(37)

    expect(emit).toHaveBeenCalledExactlyOnceWith(37)
  })
})
