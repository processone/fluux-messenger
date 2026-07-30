import { describe, it, expect, vi, afterEach } from 'vitest'
import { createStallSentinel, startStallSentinel } from './stallSentinel'
import {
  clearAnomalySignalHandler,
  setAnomalySignalHandler,
  type AnomalySignal,
} from './anomalySignal'

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
    const warning = sentinel.tick(4000, false) // gap 3000ms, ~2500ms blocked
    expect(warning!.message).toContain('[MainThreadStall]')
    expect(warning!.message).toContain('~2500ms')

    // The structured view must agree with the prose: they are one observation
    // reported twice, and the anomaly log records only the numbers.
    expect(warning!.blockedMs).toBe(2500)
    expect(warning!.thresholdMs).toBe(1000)
  })

  it('carries no route in its structured fields, only in the prose', () => {
    // The prose context is a route, and a route contains the conversation JID.
    // It must reach fluux.log and never a structured record.
    const sentinel = createStallSentinel({ ...OPTS, getContext: () => 'route: #/chat/bob@x.tld' })
    sentinel.tick(1000, false)
    const warning = sentinel.tick(4000, false)

    expect(warning!.message).toContain('bob@x.tld')
    expect(Object.keys(warning!).sort()).toEqual(['blockedMs', 'message', 'thresholdMs'])
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

/**
 * The fan-out promise: `fluux.log` is untouched. The anomaly record is a SECOND
 * output, never a replacement, and the prose must not shift by a byte whether or
 * not anything is listening.
 */
describe('startStallSentinel prose preservation', () => {
  const EXPECTED =
    '[MainThreadStall] main thread blocked ~2500ms (route: /) — ' +
    'heartbeat expected every 500ms, fired after 3000ms'

  afterEach(() => {
    clearAnomalySignalHandler()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** Drive one baseline tick then one late tick, returning what console.warn saw. */
  function runOneStall(): string[][] {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)

    const stop = startStallSentinel(OPTS)
    vi.advanceTimersByTime(500) // baseline at t=1000
    clock = 4000
    vi.advanceTimersByTime(500) // fires 3000ms after the baseline
    stop()

    return warn.mock.calls as string[][]
  }

  it('logs the line verbatim, with no extra arguments', () => {
    const calls = runOneStall()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([EXPECTED])
  })

  it('logs the identical line while the anomaly runtime is listening', () => {
    const seen: AnomalySignal[] = []
    setAnomalySignalHandler((s) => seen.push(s))

    const calls = runOneStall()

    expect(calls[0]).toEqual([EXPECTED])
    // ...and the record was produced IN ADDITION, so this is fan-out and not a
    // test that merely proves nothing happened.
    expect(seen).toEqual([
      { name: 'perf/main-thread-stall', blockedMs: 2500, thresholdMs: 1000 },
    ])
  })
})
