/**
 * Property tests for the resident-window timeline transitions.
 *
 * Every transition here is dedupe → sort → trim, so they share one set of laws:
 * the resident array never holds two messages with a common XEP-0359 identity
 * key, it is always in cache order, it never exceeds the window bound, and it
 * never contains a message that was not handed in. Those hold for `appendLive`,
 * `mergeArchive` and the three cache-slice loads alike, so they are checked
 * through one runner rather than restated five times.
 *
 * On top of that sit the two laws a message archive actually needs: refetching a
 * MAM page must change nothing (idempotence), and two disjoint pages must reach
 * the same window whichever order they arrive in (convergence).
 *
 * Generators use tiny pools for timestamps and ids. Same-millisecond ties and
 * overlapping pages are the whole subject; random values would produce neither.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  appendLive,
  mergeArchive,
  loadOlderSlice,
  loadNewerSlice,
  latestSlice,
  type TimelineConfig,
  type TimelineMessage,
} from './messageTimeline'
import { sortMessagesByTimestamp } from './messageArrayUtils'

interface TestMessage extends TimelineMessage {
  id: string
  from: string
  timestamp: Date
  stanzaId?: string
  originId?: string
}

/**
 * The chat store's key shape. `messageTimeline` is generic in `getKeys`, so one
 * realistic key function exercises its dedupe fully; the per-store builders have
 * their own tests.
 */
const getKeys = (m: TestMessage): string[] => {
  const keys: string[] = []
  if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
  if (m.originId) keys.push(`originId:${m.originId}`)
  keys.push(`from:${m.from}:id:${m.id}`)
  return keys
}

type Kind = 'chat' | 'room'
const configFor = (kind: Kind, windowSize: number): TimelineConfig<TestMessage> => ({
  getKeys,
  sameMessage: (a, b) => {
    const bKeys = new Set(getKeys(b))
    return getKeys(a).some((key) => bKeys.has(key))
  },
  getMergeCandidates: (_incoming, candidates) => [...candidates],
  windowSize,
  kind,
})

const FROMS = ['a@s', 'b@s'] as const

/**
 * A message's whole content is determined by its identity. `id` fixes the
 * timestamp as well as the archive ids, because the same message carries the
 * same timestamp wherever it appears — in the resident array, in a MAM page and
 * in a cache slice alike. Drawing the timestamp separately lets one identity
 * appear at two different times, which no archive can produce, and every
 * ordering property then fails on the fixture rather than on the code.
 *
 * Several ids deliberately share a millisecond: same-millisecond ties are the
 * boundary the sort and tie-break rules exist for.
 */
const TIMESTAMP_BY_ID = { m1: 0, m2: 0, m3: 1, m4: 1, m5: 2 } as const
const IDS = Object.keys(TIMESTAMP_BY_ID) as (keyof typeof TIMESTAMP_BY_ID)[]

/**
 * In a 1:1 chat the cache keyPath is `id` alone, so an id names one message and
 * `from` cannot vary independently of it. In a room the key is `(from, id)`, so
 * the same id from two occupants is a legitimate pair. Letting two chat messages
 * share an id creates rows the chat cache would collapse into one, and the
 * ordering comparator — which breaks chat ties by `id` only — then cannot
 * separate them.
 */
const FROM_BY_ID = { m1: 'a@s', m2: 'b@s', m3: 'a@s', m4: 'b@s', m5: 'a@s' } as const

/**
 * Archive and origin ids are DERIVED from the message identity, never drawn
 * independently. XEP-0359 ids name one message: two distinct messages cannot
 * share a `stanzaId`, and the same message carries the same one wherever it
 * appears. Drawing them from a pool manufactures collisions the archive cannot
 * produce, and the dedupe then looks broken when it is the fixture that is.
 *
 * What still varies, and is the point, is PRESENCE: the live copy of an outgoing
 * message has no `stanzaId` until its archived copy donates one.
 */
const messageArbFor = (kind: Kind): fc.Arbitrary<TestMessage> =>
  fc
    .record({
      id: fc.constantFrom(...IDS),
      from: kind === 'room' ? fc.constantFrom(...FROMS) : fc.constant(undefined),
      hasStanzaId: fc.boolean(),
      hasOriginId: fc.boolean(),
    })
    .map(({ id, from, hasStanzaId, hasOriginId }) => {
      const sender = from ?? FROM_BY_ID[id]
      return {
        id,
        from: sender,
        timestamp: new Date(TIMESTAMP_BY_ID[id]),
        stanzaId: hasStanzaId ? `s-${sender}-${id}` : undefined,
        originId: hasOriginId ? `o-${sender}-${id}` : undefined,
      }
    })

/** A resident array is already deduped and sorted — no transition ever yields otherwise. */
const residentArb = (kind: Kind) =>
  fc.array(messageArbFor(kind), { maxLength: 6 }).map((ms) => normalise(ms, kind))

/**
 * A batch is a SET of distinct messages. An IndexedDB slice comes from a keyed
 * store and a MAM page does not repeat a message, so a batch holding the same
 * identity twice is not a state the archive can produce. It may of course
 * overlap the resident array — that overlap is what dedupe exists for.
 */
