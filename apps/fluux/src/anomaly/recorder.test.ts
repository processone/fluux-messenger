// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRecorder, type Recorder } from './recorder'
import { resetSerializerCountersForTesting } from './serializer'
import type { Sink } from './sinks/sink'
import {
  COUNTER,
  CTX,
  ENV,
  ID,
  initTokenizer,
  localRef,
  METRIC,
  releaseRef,
  resetValuesForTesting,
  retainRef,
  TAG,
  tokenSync,
  tokenWarmFailureCount,
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

afterEach(() => {
  vi.restoreAllMocks()
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
    expect(r.crumbs).toEqual([[0, 'msg:in', 1], [0, 'focus']])
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
    expect(crumbs[49]).toEqual([0, 'msg:in', 149])
    expect(crumbs[0]).toEqual([0, 'msg:in', 100])
  })

  it('prefixes crumbs with their age relative to the record timestamp', () => {
    const sink = fakeSink()
    const rec = make(sink)
    clock = 1000
    rec.crumb([TAG.msgIn])
    clock = 9500
    rec.crumb([TAG.focus])
    clock = 10_000
    rec.record({ id: ID.sessionStart, sev: 'bug' })

    const record = parsed(sink)[0]
    expect(record.crumbs).toEqual([[9000, 'msg:in'], [500, 'focus']])
    expect(record.crumbs[0][0]).toBeGreaterThan(record.crumbs[1][0])
    expect(new Date(record.t).getTime()).toBe(10_000)
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

  it('reports rejected background token warms as recorder health', async () => {
    const sink = fakeSink()
    const rec = make(sink)
    vi.spyOn(crypto.subtle, 'sign').mockRejectedValueOnce(new Error('subtle.sign failed'))

    tokenSync('jid', 'failing-recorder@example.com')
    await vi.waitFor(() => expect(tokenWarmFailureCount()).toBe(1))
    rec.flushDigest(300_000)

    expect(digests(sink)[0].counters['recorder/token-warm-failed']).toBe(1)
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
  // The window must survive a flush that failed WITHOUT the budget being reached.
  // A budget refusal is terminal by design, so the probe here is a SERIALIZATION
  // failure — the recorder keeps running and the data must still be reportable.
  it('preserves the SAME window when a digest could not be built', () => {
    const sink = fakeSink()
    const rec = make(sink)

    rec.count(METRIC.mamQueries, 9)
    rec.flushDigest(Number.NaN) // rejected by the serializer
    expect(digests(sink)).toHaveLength(0)

    rec.flushDigest(300_000)
    expect(digests(sink)[0].counters['mam.queries']).toBe(9)
  })

  it('does not advance a health baseline on a failed flush', () => {
    const sink = fakeSink()
    const rec = make(sink)

    rec.record({ id: ID.sessionStart, sev: 'bug', ctx: [[CTX.conv, 'raw' as never]] })
    rec.flushDigest(Number.NaN)
    expect(digests(sink)).toHaveLength(0)

    rec.flushDigest(300_000)
    // Still 1: the failed flush must not have consumed the rejection.
    expect(digests(sink)[0].counters['recorder/rejected-value']).toBe(1)
  })

  it('does NOT announce the ceiling when a digest merely failed to build', () => {
    // A malformed digest is not a budget event. Claiming the ceiling here would
    // say the recorder had stopped when nothing was exhausted.
    const sink = fakeSink()
    const rec = make(sink)
    rec.flushDigest(Number.NaN)
    expect(parsed(sink)).toHaveLength(0)

    rec.record({ id: ID.sessionStart, sev: 'bug' })
    expect(parsed(sink)).toHaveLength(1)
  })

  it('rejects a non-finite window rather than writing it', () => {
    const sink = fakeSink()
    make(sink).flushDigest('SECRET-WINDOW' as never)
    expect(sink.lines.join()).not.toContain('SECRET-WINDOW')
    expect(sink.lines).toHaveLength(0)
  })
})

describe('inputs cannot bypass the runtime guards', () => {
  const BODY = 'SECRET-BODY-abcdefghij'

  it('rejects a repeat carrying a raw value instead of counting it as suppressed', () => {
    // The cooldown used to run BEFORE serialization, so a repeat with a body was
    // filed as a suppression and never reached the rejected-value counter.
    const sink = fakeSink()
    const rec = make(sink)
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    rec.record({ id: ID.sessionStart, sev: 'bug', ctx: [[BODY as never, TAG.focus]] })
    rec.flushDigest(300_000)
    expect(digests(sink)[0].counters['recorder/rejected-value']).toBe(1)
    expect(digests(sink)[0].suppressed['recorder/session-start']).toBeUndefined()
  })

  it('cannot have its suppressed map poisoned by a forged id', () => {
    // A forgery whose `.s` matched a real id used to be stored as a suppressed key,
    // which then failed to serialize and took the whole digest down with it —
    // producing a false ceiling-reached into the bargain.
    const sink = fakeSink()
    const rec = make(sink)
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    rec.record({ id: { s: 'recorder/session-start' } as never, sev: 'bug' })
    rec.flushDigest(300_000)

    expect(digests(sink)).toHaveLength(1)
    expect(parsed(sink).some((r) => r.id === 'recorder/ceiling-reached')).toBe(false)
  })

  it('copies the crumb, so a later mutation cannot rewrite the ring', () => {
    const sink = fakeSink()
    const rec = make(sink)
    const parts = [TAG.msgIn, 1]
    rec.crumb(parts)
    parts[1] = BODY as never
    rec.record({ id: ID.sessionStart, sev: 'bug' })

    expect(sink.lines.join()).not.toContain(BODY)
    expect(sink.lines).toHaveLength(1)
  })

  it('drops a crumb carrying an inadmissible entry rather than storing it', () => {
    // An unvalidated entry would sit in the ring and poison every record that
    // attached it, long after the call that added it.
    const sink = fakeSink()
    const rec = make(sink)
    rec.crumb([TAG.msgIn, BODY as never])
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    expect(parsed(sink)[0].crumbs).toEqual([])
  })

  it('bounds the width of a stored crumb', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.crumb(Array.from({ length: 400 }, () => TAG.msgIn))
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    expect(parsed(sink)[0].crumbs[0]).toHaveLength(50)
  })

  it.each([
    ['a non-counter constant', () => ID.sessionStart, 1],
    ['a ctx key', () => CTX.conv, 1],
    ['a tag', () => TAG.focus, 1],
  ])('refuses count() with %s', (_label, key, by) => {
    expect(() => make(fakeSink()).count((key() as unknown) as never, by)).toThrow()
  })

  it.each([Infinity, -Infinity, NaN])('refuses a %s increment', (by) => {
    expect(() => make(fakeSink()).count(METRIC.probe, by)).toThrow(/finite/)
  })

  it.each([
    ['Infinity', () => Infinity],
    ['a larger finite budget', () => 1e12],
    ['NaN', () => NaN],
    ['zero', () => 0],
  ])('ignores a maxBytes override of %s — the budget can only be lowered', (_label, budget) => {
    const sink = fakeSink()
    const rec = make(sink, budget)
    for (let i = 0; i < 60; i++) rec.crumb(Array.from({ length: 50 }, () => TAG.msgIn))
    for (let i = 0; i < 600; i++) {
      clock += 60_001
      rec.record({ id: ID.sessionStart, sev: 'bug' })
    }
    const total = sink.lines.reduce((n, l) => n + new TextEncoder().encode(l).length + 1, 0)
    expect(total).toBeLessThanOrEqual(2 * 1024 * 1024 + 8193)
  })

  it('becomes terminal once the budget refuses a write', () => {
    // Announcing alone was not enough: a single line too large for the remaining
    // budget produced a ceiling-reached record while the recorder kept writing, so
    // the log claimed it had stopped and had not.
    const sink = fakeSink()
    const rec = make(sink, () => 4096)
    for (let i = 0; i < 60; i++) rec.crumb(Array.from({ length: 50 }, () => TAG.msgIn))
    rec.record({ id: ID.sessionStart, sev: 'bug' })

    const after = sink.lines.length
    expect(parsed(sink).some((r) => r.id === 'recorder/ceiling-reached')).toBe(true)

    rec.flushDigest(300_000)
    clock += 60_001
    rec.record({ id: ID.sessionStart, sev: 'bug' })
    expect(sink.lines).toHaveLength(after)
  })

  it('counts the newline the sink appends against the budget', () => {
    // A record line is 177 bytes and MAX_RECORDS is 500, so any budget under
    // ~88 KB is the binding constraint rather than the record count — which is
    // what makes the one-byte-per-record drift observable at all. At 80 KB the
    // difference is about 2 records, well outside the single-line headroom the
    // forced ceiling notice needs.
    const budget = 80_000
    const sink = fakeSink()
    const rec = make(sink, () => budget)
    for (let i = 0; i < 600; i++) {
      clock += 60_001
      rec.record({ id: ID.sessionStart, sev: 'bug' })
    }

    const onDisk = sink.lines.reduce((n, l) => n + new TextEncoder().encode(l).length + 1, 0)
    // Only the forced ceiling notice may exceed the budget.
    expect(onDisk).toBeLessThanOrEqual(budget + 200)
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

describe('rates', () => {
  it('reports a rate as its numerator and its sample count, not as a quotient', () => {
    // The DENOMINATOR travels with every rate because the review tool suppresses a
    // drift verdict below a minimum sample size: three room switches producing a high
    // render rate is noise, and a bare quotient cannot be told apart from a real one.
    // The recorder does no division — a quotient it computed would lose exactly the
    // number needed to judge whether the quotient means anything.
    const sink = fakeSink()
    const rec = make(sink)
    rec.count(METRIC.renderMessageList, 40)
    rec.count(METRIC.messageArrivals, 10)
    rec.count(METRIC.roomSwitches, 4)
    rec.count(METRIC.scrollWrites, 12)
    rec.count(METRIC.scrollPositioningOps, 6)
    rec.flushDigest(1000)

    expect(digests(sink)[0].rates).toEqual({
      'render.MessageList/roomSwitch': { n: 40, d: 4, informational: true },
      'scroll.writes/positioning': { n: 12, d: 6, informational: true },
    })
  })

  it('omits a rate that saw no activity, so an idle window stays small', () => {
    const sink = fakeSink()
    const rec = make(sink)
    rec.count(METRIC.roomJoins, 1)
    rec.flushDigest(1000)

    expect(digests(sink)[0].rates).toEqual({})
  })

  it('still reports a numerator that ran against no denominator at all', () => {
    // Renders with zero arrivals is the most interesting shape this can take — work
    // done for no reason. Dropping it as a divide-by-zero would hide the one window
    // worth looking at.
    const sink = fakeSink()
    const rec = make(sink)
    rec.count(METRIC.renderMessageList, 40)
    rec.flushDigest(1000)

    expect(digests(sink)[0].rates).toEqual({
      'render.MessageList/roomSwitch': { n: 40, d: 0, informational: true },
    })
  })

  it('carries the environment, so two platforms are never compared as one series', () => {
    // A WebKitGTK session and a macOS session produce different rates for reasons
    // that are not regressions. A baseline that silently mixes them drifts forever.
    const sink = fakeSink()
    const rec = createRecorder({
      sink,
      now,
      build: '0.17.2+abc',
      sid: 'sid-1',
      env: () => [
        [ENV.platform, TAG.platformMacos],
        [ENV.engine, TAG.engineWebkit],
        [ENV.sizeClass, TAG.sizeLg],
      ],
    })
    rec.flushDigest(1000)

    expect(digests(sink)[0].env).toEqual({
      platform: 'macos',
      engine: 'webkit',
      sizeClass: 'lg',
    })
  })
})
