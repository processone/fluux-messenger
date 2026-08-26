// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  COUNTER,
  CTX,
  ID,
  initTokenizer,
  METRIC,
  RATE,
  resetValuesForTesting,
  TAG,
  tokenSync,
  warmToken,
} from './values'
import {
  rejectedValueCount,
  resetSerializerCountersForTesting,
  serialize,
  type AnomalyRecord,
  type DigestRecord,
} from './serializer'

beforeEach(async () => {
  localStorage.clear()
  resetValuesForTesting()
  resetSerializerCountersForTesting()
  await initTokenizer()
})

const ENVELOPE = {
  v: 1 as const,
  t: '2026-07-29T11:47:02.000Z',
  sid: 'sid-1',
  build: '0.17.2+abc1234',
  tokenKeyId: '3b91cc07',
}

function anomaly(overrides: Partial<AnomalyRecord> = {}): AnomalyRecord {
  return { ...ENVELOPE, kind: 'anomaly', id: ID.sessionStart, sev: 'bug', ctx: [], crumbs: [], ...overrides }
}

function digest(overrides: Partial<DigestRecord> = {}): DigestRecord {
  return { ...ENVELOPE, kind: 'digest', windowMs: 300_000, counters: [], suppressed: [], ...overrides }
}

describe('happy path', () => {
  it('emits one JSON line with the envelope intact', () => {
    const line = serialize(anomaly({ ctx: [[CTX.route, TAG.focus]], crumbs: [[TAG.msgIn, 3]] }))!
    expect(line).not.toContain('\n')

    const parsed = JSON.parse(line)
    expect(parsed).toMatchObject({ v: 1, sid: 'sid-1', tokenKeyId: '3b91cc07', kind: 'anomaly' })
    expect(parsed.id).toBe('recorder/session-start')
    expect(parsed.ctx).toEqual({ route: 'focus' })
    expect(parsed.crumbs).toEqual([['msg:in', 3]])
  })

  it('carries tokenKeyId on an anomaly record, not only on digests', () => {
    // A short session can produce anomalies and never flush a digest, so a token
    // that lived only in the digest envelope would be unattributable.
    expect(JSON.parse(serialize(anomaly())!).tokenKeyId).toBe('3b91cc07')
  })

  it('serializes a digest with counter and suppressed keys', () => {
    const parsed = JSON.parse(
      serialize(
        digest({
          counters: [[METRIC.mamQueries, 108], [COUNTER.rejectedValue, 0]],
          suppressed: [[ID.ceilingReached, 47]],
        }),
      )!,
    )
    expect(parsed.counters).toEqual({ 'mam.queries': 108, 'recorder/rejected-value': 0 })
    expect(parsed.suppressed).toEqual({ 'recorder/ceiling-reached': 47 })
  })

  it('emits a real entity token unchanged', async () => {
    await warmToken('jid', 'someone@example.com')
    const token = tokenSync('jid', 'someone@example.com')
    expect(JSON.parse(serialize(anomaly({ ctx: [[CTX.conv, token]] }))!).ctx.conv).toBe(token.s)
  })

  it('accepts numbers, booleans and null as values', () => {
    const parsed = JSON.parse(
      serialize(anomaly({ ctx: [[CTX.msg, 3]], expected: true, observed: null }))!,
    )
    expect(parsed.ctx.msg).toBe(3)
    expect(parsed.expected).toBe(true)
    expect(parsed.observed).toBe(null)
  })

  it('omits expected and observed when absent rather than emitting null', () => {
    const parsed = JSON.parse(serialize(anomaly())!)
    expect('expected' in parsed).toBe(false)
    expect('observed' in parsed).toBe(false)
  })

  it('rejects non-finite rate scalars before JSON serialization', () => {
    for (const value of [Infinity, -Infinity, NaN]) {
      expect(
        serialize(digest({ rates: [[RATE.renderPerRoomSwitch.id, value, 1, true]] })),
      ).toBeNull()
    }
    expect(rejectedValueCount()).toBe(3)
  })
})

