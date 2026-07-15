import { describe, it, expect } from 'vitest'
import { createDownloadProgressTracker } from './downloadProgressTracker'

describe('createDownloadProgressTracker', () => {
  it('emits 0 on Started and 100 on Finished', () => {
    const now = 0
    const tracker = createDownloadProgressTracker(100, () => now)

    expect(tracker.handle({ event: 'Started', data: { contentLength: 1000 } })).toBe(0)
    expect(tracker.handle({ event: 'Finished' })).toBe(100)
  })

  it('throttles rapid Progress events to one emit per interval', () => {
    let now = 0
    const tracker = createDownloadProgressTracker(100, () => now)
    tracker.handle({ event: 'Started', data: { contentLength: 1000 } }) // lastEmit = 0

    // 100 chunks of 1 byte each, all arriving within the same 100ms window.
    let emits = 0
    for (let i = 0; i < 100; i++) {
      now = i // advance <100ms total
      if (tracker.handle({ event: 'Progress', data: { chunkLength: 1 } }) !== null) emits++
    }

    // None should have emitted — all fell inside the throttle interval.
    expect(emits).toBe(0)
  })

  it('emits the accumulated progress once the interval has elapsed', () => {
    let now = 0
    const tracker = createDownloadProgressTracker(100, () => now)
    tracker.handle({ event: 'Started', data: { contentLength: 1000 } })

    // 200 bytes accumulate silently within the interval...
    for (let i = 0; i < 200; i++) {
      now = i / 10 // 0..19.9ms
      tracker.handle({ event: 'Progress', data: { chunkLength: 1 } })
    }
    // ...then a chunk after the interval flushes the accumulated 20%.
    now = 100
    const emitted = tracker.handle({ event: 'Progress', data: { chunkLength: 1 } })
    expect(emitted).toBeCloseTo(20.1, 5)
  })

  it('caps Progress at 99 during download', () => {
    let now = 0
    const tracker = createDownloadProgressTracker(0, () => now)
    tracker.handle({ event: 'Started', data: { contentLength: 100 } })

    // One giant chunk that would overshoot 100%.
    now = 1
    expect(tracker.handle({ event: 'Progress', data: { chunkLength: 1000 } })).toBe(99)
  })

  it('skips Progress events when contentLength is unknown', () => {
    let now = 0
    const tracker = createDownloadProgressTracker(0, () => now)
    tracker.handle({ event: 'Started', data: {} }) // no contentLength

    now = 1
    expect(tracker.handle({ event: 'Progress', data: { chunkLength: 50 } })).toBeNull()
  })
})
