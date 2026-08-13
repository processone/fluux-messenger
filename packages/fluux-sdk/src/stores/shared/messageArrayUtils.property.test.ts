/**
 * Property tests for the shared message-array primitives.
 *
 * These are the pieces every timeline transition is built from, so their laws
 * are the ones the whole resident window inherits: dedupe removes and never
 * adds, the sort is a total order that does not depend on arrival order, the
 * trims cut from a named end, and the archive-id backfill only ever copies an
 * id that a donor actually carried.
 *
 * Generators force the three situations that break naive implementations —
 * equal timestamps, partially-populated identity fields, and inputs handed in
 * backwards.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  backfillArchiveIds,
  buildMessageKeySet,
  deduplicateMessages,
  isMessageDuplicate,
  mergeAndProcessMessages,
  sortMessagesByTimestamp,
  trimMessages,
  trimMessagesKeepOldest,
} from './messageArrayUtils'
import { compareExact, exactPosition } from './readState'

interface TestMessage {
  id: string
  from: string
  timestamp: Date
  stanzaId?: string
  originId?: string
}

type Kind = 'chat' | 'room'

/**
 * A message's content is fixed by its identity: the same message carries the
 * same timestamp and the same archive ids wherever it appears. Only PRESENCE of
 * those ids varies, which is the real distinction — an outgoing message has no
 * `stanzaId` until its archived copy donates one.
 *
 * Several ids share a millisecond on purpose: equal timestamps are where a sort
 * that forgets its tie-break stops being a total order.
 */
const TIMESTAMP_BY_ID = { m1: 0, m2: 0, m3: 0, m4: 1, m5: 1, m6: 2 } as const
const IDS = Object.keys(TIMESTAMP_BY_ID) as (keyof typeof TIMESTAMP_BY_ID)[]
const FROMS = ['a@s', 'b@s'] as const
/** In a chat the cache keyPath is `id` alone, so `from` cannot vary per id. */
const FROM_BY_ID = { m1: 'a@s', m2: 'b@s', m3: 'a@s', m4: 'b@s', m5: 'a@s', m6: 'b@s' } as const

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

const getKeys = (m: TestMessage): string[] => {
  const keys: string[] = []
  if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
  if (m.originId) keys.push(`originId:${m.originId}`)
  keys.push(`from:${m.from}:id:${m.id}`)
  return keys
}
const getKey = (m: TestMessage): string => `from:${m.from}:id:${m.id}`
const identity = getKey

const uniqueByIdentity = (ms: TestMessage[]): TestMessage[] => {
  const seen = new Set<string>()
  return ms.filter((m) => (seen.has(identity(m)) ? false : (seen.add(identity(m)), true)))
}

/** Arrays are sets of distinct messages, as every real page and cache slice is. */
const listArbFor = (kind: Kind, maxLength = 6) =>
  fc.array(messageArbFor(kind), { maxLength }).map(uniqueByIdentity)

const kindArb = fc.constantFrom<Kind>('chat', 'room')

/** A scenario draws its kind once — chat and room break ties differently. */
const scenarioArb = kindArb.chain((kind) =>
  fc.record({
    kind: fc.constant(kind),
    existing: listArbFor(kind),
    incoming: listArbFor(kind),
    maxCount: fc.integer({ min: 0, max: 8 }),
  }),
)

const sortedIds = (ms: TestMessage[], kind: Kind) =>
  sortMessagesByTimestamp(ms, kind).map(identity)

describe('deduplicateMessages', () => {
  it('removes only, and never adds or reorders', () => {
    fc.assert(
      fc.property(scenarioArb, ({ existing, incoming }) => {
        const result = deduplicateMessages(existing, incoming, getKey)
        // A subsequence of incoming: nothing invented, nothing reordered.
        expect(result).toEqual(incoming.filter((m) => result.includes(m)))
        for (const m of result) expect(incoming).toContain(m)
      }),
      { numRuns: 3000 },
    )
  })

  it('leaves nothing that collides with the existing set', () => {
    fc.assert(
      fc.property(scenarioArb, ({ existing, incoming }) => {
        const keys = new Set(existing.map(getKey))
        for (const m of deduplicateMessages(existing, incoming, getKey)) {
          expect(keys.has(getKey(m))).toBe(false)
        }
      }),
      { numRuns: 3000 },
    )
  })

  it('is idempotent', () => {
    fc.assert(
      fc.property(scenarioArb, ({ existing, incoming }) => {
        const once = deduplicateMessages(existing, incoming, getKey)
        expect(deduplicateMessages(existing, once, getKey)).toEqual(once)
      }),
      { numRuns: 3000 },
    )
  })

  it('agrees with the multi-key form on the keys they share', () => {
    fc.assert(
      fc.property(scenarioArb, ({ existing, incoming }) => {
        const keySet = buildMessageKeySet(existing, getKeys)
        for (const m of incoming) {
          // A single-key duplicate is necessarily a multi-key duplicate: the
          // single key is one of the multi keys.
          if (existing.some((e) => getKey(e) === getKey(m))) {
            expect(isMessageDuplicate(m, keySet, getKeys)).toBe(true)
          }
        }
      }),
      { numRuns: 3000 },
    )
  })
})

