// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createRecorder, type Recorder } from './recorder'
import { resetSerializerCountersForTesting } from './serializer'
import type { Sink } from './sinks/sink'
import {
  COUNTER,
  CTX,
  ID,
  initTokenizer,
  localRef,
  METRIC,
  releaseRef,
  resetValuesForTesting,
  retainRef,
  TAG,
} from './values'

function fakeSink(): Sink & { lines: string[] } {
  const lines: string[] = []
  return { lines, write: (line) => lines.push(line), failureCount: () => 0, disabled: () => false }
}

let clock = 0
const now = () => clock

beforeEach(async () => {
  clock = 0
  localStorage.clear()
  resetValuesForTesting()
  resetSerializerCountersForTesting()
  await initTokenizer()
})

function make(sink: Sink, maxBytes?: () => number): Recorder {
  return createRecorder({ sink, now, build: '0.17.2+abc', sid: 'sid-1', maxBytes })
}

const parsed = (sink: { lines: string[] }) => sink.lines.map((l) => JSON.parse(l))
const digests = (sink: { lines: string[] }) => parsed(sink).filter((r) => r.kind === 'digest')

describe('records and breadcrumbs', () => {
  it('writes an anomaly with the most recent crumbs attached', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.crumb([TAG.msgIn, 1])
    rec.crumb([TAG.focus])
    rec.record({ id: ID.sessionStart, sev: 'bug' })

    const r = parsed(sink)[0]
    expect(r.id).toBe('recorder/session-start')
    expect(r.crumbs).toEqual([['msg:in', 1], ['focus']])
    expect(r.tokenKeyId).toMatch(/^[0-9a-f]{8}$/)
    expect(r.sid).toBe('sid-1')
  })

  it('bounds the ring at 100 and attaches the newest 50', () => {
    const sink = fakeSink()
    const rec = make(sink)
    for (let i = 0; i < 150; i++) rec.crumb([TAG.msgIn, i])
    rec.record({ id: ID.sessionStart, sev: 'bug' })

    const crumbs = parsed(sink)[0].crumbs
    expect(crumbs).toHaveLength(50)
    expect(crumbs[49]).toEqual(['msg:in', 149])
    expect(crumbs[0]).toEqual(['msg:in', 100])
  })

  it('carries ctx through to the line', () => {
    const sink = fakeSink()
    make(sink).record({ id: ID.sessionStart, sev: 'bug', ctx: [[CTX.route, TAG.focus]] })
    expect(parsed(sink)[0].ctx).toEqual({ route: 'focus' })
  })

  it('drops a record the serializer rejects, without writing anything', () => {
    const sink = fakeSink()
    make(sink).record({ id: ID.sessionStart, sev: 'bug', ctx: [[CTX.conv, 'raw' as never]] })
    expect(sink.lines).toHaveLength(0)
  })

  it('exposes a stable session id', () => {
    expect(make(fakeSink()).sessionId()).toBe('sid-1')
  })
})

describe('cooldown and suppression', () => {
  it('coalesces repeats of one id inside the cooldown', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    clock = 30_000
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    clock = 59_999
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    expect(sink.lines).toHaveLength(1)
  })

  it('writes again once the cooldown expires', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    clock = 60_001
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    expect(sink.lines).toHaveLength(2)
  })

  it('reports suppressed counts, so coalescing never hides frequency', () => {
    const sink = fakeSink()
    const rec = make(sink)
    for (let i = 0; i < 48; i++) rec.record({ id: ID.sessionStart, sev: 'bug' })
    rec.flushDigest(300_000)
    expect(digests(sink)[0].suppressed['recorder/session-start']).toBe(47)
  })

  it('cools down per id, not globally', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    rec.record({ id: ID.ceilingReached, sev: 'drift' })
    expect(sink.lines).toHaveLength(2)
  })

  it('does not start the cooldown for a record that was never written', () => {
    // A rejected record must not suppress its own retry.
    const sink = fakeSink()
    const rec = make(sink)
    rec.record({ id: ID.sessionStart, sev: 'bug', ctx: [[CTX.conv, 'raw' as never]] })
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    expect(sink.lines).toHaveLength(1)
  })
})

