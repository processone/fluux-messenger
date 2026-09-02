import { describe, it, expect } from 'vitest'
import { createTrafficDetector, type TrafficOptions } from './xmppTraffic'
import type { OutFacts } from './stanzaFacts'
import { CTX, ID, TAG } from '../values'
import type { RecordInput } from '../recorder'

/** Any minted constant: the detector only needs token identity, never its value. */
const TOKEN = TAG.focus

function discoTo(jid: string, id: string): OutFacts {
  return { id, kind: 'disco-info', to: jid, dedupe: `disco-info|${jid}|` }
}

function setup(overrides: Partial<TrafficOptions> = {}) {
  const records: RecordInput[] = []
  const detector = createTrafficDetector({
    record: (input) => records.push(input),
    token: () => TOKEN,
    ...overrides,
  })
  return { detector, records }
}

function sampleUntil(detector: ReturnType<typeof createTrafficDetector>, end: number): void {
  for (let now = 1_000; now <= end; now += 1_000) detector.sweep(now)
}

describe('redundant-query', () => {
  it('fires when an answered query is repeated inside the window', () => {
    const { detector, records } = setup()
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'result' }, 100)
    detector.observeOut(discoTo('example.com', 'q2'), 5_000)

    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(ID.redundantQuery)
    expect(records[0].sev).toBe('suspect')
    expect(records[0].expected).toBe(1)
    expect(records[0].observed).toBe(2)
    expect(records[0].ctx).toEqual(
      expect.arrayContaining([
        [CTX.query, TAG.qDiscoInfo],
        [CTX.target, TOKEN],
        [CTX.elapsedMs, 4_900],
      ]),
    )
  })

  it('counts a third query in the same window as three', () => {
    const { detector, records } = setup()
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'result' }, 100)
    detector.observeOut(discoTo('example.com', 'q2'), 1_000)
    detector.observeIn({ id: 'q2', type: 'result' }, 1_100)
    detector.observeOut(discoTo('example.com', 'q3'), 2_000)

    expect(records.map((r) => r.observed)).toEqual([2, 3])
    expect(records[1].ctx).toEqual(expect.arrayContaining([[CTX.elapsedMs, 1_900]]))
  })

  it('stays silent once the window has passed', () => {
    const { detector, records } = setup({ redundantWindowMs: 60_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'result' }, 100)
    detector.observeOut(discoTo('example.com', 'q2'), 61_000)

    expect(records).toEqual([])
  })

  it('treats a re-query after an error as a retry, not a redundancy', () => {
    const { detector, records } = setup()
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'error' }, 100)
    detector.observeOut(discoTo('example.com', 'q2'), 1_000)

    expect(records).toEqual([])
  })

  it('closes an answered episode when a repeated query errors', () => {
    const { detector, records } = setup()
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'result' }, 100)
    detector.observeOut(discoTo('example.com', 'q2'), 1_000)
    detector.observeIn({ id: 'q2', type: 'error' }, 1_100)
    detector.observeOut(discoTo('example.com', 'q3'), 2_000)

    expect(records.filter((record) => record.id === ID.redundantQuery)).toHaveLength(1)
  })

  it('closes an answered episode when a repeated query times out', () => {
    const { detector, records } = setup({ unansweredMs: 30_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'result' }, 100)
    detector.observeOut(discoTo('example.com', 'q2'), 1_000)
    sampleUntil(detector, 31_000)
    detector.observeOut(discoTo('example.com', 'q3'), 32_000)

    expect(records.filter((record) => record.id === ID.redundantQuery)).toHaveLength(1)
    expect(records.filter((record) => record.id === ID.iqUnanswered)).toHaveLength(1)
  })

  it('closes an answered episode when its repeated query is evicted', () => {
    const { detector, records } = setup({ maxTracked: 2 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'result' }, 100)
    detector.observeOut(discoTo('example.com', 'q2'), 1_000)
    detector.observeOut(discoTo('other.example.com', 'q3'), 1_100)
    detector.observeOut(discoTo('third.example.com', 'q4'), 1_200)
    detector.observeIn({ id: 'q2', type: 'error' }, 1_300)
    detector.observeOut(discoTo('example.com', 'q5'), 2_000)

    expect(records.filter((record) => record.id === ID.redundantQuery)).toHaveLength(1)
  })

  it('says nothing about a query that has not been answered yet', () => {
    const { detector, records } = setup()
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeOut(discoTo('example.com', 'q2'), 1_000)

    expect(records).toEqual([])
  })

  it('separates two targets', () => {
    const { detector, records } = setup()
    detector.observeOut(discoTo('a.example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'result' }, 10)
    detector.observeOut(discoTo('b.example.com', 'q2'), 20)

    expect(records).toEqual([])
  })

  it('never judges a query with no dedupe key', () => {
    const { detector, records } = setup()
    const mam: OutFacts = { id: 'm1', kind: 'mam', to: 'a@example.com', dedupe: null }
    detector.observeOut(mam, 0)
    detector.observeIn({ id: 'm1', type: 'result' }, 10)
    detector.observeOut({ ...mam, id: 'm2' }, 20)

    expect(records).toEqual([])
  })

  it('forgets what was answered when the connection resets', () => {
    const { detector, records } = setup()
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'result' }, 10)
    detector.reset()
    // Re-querying disco after a reconnect is correct: the server may not be the
    // same one, and its features may have changed.
    detector.observeOut(discoTo('example.com', 'q2'), 20)

    expect(records).toEqual([])
  })
})