describe('sortMessagesByTimestamp', () => {
  it('is a permutation of its input and never mutates it', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, existing }) => {
        const snapshot = [...existing]
        const sorted = sortMessagesByTimestamp(existing, kind)
        expect(existing).toEqual(snapshot) // pure
        // Compare as multisets of identities: a default `.sort()` on objects
        // stringifies every element to "[object Object]" and compares nothing.
        expect(sorted.map(identity).sort()).toEqual(existing.map(identity).sort())
        expect(sorted).toHaveLength(existing.length)
      }),
      { numRuns: 3000 },
    )
  })

  it('produces a chain that is ordered under compareExact', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, existing }) => {
        const sorted = sortMessagesByTimestamp(existing, kind)
        for (let i = 1; i < sorted.length; i++) {
          const cmp = compareExact(exactPosition(sorted[i - 1], kind), exactPosition(sorted[i], kind))
          expect(cmp).toBeLessThanOrEqual(0)
        }
      }),
      { numRuns: 3000 },
    )
  })

  it('does not depend on the order it was handed', () => {
    // The total-order claim, and the one that matters: a resident array built by
    // appending, by prepending or by a cache slice must reach the same order.
    fc.assert(
      fc.property(
        kindArb.chain((kind) =>
          listArbFor(kind).chain((ms) =>
            fc.tuple(
              fc.constant(kind),
              fc.constant(ms),
              fc.shuffledSubarray(ms, { minLength: ms.length, maxLength: ms.length }),
            ),
          ),
        ),
        ([kind, ms, shuffled]) => {
          expect(sortedIds(shuffled, kind)).toEqual(sortedIds(ms, kind))
          expect(sortedIds([...ms].reverse(), kind)).toEqual(sortedIds(ms, kind))
        },
      ),
      { numRuns: 3000 },
    )
  })

  it('is idempotent', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, existing }) => {
        const once = sortMessagesByTimestamp(existing, kind)
        expect(sortMessagesByTimestamp(once, kind)).toEqual(once)
      }),
      { numRuns: 3000 },
    )
  })
})

describe('the two trims', () => {
  it('keep exactly the newest / oldest N, as a contiguous run', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, existing, maxCount }) => {
        const sorted = sortMessagesByTimestamp(existing, kind)

        const newest = trimMessages(sorted, maxCount)
        expect(newest).toEqual(sorted.slice(Math.max(0, sorted.length - maxCount)))
        expect(newest).toHaveLength(Math.min(maxCount, sorted.length))

        const oldest = trimMessagesKeepOldest(sorted, maxCount)
        expect(oldest).toEqual(sorted.slice(0, maxCount))
        expect(oldest).toHaveLength(Math.min(maxCount, sorted.length))
      }),
      { numRuns: 3000 },
    )
  })

  it('cut from opposite ends, and agree only when nothing is cut', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, existing, maxCount }) => {
        const sorted = sortMessagesByTimestamp(existing, kind)
        if (maxCount <= 0) return
        const newest = trimMessages(sorted, maxCount)
        const oldest = trimMessagesKeepOldest(sorted, maxCount)
        if (sorted.length <= maxCount) {
          expect(newest).toEqual(oldest)
          return
        }
        expect(newest[newest.length - 1]).toBe(sorted[sorted.length - 1])
        expect(oldest[0]).toBe(sorted[0])
      }),
      { numRuns: 3000 },
    )
  })

  it('are idempotent and never grow an array', () => {
    fc.assert(
      fc.property(scenarioArb, ({ existing, maxCount }) => {
        for (const trim of [trimMessages, trimMessagesKeepOldest]) {
          const once = trim(existing, maxCount)
          expect(once.length).toBeLessThanOrEqual(existing.length)
          expect(trim(once, maxCount)).toEqual(once)
        }
      }),
      { numRuns: 3000 },
    )
  })
})