describe('provenance: a primitive string is rejected wherever caller data could reach', () => {
  const BODY = 'SECRET-BODY-abcdefghijklmnop'

  it.each([
    ['a body in a ctx value', () => anomaly({ ctx: [[CTX.conv, BODY as never]] })],
    ['a body as a ctx key', () => anomaly({ ctx: [[BODY as never, TAG.focus]] })],
    ['a body in a crumb', () => anomaly({ crumbs: [[BODY as never]] })],
    ['a body in expected', () => anomaly({ expected: BODY as never })],
    ['a body in observed', () => anomaly({ observed: BODY as never })],
    ['a body as the id', () => anomaly({ id: BODY as never })],
    ['a body as a counter name', () => digest({ counters: [[BODY as never, 1]] })],
    ['a body as a suppressed key', () => digest({ suppressed: [[BODY as never, 1]] })],
  ])('rejects %s', (_label, build) => {
    const line = serialize(build())
    expect(line).toBeNull()
  })

  // Shape-collision: every one of these would pass a pattern-matching allowlist.
  it.each([
    ['a tag string', 'focus'],
    ['a token-shaped string', 'c:0123456789abcdef'],
    ['a local-ref-shaped string', 's:m41'],
    ['the unresolved sentinel', 'c:unresolved'],
    ['an invariant-id string', 'recorder/session-start'],
  ])('rejects %s arriving as a primitive', (_label, value) => {
    expect(serialize(anomaly({ ctx: [[CTX.conv, value as never]] }))).toBeNull()
  })

  it('rejects a structural forgery of an opaque value', () => {
    expect(serialize(anomaly({ ctx: [[CTX.conv, { s: 'focus' } as never]] }))).toBeNull()
  })

  it('counts every rejection so a detector bug is visible in the digest', () => {
    serialize(anomaly({ ctx: [[CTX.conv, BODY as never]] }))
    serialize(anomaly({ expected: BODY as never }))
    expect(rejectedValueCount()).toBe(2)
  })

  it('emits no prefix of a rejected value — it rejects, it does not truncate', () => {
    const line = serialize(anomaly({ ctx: [[CTX.conv, BODY as never]] }))
    expect(line).toBeNull()
  })
})

describe('provenance: categories are not interchangeable', () => {
  it.each([
    ['a tag as the id', () => anomaly({ id: TAG.focus as never })],
    ['a ctx key as the id', () => anomaly({ id: CTX.conv as never })],
    ['a counter as the id', () => anomaly({ id: COUNTER.rejectedValue as never })],
    ['an id as a ctx key', () => anomaly({ ctx: [[ID.sessionStart as never, TAG.focus]] })],
    ['a tag as a ctx key', () => anomaly({ ctx: [[TAG.focus as never, TAG.focus]] })],
    ['an id as a ctx value', () => anomaly({ ctx: [[CTX.conv, ID.sessionStart as never]] })],
    ['a ctx key as a value', () => anomaly({ ctx: [[CTX.conv, CTX.route as never]] })],
    ['a counter as a crumb value', () => anomaly({ crumbs: [[COUNTER.rejectedValue as never]] })],
    ['a tag as a counter name', () => digest({ counters: [[TAG.focus as never, 1]] })],
    ['a counter as a suppressed key', () => digest({ suppressed: [[COUNTER.rejectedValue as never, 1]] })],
  ])('rejects %s', (_label, build) => {
    expect(serialize(build())).toBeNull()
  })

  it('accepts a token and a local ref as values but not as keys', async () => {
    await warmToken('jid', 'x@example.com')
    const token = tokenSync('jid', 'x@example.com')
    expect(serialize(anomaly({ ctx: [[CTX.conv, token]] }))).not.toBeNull()
    expect(serialize(anomaly({ ctx: [[token as never, TAG.focus]] }))).toBeNull()
  })

  it('rejects a bare scalar in a key position', () => {
    expect(serialize(anomaly({ ctx: [[3 as never, TAG.focus]] }))).toBeNull()
    expect(serialize(digest({ counters: [[1 as never, 5]] }))).toBeNull()
  })
})