describe('iq-unanswered', () => {
  it('fires once the threshold is reached with no reply', () => {
    const { detector, records } = setup({ unansweredMs: 30_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)

    sampleUntil(detector, 29_000)
    expect(records).toEqual([])

    detector.sweep(30_000)
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(ID.iqUnanswered)
    expect(records[0].sev).toBe('bug')
    expect(records[0].expected).toBe(30_000)
    expect(records[0].observed).toBe(30_000)
    expect(records[0].ctx).toEqual(
      expect.arrayContaining([
        [CTX.query, TAG.qDiscoInfo],
        [CTX.target, TOKEN],
      ]),
    )
  })

  it('reports one pending IQ once, not on every sweep', () => {
    const { detector, records } = setup({ unansweredMs: 30_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    sampleUntil(detector, 31_000)
    detector.sweep(45_000)

    expect(records).toHaveLength(1)
  })

  it('stays silent when the reply arrives in time', () => {
    const { detector, records } = setup({ unansweredMs: 30_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'result' }, 500)
    detector.sweep(60_000)

    expect(records).toEqual([])
  })

  it('reports a reply that reaches the threshold before the next sweep', () => {
    const { detector, records } = setup({ unansweredMs: 30_000, maxSweepStepMs: 1_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    sampleUntil(detector, 29_000)

    detector.observeIn({ id: 'q1', type: 'result' }, 30_500)
    detector.observeOut(discoTo('example.com', 'q2'), 30_501)

    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(ID.iqUnanswered)
    expect(records[0].observed).toBe(30_000)
  })

  it('accepts an error reply as an answer', () => {
    const { detector, records } = setup({ unansweredMs: 30_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'error' }, 500)
    detector.sweep(60_000)

    // A `service-unavailable` is a reply. Only silence is the invariant break.
    expect(records).toEqual([])
  })

  it('forgets everything in flight when the connection resets', () => {
    const { detector, records } = setup({ unansweredMs: 30_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.reset()
    detector.sweep(60_000)

    expect(records).toEqual([])
  })

  it('bounds what it tracks', () => {
    const { detector, records } = setup({ unansweredMs: 30_000, maxTracked: 2 })
    detector.observeOut(discoTo('a.example.com', 'q1'), 0)
    detector.observeOut(discoTo('b.example.com', 'q2'), 1)
    detector.observeOut(discoTo('c.example.com', 'q3'), 2)
    sampleUntil(detector, 33_000)

    // The oldest was evicted rather than retained: a leak inside a detector is
    // worse than a missed record.
    expect(records).toHaveLength(2)
  })

  it('ignores a reply to something it never saw sent', () => {
    const { detector, records } = setup({ unansweredMs: 30_000 })
    detector.observeIn({ id: 'unknown-1', type: 'result' }, 100)
    detector.observeOut(discoTo('example.com', 'q1'), 200)
    detector.observeIn({ id: 'q1', type: 'result' }, 300)
    detector.sweep(60_000)

    expect(records).toEqual([])
  })

  it('does not count a suspended interval as observed waiting time', () => {
    const { detector, records } = setup({ unansweredMs: 30_000, maxSweepStepMs: 1_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)

    detector.sweep(3_600_000)

    expect(records).toEqual([])
    detector.observeIn({ id: 'q1', type: 'result' }, 3_600_001)
    detector.sweep(3_601_000)
    expect(records).toEqual([])
  })
})