const batchArbFor = (kind: Kind) =>
  fc.array(messageArbFor(kind), { maxLength: 5 }).map(uniqueByIdentity)

function uniqueByIdentity(messages: TestMessage[]): TestMessage[] {
  const seen = new Set<string>()
  return messages.filter((m) => {
    const key = identity(m)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalise(messages: TestMessage[], kind: Kind): TestMessage[] {
  const seen = new Set<string>()
  const unique: TestMessage[] = []
  for (const m of messages) {
    if (getKeys(m).some((k) => seen.has(k))) continue
    getKeys(m).forEach((k) => seen.add(k))
    unique.push(m)
  }
  return sortMessagesByTimestamp(unique, kind)
}

const identity = (m: TestMessage) => `${m.from}:${m.id}`

/** The laws every transition shares. */
function checkTimelineLaws(
  result: TestMessage[],
  residents: TestMessage[],
  incoming: TestMessage[],
  kind: Kind,
  windowSize: number,
) {
  // 1. No two resident messages share an identity key.
  const seen = new Set<string>()
  for (const m of result) {
    for (const key of getKeys(m)) {
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  }

  // 2. Always in cache order — the same comparator the read pointer walks by.
  expect(result).toEqual(sortMessagesByTimestamp(result, kind))

  // 3. Never grows past the window. A transition that changes nothing hands the
  //    input back untouched, so an already-oversized array may stay oversized.
  expect(result.length).toBeLessThanOrEqual(Math.max(windowSize, residents.length))

  // 4. Never invents a message: every identity came from one of the two inputs.
  const supplied = new Set([...residents, ...incoming].map(identity))
  for (const m of result) expect(supplied.has(identity(m))).toBe(true)
}

/**
 * One flat scenario per property. Nesting `fc.assert` inside a property would
 * split the inputs across two shrinkers, and neither could shrink the other's
 * half — counterexamples come back large and unreadable.
 */
interface Scenario {
  kind: Kind
  windowSize: number
  residents: TestMessage[]
  page: TestMessage[]
  pageB: TestMessage[]
  incoming: TestMessage
  direction: 'backward' | 'forward'
  isFetchLatest: boolean
  atLiveEdge: boolean
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .constantFrom<Kind>('chat', 'room')
  .chain((kind) =>
    fc.record({
      kind: fc.constant(kind),
      windowSize: fc.integer({ min: 1, max: 5 }),
      residents: residentArb(kind),
      page: batchArbFor(kind),
      pageB: batchArbFor(kind),
      incoming: messageArbFor(kind),
      direction: fc.constantFrom<'backward' | 'forward'>('backward', 'forward'),
      isFetchLatest: fc.boolean(),
      atLiveEdge: fc.boolean(),
    }),
  )

/** A window large enough never to bind, isolating merge semantics from trimming. */
const UNBOUNDED = 64

describe('timeline transitions share one set of laws', () => {
  it('mergeArchive holds them in both directions', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, windowSize, residents, page, direction, isFetchLatest }) => {
        const cfg = configFor(kind, windowSize)
        const { merged } = mergeArchive(residents, page, direction, cfg, isFetchLatest)
        checkTimelineLaws(merged, residents, page, kind, windowSize)
      }),
      { numRuns: 2000 },
    )
  })

  it('the three cache-slice loads hold them', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, windowSize, residents, page }) => {
        const cfg = configFor(kind, windowSize)
        for (const load of [loadOlderSlice, loadNewerSlice, latestSlice]) {
          const { merged } = load(residents, page, cfg)
          checkTimelineLaws(merged, residents, page, kind, windowSize)
        }
      }),
      { numRuns: 2000 },
    )
  })

  it('appendLive holds them', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, windowSize, residents, incoming, atLiveEdge }) => {
        const cfg = configFor(kind, windowSize)
        const result = appendLive(residents, incoming, atLiveEdge, cfg)
        const merged =
          result.kind === 'appended' || result.kind === 'duplicate-backfilled'
            ? result.messages
            : residents
        checkTimelineLaws(merged, residents, [incoming], kind, windowSize)
      }),
      { numRuns: 2000 },
    )
  })
})