describe('record shape is closed', () => {
  const BODY = 'SECRET-BODY-abcdefghijklmnop'

  it('rejects a digest carrying an unexpected property', () => {
    // The digest path used to spread the record, so any extra property was emitted
    // verbatim — a body reaching the log through the object's SHAPE rather than
    // through one of its values.
    expect(serialize({ ...digest(), accidentalBody: BODY } as never)).toBeNull()
  })

  it('rejects an anomaly carrying an unexpected property', () => {
    // The anomaly path builds its output field by field and would silently drop
    // this, but silence hides the detector bug that produced it.
    expect(serialize({ ...anomaly(), accidentalBody: BODY } as never)).toBeNull()
  })

  it.each([
    ['a body', BODY],
    ['an empty string', ''],
    ['a plausible-looking level', 'error'],
    ['a number', 3],
  ])('rejects %s as the severity', (_label, sev) => {
    // `sev` arrives straight from a detector; its union type is erased by any cast.
    expect(serialize(anomaly({ sev: sev as never }))).toBeNull()
  })

  it.each(['bug', 'suspect', 'drift'])('accepts the severity %s', (sev) => {
    expect(serialize(anomaly({ sev: sev as never }))).not.toBeNull()
  })
})

describe('bounds', () => {
  it('caps the crumb array and each crumb at 50 entries', () => {
    const crumbs = Array.from({ length: 400 }, () => [TAG.msgIn, 1])
    expect(JSON.parse(serialize(anomaly({ crumbs }))!).crumbs.length).toBe(50)

    const wide = [Array.from({ length: 400 }, () => TAG.msgIn)]
    expect(JSON.parse(serialize(anomaly({ crumbs: wide }))!).crumbs[0].length).toBe(50)
  })

  it('sheds whole crumbs to fit the line cap and marks the record truncated', () => {
    // 50 crumbs of 50 tags is roughly 22 KB — comfortably over the 8 KB cap.
    const crumbs = Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => TAG.msgIn))
    const parsed = JSON.parse(serialize(anomaly({ crumbs }))!)

    expect(parsed.trunc).toBe(true)
    expect(parsed.crumbs.length).toBeLessThan(50)
    expect(new TextEncoder().encode(JSON.stringify(parsed)).length).toBeLessThanOrEqual(8192)
    // The MOST RECENT crumbs are the ones kept — they are closest to the failure.
    expect(parsed.crumbs.length).toBeGreaterThan(0)
  })

  it('measures the cap in UTF-8 bytes, not UTF-16 code units', () => {
    const line = serialize(anomaly({ crumbs: [[TAG.msgIn]] }))!
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(8192)
  })

  it('rejects a record that cannot be made to fit', () => {
    // Nothing left to shed once crumbs and the optional fields are gone.
    const crumbs = Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => TAG.msgIn))
    expect(serialize(anomaly({ crumbs }), { maxLineBytes: 80 })).toBeNull()
  })

  it('rejects a digest that cannot be made to fit', () => {
    expect(serialize(digest({ counters: [[METRIC.mamQueries, 1]] }), { maxLineBytes: 40 })).toBeNull()
  })

  it.each([
    ['Infinity', Infinity],
    ['a larger finite value', 1_000_000],
    ['NaN', NaN],
    ['zero', 0],
    ['a negative value', -1],
  ])('ignores a maxLineBytes override of %s — the cap can only be lowered', (_label, value) => {
    const crumbs = Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => TAG.msgIn))
    const line = serialize(anomaly({ crumbs }), { maxLineBytes: value })
    expect(line).not.toBeNull()
    expect(new TextEncoder().encode(line!).length).toBeLessThanOrEqual(8192)
  })

  it('bounds the ctx, counter and suppressed walks, not only the crumbs', () => {
    // Repeated keys collapse into a small object, so the byte cap cannot catch a
    // pathological pair list — the walk itself has to be bounded.
    const many = <T,>(pair: T) => Array.from({ length: MAX_PAIRS + 1 }, () => pair)
    expect(serialize(anomaly({ ctx: many([CTX.conv, TAG.focus]) as never }))).toBeNull()
    expect(serialize(digest({ counters: many([METRIC.mamQueries, 1]) as never }))).toBeNull()
    expect(serialize(digest({ suppressed: many([ID.sessionStart, 1]) as never }))).toBeNull()
  })

  it('accepts a pair list exactly at the limit', () => {
    // The control: proves the rejection above is the LIMIT firing, not the pairs
    // being invalid for some other reason.
    const atLimit = Array.from({ length: MAX_PAIRS }, () => [CTX.conv, TAG.focus])
    expect(serialize(anomaly({ ctx: atLimit as never }))).not.toBeNull()
  })
})

/** Mirrors MAX_ARRAY in serializer.ts. */
const MAX_PAIRS = 50