describe('backfillArchiveIds', () => {
  it('never invents an id: every patched value came from a donor', () => {
    fc.assert(
      fc.property(scenarioArb, ({ existing, incoming }) => {
        const donorStanzaIds = new Set(incoming.map((m) => m.stanzaId).filter(Boolean))
        const donorOriginIds = new Set(incoming.map((m) => m.originId).filter(Boolean))
        const { patched } = backfillArchiveIds(existing, incoming, getKeys)

        for (const m of patched) {
          expect(donorStanzaIds.has(m.stanzaId)).toBe(true)
          if (m.originId) {
            const before = existing.find((e) => identity(e) === identity(m))!
            // Either it already had one, or a donor supplied it.
            expect(before.originId === m.originId || donorOriginIds.has(m.originId)).toBe(true)
          }
        }
      }),
      { numRuns: 3000 },
    )
  })

  it('only ever fills a gap: an existing archive id is never overwritten', () => {
    fc.assert(
      fc.property(scenarioArb, ({ existing, incoming }) => {
        const { messages, patched } = backfillArchiveIds(existing, incoming, getKeys)
        const patchedIds = new Set(patched.map(identity))

        for (let i = 0; i < existing.length; i++) {
          const before = existing[i]
          const after = messages[i]
          // Position and identity are preserved row by row.
          expect(identity(after)).toBe(identity(before))
          if (before.stanzaId) expect(after).toBe(before) // untouched by reference
          if (patchedIds.has(identity(before))) expect(before.stanzaId).toBeUndefined()
          // Nothing but the two id fields can move.
          expect(after.timestamp).toBe(before.timestamp)
          expect(after.id).toBe(before.id)
          expect(after.from).toBe(before.from)
        }
      }),
      { numRuns: 3000 },
    )
  })

  it('is copy-on-write, pure, and idempotent', () => {
    fc.assert(
      fc.property(scenarioArb, ({ existing, incoming }) => {
        const snapshot = existing.map((m) => ({ ...m }))
        const first = backfillArchiveIds(existing, incoming, getKeys)
        expect(existing).toEqual(snapshot) // inputs untouched
        expect(first.messages === existing).toBe(first.patched.length === 0)

        // Re-donating the same page has nothing left to give.
        const second = backfillArchiveIds(first.messages, incoming, getKeys)
        expect(second.patched).toEqual([])
        expect(second.messages).toBe(first.messages)
      }),
      { numRuns: 3000 },
    )
  })
})

describe('mergeAndProcessMessages', () => {
  it('keeps every resident message and adds only non-duplicates', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, existing, incoming }) => {
        const { merged, newMessages } = mergeAndProcessMessages(existing, incoming, getKeys, kind)
        const mergedIds = merged.map(identity)

        for (const m of existing) expect(mergedIds).toContain(identity(m))
        for (const m of newMessages) expect(mergedIds).toContain(identity(m))
        expect(merged).toHaveLength(existing.length + newMessages.length)
        expect(mergedIds).toEqual(sortedIds(merged, kind))
      }),
      { numRuns: 3000 },
    )
  })

  it('is idempotent when the window does not bind', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, existing, incoming }) => {
        const once = mergeAndProcessMessages(existing, incoming, getKeys, kind)
        const twice = mergeAndProcessMessages(once.merged, incoming, getKeys, kind)
        expect(twice.newMessages).toEqual([])
        expect(twice.merged.map(identity)).toEqual(once.merged.map(identity))
      }),
      { numRuns: 3000 },
    )
  })

  it('keeps the newest when a maxCount binds', () => {
    fc.assert(
      fc.property(scenarioArb, ({ kind, existing, incoming, maxCount }) => {
        const { merged } = mergeAndProcessMessages(existing, incoming, getKeys, kind, maxCount)
        const unbounded = mergeAndProcessMessages(existing, incoming, getKeys, kind).merged
        expect(merged).toEqual(unbounded.slice(Math.max(0, unbounded.length - maxCount)))
      }),
      { numRuns: 3000 },
    )
  })
})