describe('archive merge laws', () => {
  it('refetching the same page reaches the same window', () => {
    // MAM pages are refetched on reconnect, retry and overlapping cursors.
    fc.assert(
      fc.property(scenarioArb, ({ kind, windowSize, residents, page, direction }) => {
        const cfg = configFor(kind, windowSize)
        const once = mergeArchive(residents, page, direction, cfg)
        const twice = mergeArchive(once.merged, page, direction, cfg)
        expect(twice.merged.map(identity)).toEqual(once.merged.map(identity))
      }),
      { numRuns: 2000 },
    )
  })

  it('refetching reports nothing new once the window is not binding', () => {
    // A message the window bound evicted is legitimately "new to the window"
    // again on refetch — the caller still needs it for durable persistence. With
    // no trimming there is no such excuse: the second merge must be a no-op, and
    // hand back the same reference callers use to skip a state write.
    fc.assert(
      fc.property(scenarioArb, ({ kind, residents, page, direction }) => {
        const cfg = configFor(kind, UNBOUNDED)
        const once = mergeArchive(residents, page, direction, cfg)
        const twice = mergeArchive(once.merged, page, direction, cfg)

        expect(twice.newMessages).toEqual([])
        expect(twice.patched).toEqual([])
        expect(twice.merged).toBe(once.merged)
        expect(twice.newestEvicted).toBe(false)
      }),
      { numRuns: 2000 },
    )
  })

  it('two pages converge regardless of arrival order when both fit the window', () => {
    // Within the bound the merge is a set union followed by a sort, so page order
    // cannot matter. Past the bound it legitimately can: a keep-oldest trim
    // between the two merges drops rows the other order would have kept.
    fc.assert(
      fc.property(scenarioArb, ({ kind, residents, page, pageB, direction }) => {
        const cfg = configFor(kind, UNBOUNDED)
        const ab = mergeArchive(mergeArchive(residents, page, direction, cfg).merged, pageB, direction, cfg).merged
        const ba = mergeArchive(mergeArchive(residents, pageB, direction, cfg).merged, page, direction, cfg).merged
        expect(ab.map(identity)).toEqual(ba.map(identity))
      }),
      { numRuns: 2000 },
    )
  })

  it('trims from the end the window is sliding away from', () => {
    // Which end survives the bound is the whole point of the two trims. Load-older
    // must keep the OLDEST, or the batch just fetched is dropped on arrival and
    // scroll-back hits a wall; everything reaching toward the live edge must keep
    // the NEWEST, or the newest message stops being resident.
    fc.assert(
      fc.property(scenarioArb, ({ kind, windowSize, residents, page, direction, isFetchLatest }) => {
        const cfg = configFor(kind, windowSize)
        const union = sortMessagesByTimestamp(normalise([...residents, ...page], kind), kind)
        if (union.length === 0) return

        const keepsOldest = direction === 'backward' && !isFetchLatest
        const { merged } = mergeArchive(residents, page, direction, cfg, isFetchLatest)
        if (merged.length === 0) return

        if (keepsOldest) {
          expect(identity(merged[0])).toBe(identity(union[0]))
        } else {
          expect(identity(merged[merged.length - 1])).toBe(identity(union[union.length - 1]))
        }

        // The cache-slice loads split the same way.
        const older = loadOlderSlice(residents, page, cfg).merged
        if (older.length > 0) expect(identity(older[0])).toBe(identity(union[0]))

        for (const load of [loadNewerSlice, latestSlice]) {
          const reached = load(residents, page, cfg).merged
          if (reached.length > 0) {
            expect(identity(reached[reached.length - 1])).toBe(identity(union[union.length - 1]))
          }
        }
      }),
      { numRuns: 2000 },
    )
  })

  it('reports newestEvicted exactly when the newest resident changed', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, windowSize, residents, page }) => {
        const cfg = configFor(kind, windowSize)
        const before = residents[residents.length - 1]
        const { merged, newestEvicted } = mergeArchive(residents, page, 'backward', cfg)
        const newestRemains = before
          ? merged.some((candidate) => cfg.sameMessage(before, candidate))
          : true
        expect(newestEvicted).toBe(!newestRemains)
        // A forward merge keeps the newest, so it can never slide off the edge.
        expect(mergeArchive(residents, page, 'forward', cfg).newestEvicted).toBe(false)
      }),
      { numRuns: 2000 },
    )
  })
})

describe('appendLive', () => {
  it('never appends away from the live edge', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, windowSize, residents, incoming }) => {
        const cfg = configFor(kind, windowSize)
        expect(appendLive(residents, incoming, false, cfg).kind).not.toBe('appended')
      }),
      { numRuns: 2000 },
    )
  })

  it('never lets a backfill change how many messages are resident', () => {
    // A duplicate donates its archive id; it must not also be inserted.
    fc.assert(
      fc.property(scenarioArb, ({ kind, windowSize, residents, incoming }) => {
        const cfg = configFor(kind, windowSize)
        const result = appendLive(residents, incoming, true, cfg)
        if (result.kind === 'duplicate-backfilled') {
          expect(result.messages).toHaveLength(residents.length)
          expect(result.patched.every((m) => m.stanzaId)).toBe(true)
        }
      }),
      { numRuns: 2000 },
    )
  })

  it('reports live-edge placement exactly when the message landed last', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, windowSize, residents, incoming }) => {
        const cfg = configFor(kind, windowSize)
        const observation: { placement?: 'live-edge' | 'interior' } = {}
        const result = appendLive(residents, incoming, true, cfg, observation)
        if (result.kind !== 'appended' || observation.placement === undefined) return
        const last = result.messages[result.messages.length - 1]
        expect(observation.placement === 'live-edge').toBe(identity(last) === identity(incoming))
      }),
      { numRuns: 2000 },
    )
  })
})
