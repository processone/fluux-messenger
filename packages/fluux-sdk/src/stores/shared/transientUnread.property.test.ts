/**
 * Property tests for the transient unread overlay.
 *
 * The overlay holds `noLocalStore` messages that have no archive row to scan
 * but must still count as unread. It stores each logical message ONCE under its
 * canonical key while indexing it under every alias tier it carries, so the
 * interesting behaviour is not identity — that is `roomMessageIdentity`'s job
 * and is pinned there — but what the two structures do to each other as copies
 * arrive in arbitrary order.
 *
 * The properties are deliberately OBSERVATIONAL. The overlay groups entries by
 * ALIAS OVERLAP, not by logical identity, so a test model that predicted the
 * grouping would be a second copy of the algorithm and would agree with it even
 * when both are wrong. Everything below is instead phrased in terms the caller
 * can see: the count, what a removal does, and what the two result flags
 * promise about the count the caller is maintaining incrementally.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  _clearAllTransientForTesting,
  clearTransientScope,
  noteTransient,
  pruneTransient,
  removeTransient,
  transientAliases,
  transientCounts,
  transientIdentity,
  type ScopeKey,
} from './transientUnread'
import { exactPosition, type PointerOrder } from './readState'

const ACCOUNTS = ['acct-1', 'acct-2'] as const
const ENTITIES = ['room-a@conf', 'room-b@conf'] as const
const NICKS = ['alice', 'bob'] as const
const MSG_IDS = ['c1', 'c2', 'c3'] as const
const TIMESTAMPS = [0, 1, 2] as const

/** One event in a room. Every stanza the client sees is a projection of it. */
interface LogicalMessage {
  entityId: string
  nick: string
  id: string
  ts: number
}

const logicalArb: fc.Arbitrary<LogicalMessage> = fc.record({
  entityId: fc.constantFrom(...ENTITIES),
  nick: fc.constantFrom(...NICKS),
  id: fc.constantFrom(...MSG_IDS),
  ts: fc.constantFrom(...TIMESTAMPS),
})

const logicalKey = (m: LogicalMessage) => `${m.entityId}|${m.nick}|${m.id}`

/**
 * The three shapes, and the reason the coalesce path is reachable at all.
 *
 * An optimistic `echo` still carries the sender's own JID as `from` and has no
 * server stanza-id, so it shares NO alias with a `mam` copy, which carries the
 * stanza-id and the room-scoped `from` but may have lost the origin-id. Noted
 * alone they are two entries. A `reflection` carries both high tiers and is what
 * bridges them into one.
 */
type Shape = 'echo' | 'reflection' | 'mam'
const SHAPES: Shape[] = ['echo', 'reflection', 'mam']

const stanzaIdOf = (m: LogicalMessage) => `srv-${logicalKey(m)}`
const originIdOf = (m: LogicalMessage) => `cli-${logicalKey(m)}`

function copyOf(m: LogicalMessage, shape: Shape) {
  const roomJid = m.entityId
  // The echo has not been reflected yet, so it still carries the local from.
  const from = shape === 'echo' ? `self@example/res` : `${roomJid}/${m.nick}`
  const fields = {
    roomJid,
    from,
    id: m.id,
    stanzaId: shape === 'echo' ? undefined : stanzaIdOf(m),
    originId: shape === 'mam' ? undefined : originIdOf(m),
  }
  return {
    identity: transientIdentity(fields, 'room'),
    aliases: transientAliases(fields, 'room'),
    position: exactPosition({ id: m.id, from, timestamp: new Date(m.ts) }, 'room'),
  }
}

const scopeFor = (accountScope: string, entityId: string): ScopeKey => ({
  accountScope,
  kind: 'room',
  entityId,
})

const countAll = (scope: ScopeKey) => transientCounts(scope, undefined).unread

const boundaryArb: fc.Arbitrary<PointerOrder> = fc
  .constantFrom(...TIMESTAMPS)
  .map((ts) => ({ role: 'floor', timestamp: ts }) as PointerOrder)