describe('counters', () => {
  it('accumulates application metrics into the digest', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.count(METRIC.mamQueries, 3)
    rec.count(METRIC.mamQueries)
    rec.flushDigest(300_000)
    expect(digests(sink)[0].counters['mam.queries']).toBe(4)
  })

  it('refuses a reserved counter name instead of silently losing the value', () => {
    // The digest appends the health counters under these names; an application
    // counter sharing one would be overwritten by the health delta on fold.
    expect(() => make(fakeSink()).count(COUNTER.tokenUnresolved, 5)).toThrow(/reserved/)
  })

  it('reports health counters as per-window deltas, not running totals', () => {
    const sink = fakeSink()
    const rec = make(sink)

    rec.record({ id: ID.sessionStart, sev: 'bug', ctx: [[CTX.conv, 'raw' as never]] })
    rec.record({ id: ID.ceilingReached, sev: 'bug', ctx: [[CTX.conv, 'raw' as never]] })
    rec.flushDigest(300_000)

    clock = 120_000
    rec.record({ id: ID.sessionStart, sev: 'bug', ctx: [[CTX.conv, 'raw' as never]] })
    rec.flushDigest(300_000)

    const [first, second] = digests(sink)
    expect(first.counters['recorder/rejected-value']).toBe(2)
    // Cumulative would say 3 here; the window saw 1.
    expect(second.counters['recorder/rejected-value']).toBe(1)
  })

  it('clears application counters after a successful flush', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.count(METRIC.roomJoins, 10)
    rec.flushDigest(300_000)
    rec.flushDigest(300_000)
    expect(digests(sink)[1].counters['room.joins']).toBeUndefined()
  })
})

describe('the session ceiling', () => {
  it('stops at the record ceiling and says so instead of going quiet', () => {
    const sink = fakeSink()
    const rec = make(sink)
    for (let i = 0; i < 600; i++) {
      clock += 60_001
      rec.record({ id: ID.sessionStart, sev: 'bug' })
    }
    const all = parsed(sink)
    expect(all).toHaveLength(501)
    expect(all[500].id).toBe('recorder/ceiling-reached')
  })

  it('announces the ceiling when a PROSPECTIVE refusal blocks a record', () => {
    // emit() returns false before writing, so bytesWritten does not move and
    // atCeiling() stays false. Without an explicit announce the recorder would go
    // quiet with no record explaining why.
    const sink = fakeSink()
    const rec = make(sink, () => 1)
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    expect(parsed(sink).map((r) => r.id)).toContain('recorder/ceiling-reached')
  })

  it('announces the ceiling exactly once', () => {
    const sink = fakeSink()
    const rec = make(sink, () => 1)
    for (let i = 0; i < 5; i++) {
      clock += 60_001
      rec.record({ id: ID.sessionStart, sev: 'bug' })
    }
    expect(parsed(sink).filter((r) => r.id === 'recorder/ceiling-reached')).toHaveLength(1)
  })

  it('never writes past the byte budget, counting the line about to be written', () => {
    // Two defects at once: `line.length` counts UTF-16 code units rather than
    // bytes, and a retrospective check lets the LAST line cross the cap.
    const sink = fakeSink()
    const rec = make(sink, () => 4096)
    for (let i = 0; i < 400; i++) {
      clock += 60_001
      rec.crumb([TAG.msgIn, i])
      rec.record({ id: ID.sessionStart, sev: 'bug' })
    }

    const encoder = new TextEncoder()
    const sizes = sink.lines.map((l) => encoder.encode(l).length)
    const total = sizes.reduce((a, b) => a + b, 0)
    // The ceiling notice is force-written, so allow exactly one line of headroom.
    expect(total).toBeLessThanOrEqual(4096 + Math.max(...sizes))
    expect(sink.lines.length).toBeGreaterThan(1)
  })

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // With all-ASCII content the two are identical, so the plain budget test above
    // cannot tell them apart. The envelope's `build` and `sid` are caller-supplied
    // strings, and the accounting has to be right for its inputs rather than for
    // what today's callers happen to pass — so drive it with a multi-byte build.
    const sink = fakeSink()
    const budget = 4096
    const rec = createRecorder({
      sink,
      now,
      build: 'é'.repeat(100), // 100 UTF-16 units, 200 UTF-8 bytes
      sid: 'sid-1',
      maxBytes: () => budget,
    })

    for (let i = 0; i < 200; i++) {
      clock += 60_001
      rec.record({ id: ID.sessionStart, sev: 'bug' })
    }

    const encoder = new TextEncoder()
    const sizes = sink.lines.map((l) => encoder.encode(l).length)
    const total = sizes.reduce((a, b) => a + b, 0)

    // Under UTF-16 counting the recorder under-measures every line by 100 bytes and
    // keeps writing well past the budget.
    expect(total).toBeLessThanOrEqual(budget + Math.max(...sizes))
  })

  it('applies the ceiling to digests too', () => {
    const sink = fakeSink()
    const rec = make(sink)
    for (let i = 0; i < 600; i++) {
      clock += 60_001
      rec.record({ id: ID.sessionStart, sev: 'bug' })
    }
    const before = sink.lines.length
    rec.flushDigest(300_000)
    rec.flushDigest(300_000)
    // A digest is a record; an unbounded digest stream is an unbounded file.
    expect(sink.lines).toHaveLength(before)
  })
})

