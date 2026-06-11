import { describe, it, expect } from 'vitest'
import { createStallSentinel } from './stallSentinel'

const OPTS = { intervalMs: 500, stallThresholdMs: 1000, cooldownMs: 5000 }

describe('stallSentinel', () => {
  it('returns null on the first tick (baseline only)', () => {
    const sentinel = createStallSentinel(OPTS)
    expect(sentinel.tick(1000, false)).toBeNull()
  })

  it('returns null for on-time ticks', () => {
    const sentinel = createStallSentinel(OPTS)
    sentinel.tick(1000, false)
    expect(sentinel.tick(1500, false)).toBeNull()
    expect(sentinel.tick(2010, false)).toBeNull() // small timer jitter is fine
  })

  it('reports a stall when the gap exceeds interval + threshold', () => {
    const sentinel = createStallSentinel(OPTS)
    sentinel.tick(1000, false)
    const message = sentinel.tick(4000, false) // gap 3000ms, ~2500ms blocked
    expect(message).toContain('[MainThreadStall]')
    expect(message).toContain('~2500ms')
  })

  it('rate-limits stall reports within the cooldown window', () => {
    const sentinel = createStallSentinel(OPTS)
    sentinel.tick(1000, false)
    expect(sentinel.tick(4000, false)).not.toBeNull()
    expect(sentinel.tick(7000, false)).toBeNull() // stall again, but within cooldown
    expect(sentinel.tick(12000, false)).not.toBeNull() // cooldown elapsed
  })

  it('ignores gaps while the document is hidden (background throttling)', () => {
    const sentinel = createStallSentinel(OPTS)
    sentinel.tick(1000, false)
    expect(sentinel.tick(60000, true)).toBeNull() // hidden: no stall, reset baseline
    // First visible tick after hiding only re-baselines — a huge gap is not a stall
    expect(sentinel.tick(120000, false)).toBeNull()
    // ...but a real stall after re-baselining is still caught
    expect(sentinel.tick(125000, false)).not.toBeNull()
  })
})