describe('transient overlay', () => {
  beforeEach(() => {
    // Module-level state, outside any store: it survives everything else.
    _clearAllTransientForTesting()
  })

  it('collapses to one entry exactly when a copy bridges the tiers', () => {
    // Grouping is by ALIAS OVERLAP, not by logical identity. `echo` and `mam`
    // share nothing, so noted alone they are legitimately two entries; a
    // `reflection` carries both high tiers and coalesces them. Anything else
    // would mean the overlay either double-counts a message or merges two.
    fc.assert(
      fc.property(logicalArb, fc.array(fc.constantFrom(...SHAPES), { minLength: 1, maxLength: 6 }), (m, shapes) => {
        _clearAllTransientForTesting()
        const scope = scopeFor(ACCOUNTS[0], m.entityId)
        for (const shape of shapes) {
          const c = copyOf(m, shape)
          noteTransient(scope, { position: c.position }, c.identity, c.aliases)
        }

        const present = new Set(shapes)
        const expected = present.has('reflection')
          ? 1
          : Number(present.has('echo')) + Number(present.has('mam'))
        expect(countAll(scope)).toBe(expected)
      }),
      { numRuns: 3000 },
    )
  })

  it('converges to the same count whatever order the copies arrive in', () => {
    // The coalesce path is order-dependent by construction: two copies noted
    // separately become two entries until a third bridges them. The end state
    // must not depend on which order that happened in.
    fc.assert(
      fc.property(
        logicalArb,
        fc.array(fc.constantFrom(...SHAPES), { minLength: 2, maxLength: 5 }).chain((shapes) =>
          fc.tuple(
            fc.constant(shapes),
            fc.shuffledSubarray(shapes, { minLength: shapes.length, maxLength: shapes.length }),
          ),
        ),
        (m, [order, shuffled]) => {
          const run = (seq: Shape[]) => {
            _clearAllTransientForTesting()
            const scope = scopeFor(ACCOUNTS[0], m.entityId)
            for (const shape of seq) {
              const c = copyOf(m, shape)
              noteTransient(scope, { position: c.position }, c.identity, c.aliases)
            }
            return countAll(scope)
          }
          expect(run(shuffled)).toBe(run(order))
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('never leaves the caller with a stale incremental count', () => {
    // The two flags ARE the caller's contract: `added` drives a `+1`, and
    // `requiresRecount` drives a scheduled recount. A change in the true count
    // that raises neither flag would leave the badge silently wrong.
    fc.assert(
      fc.property(
        fc.array(fc.tuple(logicalArb, fc.constantFrom(...SHAPES)), { maxLength: 10 }),
        (notes) => {
          _clearAllTransientForTesting()
          for (const [m, shape] of notes) {
            const scope = scopeFor(ACCOUNTS[0], m.entityId)
            const before = countAll(scope)
            const c = copyOf(m, shape)
            const { added, requiresRecount } = noteTransient(scope, { position: c.position }, c.identity, c.aliases)
            const after = countAll(scope)

            if (added) expect(after).toBe(before + 1)
            if (after !== before) expect(added || requiresRecount).toBe(true)
            // A coalesce is the only way the count goes DOWN on a note.
            if (after < before) expect(requiresRecount).toBe(true)
          }
        },
      ),
      { numRuns: 3000 },
    )
  })

  it('removes an entry through any alias tier it is known under', () => {
    // A retraction may reference only the stanza-id while the entry is stored
    // under a different canonical key.
    fc.assert(
      fc.property(logicalArb, fc.constantFrom(...SHAPES), fc.nat(3), (m, shape, pick) => {
        _clearAllTransientForTesting()
        const scope = scopeFor(ACCOUNTS[0], m.entityId)
        const c = copyOf(m, shape)
        noteTransient(scope, { position: c.position }, c.identity, c.aliases)
        expect(countAll(scope)).toBe(1)

        const alias = c.aliases[pick % c.aliases.length]
        expect(removeTransient(scope, alias)).toEqual({ removed: true })
        expect(countAll(scope)).toBe(0)
        // Every other alias is gone with it — no orphan left pointing at nothing.
        for (const a of c.aliases) expect(removeTransient(scope, a)).toEqual({ removed: false })
      }),
      { numRuns: 3000 },
    )
  })

  it('prunes exactly what the boundary already excluded from the count', () => {
    // Model-free statement of the module's own claim that pruning is a memory
    // bound, not a correctness mechanism: counting past a boundary, then pruning
    // at it and counting everything, must agree.
    fc.assert(
      fc.property(
        fc.array(fc.tuple(logicalArb, fc.constantFrom(...SHAPES)), { maxLength: 8 }),
        boundaryArb,
        (notes, boundary) => {
          _clearAllTransientForTesting()
          const scope = scopeFor(ACCOUNTS[0], ENTITIES[0])
          for (const [m, shape] of notes) {
            const c = copyOf({ ...m, entityId: ENTITIES[0] }, shape)
            noteTransient(scope, { position: c.position }, c.identity, c.aliases)
          }

          const pastBoundary = transientCounts(scope, boundary).unread
          const total = countAll(scope)
          const { removed } = pruneTransient(scope, boundary)

          expect(removed).toBe(total - pastBoundary)
          expect(countAll(scope)).toBe(pastBoundary)
          // And pruning again at the same boundary has nothing left to take.
          expect(pruneTransient(scope, boundary)).toEqual({ removed: 0 })
        },
      ),
      { numRuns: 3000 },
    )
  })

  it('keeps the earliest position when a copy is re-noted', () => {
    // A copy can be re-noted with a position no boundary comparison has seen
    // yet; adopting the earlier one is what keeps it counted rather than letting
    // it slip below the read boundary.
    //
    // The floor sits at the LATER of the two timestamps, which is what makes the
    // assertion able to tell the two retentions apart: `isAfterBoundary` counts a
    // floor's own millisecond, so a floor at the EARLIER one counts either way.
    fc.assert(
      fc.property(logicalArb, fc.constantFrom(...TIMESTAMPS), fc.constantFrom(...TIMESTAMPS), (m, t1, t2) => {
        _clearAllTransientForTesting()
        const scope = scopeFor(ACCOUNTS[0], m.entityId)
        for (const ts of [t1, t2]) {
          const c = copyOf({ ...m, ts }, 'reflection')
          noteTransient(scope, { position: c.position }, c.identity, c.aliases)
        }
        const floor: PointerOrder = { role: 'floor', timestamp: Math.max(t1, t2) }
        // Retained is the earlier one, so it sits strictly before the floor and
        // is not counted — unless both notes shared a millisecond.
        expect(transientCounts(scope, floor).unread).toBe(t1 === t2 ? 1 : 0)
      }),
      { numRuns: 3000 },
    )
  })

  it('keeps the earliest position across everything a coalesce absorbs', () => {
    // The survivor must inherit the earliest position of the entries it swallows
    // AND of the copy that bridged them, or a message the reader has not reached
    // stops being counted.
    fc.assert(
      fc.property(
        logicalArb,
        fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
        (m, [tEcho, tMam, tReflect]) => {
          _clearAllTransientForTesting()
          const scope = scopeFor(ACCOUNTS[0], m.entityId)
          // Two disjoint entries first, then the copy that bridges them.
          for (const [shape, ts] of [['echo', tEcho], ['mam', tMam], ['reflection', tReflect]] as const) {
            const c = copyOf({ ...m, ts }, shape)
            noteTransient(scope, { position: c.position }, c.identity, c.aliases)
          }
          expect(countAll(scope)).toBe(1)

          const floor: PointerOrder = { role: 'floor', timestamp: Math.max(tEcho, tMam, tReflect) }
          // The three timestamps are distinct, so the retained earliest one is
          // strictly before the floor.
          expect(transientCounts(scope, floor).unread).toBe(0)
        },
      ),
      { numRuns: 3000 },
    )
  })
})

describe('scope isolation', () => {
  beforeEach(() => _clearAllTransientForTesting())

  it('never lets one scope change another scope’s count', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(...ACCOUNTS), logicalArb, fc.constantFrom(...SHAPES)), { maxLength: 10 }),
        (notes) => {
          _clearAllTransientForTesting()
          const seen = new Set<string>()
          for (const [account, m, shape] of notes) {
            const scope = scopeFor(account, m.entityId)
            const others = [...seen]
              .map((k) => JSON.parse(k) as ScopeKey)
              .filter((s) => s.accountScope !== account || s.entityId !== m.entityId)
            const before = others.map((s) => countAll(s))

            const c = copyOf(m, shape)
            noteTransient(scope, { position: c.position }, c.identity, c.aliases)

            expect(others.map((s) => countAll(s))).toEqual(before)
            seen.add(JSON.stringify(scope))
          }
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('clears one account without touching the other', () => {
    fc.assert(
      fc.property(logicalArb, fc.constantFrom(...SHAPES), (m, shape) => {
        _clearAllTransientForTesting()
        const c = copyOf(m, shape)
        for (const account of ACCOUNTS) {
          const scope = scopeFor(account, m.entityId)
          noteTransient(scope, { position: c.position }, c.identity, c.aliases)
        }
        expect(countAll(scopeFor(ACCOUNTS[0], m.entityId))).toBe(1)
        expect(countAll(scopeFor(ACCOUNTS[1], m.entityId))).toBe(1)

        clearTransientScope(ACCOUNTS[0])
        expect(countAll(scopeFor(ACCOUNTS[0], m.entityId))).toBe(0)
        expect(countAll(scopeFor(ACCOUNTS[1], m.entityId))).toBe(1)
      }),
      { numRuns: 2000 },
    )
  })

  it('reports zero for a scope that was never noted', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ACCOUNTS), fc.constantFrom(...ENTITIES), boundaryArb, (a, e, boundary) => {
        _clearAllTransientForTesting()
        const scope = scopeFor(a, e)
        expect(transientCounts(scope, boundary).unread).toBe(0)
        expect(pruneTransient(scope, boundary)).toEqual({ removed: 0 })
        expect(removeTransient(scope, 'anything')).toEqual({ removed: false })
      }),
      { numRuns: 2000 },
    )
  })
})