describe('digest atomicity', () => {
  it('preserves the SAME window when a digest could not be written', () => {
    // The limit is raised on the SAME recorder. A second recorder would prove
    // nothing about the first one's state, which is exactly what is at stake: if
    // the baselines advanced and the counters cleared on a failed emit, the
    // window's data would be gone AND the next delta would be measured from a
    // report that never existed.
    const sink = fakeSink()
    let budget = 1
    const rec = make(sink, () => budget)

    rec.count(METRIC.mamQueries, 9)
    rec.flushDigest(300_000)
    expect(digests(sink)).toHaveLength(0)

    budget = 1024 * 1024
    rec.flushDigest(300_000)

    expect(digests(sink)[0].counters['mam.queries']).toBe(9)
  })

  it('does not advance a health baseline on a failed flush', () => {
    const sink = fakeSink()
    let budget = 1
    const rec = make(sink, () => budget)

    rec.record({ id: ID.sessionStart, sev: 'bug', ctx: [[CTX.conv, 'raw' as never]] })
    rec.flushDigest(300_000)
    expect(digests(sink)).toHaveLength(0)

    budget = 1024 * 1024
    rec.flushDigest(300_000)
    // Still 1: the failed flush must not have consumed the rejection.
    expect(digests(sink)[0].counters['recorder/rejected-value']).toBe(1)
  })
})

describe('the ring pins local refs', () => {
  it('keeps a ref alive while it sits in the ring, and frees it on eviction', () => {
    const sink = fakeSink()
    const rec = make(sink)

    // One ref held by TWO crumbs and one in-flight request.
    const ref = localRef('q', 'query-1')!
    retainRef('q', 'query-1')
    rec.crumb([TAG.mamQuery, ref])
    rec.crumb([TAG.mamResult, ref])

    // Push both crumbs out of the 100-entry ring, releasing two of the three holds.
    for (let i = 0; i < 120; i++) rec.crumb([TAG.msgIn, i])

    // Still pinned by the open request, so pressure cannot reassign its identity.
    for (let i = 0; i < 2100; i++) localRef('m', `filler-${i}`)
    expect(localRef('q', 'query-1')!.s).toBe(ref.s)

    // Request completes: last hold gone, now evictable.
    releaseRef('q', 'query-1')
    for (let i = 0; i < 2100; i++) localRef('m', `more-${i}`)
    expect(localRef('q', 'query-1')!.s).not.toBe(ref.s)
  })
})
