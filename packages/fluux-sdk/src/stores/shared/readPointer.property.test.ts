/**
 * Property tests for read-pointer ordering and advancement.
 *
 * The oracles are order theory and the module's own documented rules, not the
 * implementation. `compareExact` claims to be a total order; `mayAdvanceTo`
 * claims to be a safe forward-only test with the opposite floor rule to
 * `isAfterBoundary` (#1173). Those are laws, and laws are what properties check.
 *
 * Generators draw timestamps and ids from deliberately tiny pools. Everything
 * interesting here happens inside a shared millisecond: with random 64-bit
 * timestamps a tie would essentially never be generated, and the tie-break and
 * floor rules — the entire subject — would go untested.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  advance,
  isAhead,
  makeReadPointer,
  serializeReadPointer,
  deserializeReadPointer,
  withArchiveId,
} from './readPointer'
import { compareExact, exactPosition, isAfterBoundary, mayAdvanceTo } from './readState'
import type { ExactPosition, PointerOrder } from '../../core/types/readState'
import type { ReadPointer } from '../../core/types/readState'

const TIMESTAMPS = [0, 1, 2] as const
const IDS = ['a', 'b', 'c'] as const
const FROMS = ['x@s', 'y@s'] as const
/**
 * `undefined` is in the pool on purpose: a pre-XEP-0421 room, and every row and
 * pointer written before the occupant rung existed, supply none. Mixing it with
 * known ids is what makes the laws below cover the pair where only ONE side
 * knows its occupant — the pair a convention, not a fact, has to order.
 */
const OCCUPANTS = [undefined, 'o1', 'o2'] as const

type Kind = 'chat' | 'room'

/**
 * `kind` is a property of the ENTITY, not of a position: a conversation is a 1:1
 * chat or a MUC room and never both, and the tie-break rules differ between them
 * on purpose. So every position compared in one property must share one kind —
 * drawing it per position manufactures a comparison the codebase cannot make and
 * reports it as a broken total order.
 */
const exactArbFor = (kind: Kind): fc.Arbitrary<ExactPosition> =>
  fc
    .record({
      timestamp: fc.constantFrom(...TIMESTAMPS),
      id: fc.constantFrom(...IDS),
      from: fc.constantFrom(...FROMS),
      occupantId: fc.constantFrom(...OCCUPANTS),
    })
    .map(({ timestamp, id, from, occupantId }) =>
      exactPosition({ id, from, occupantId, timestamp: new Date(timestamp) }, kind),
    )

const floorArb: fc.Arbitrary<PointerOrder> = fc
  .constantFrom(...TIMESTAMPS)
  .map((timestamp) => ({ role: 'floor', timestamp }) as PointerOrder)

const orderArbFor = (kind: Kind): fc.Arbitrary<PointerOrder> =>
  fc.oneof({ weight: 3, arbitrary: exactArbFor(kind) }, { weight: 1, arbitrary: floorArb })

const pointerArbFor = (kind: Kind): fc.Arbitrary<ReadPointer> =>
  fc
    .record({
      timestamp: fc.constantFrom(...TIMESTAMPS),
      id: fc.constantFrom(...IDS),
      from: fc.constantFrom(...FROMS),
      occupantId: fc.constantFrom(...OCCUPANTS),
      stanzaId: fc.option(fc.constantFrom('s1', 's2'), { nil: undefined }),
    })
    .map(({ timestamp, id, from, occupantId, stanzaId }) =>
      makeReadPointer({ id, from, occupantId, timestamp: new Date(timestamp), stanzaId }, kind),
    )

/** A pointer carrying a floor order, as the #1081 legacy migration produces. */
const floorPointerArb: fc.Arbitrary<ReadPointer> = fc
  .record({ timestamp: fc.constantFrom(...TIMESTAMPS), id: fc.constantFrom(...IDS) })
  .map(({ timestamp, id }) => ({
    order: { role: 'floor', timestamp },
    identity: { state: 'local', messageId: id },
  }))

const anyPointerArbFor = (kind: Kind) =>
  fc.oneof({ weight: 3, arbitrary: pointerArbFor(kind) }, { weight: 1, arbitrary: floorPointerArb })

/** Draw a kind once, then n values of one arbitrary built from it. */
const perKind = <T,>(build: (kind: Kind) => fc.Arbitrary<T>, n: number): fc.Arbitrary<T[]> =>
  fc.constantFrom<Kind>('chat', 'room').chain((kind) => fc.array(build(kind), { minLength: n, maxLength: n }))

/** `-0` and `0` are distinct under Object.is, which `toBe` uses. */
const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0)

describe('compareExact (properties)', () => {
  it('is irreflexive on equal positions and antisymmetric', () => {
    fc.assert(
      fc.property(perKind(exactArbFor, 2), ([a, b]) => {
        expect(compareExact(a, a)).toBe(0)
        expect(sign(compareExact(a, b))).toBe(sign(-compareExact(b, a)))
      }),
    )
  })

  it('is transitive', () => {
    fc.assert(
      fc.property(perKind(exactArbFor, 3), ([a, b, c]) => {
        if (compareExact(a, b) < 0 && compareExact(b, c) < 0) {
          expect(compareExact(a, c)).toBeLessThan(0)
        }
      }),
      { numRuns: 3000 },
    )
  })

  it('reports equality only for positions that are genuinely the same place', () => {
    fc.assert(
      fc.property(perKind(exactArbFor, 2), ([a, b]) => {
        if (compareExact(a, b) !== 0) return
        expect(a.timestamp).toBe(b.timestamp)
        // Same millisecond and an unbreakable tie means the same cache row.
        expect(a.tiebreak).toEqual(b.tiebreak)
      }),
      { numRuns: 3000 },
    )
  })
})

describe('mayAdvanceTo (properties)', () => {
  it('is a strict order: irreflexive, asymmetric, transitive', () => {
    fc.assert(
      fc.property(perKind(orderArbFor, 3), ([a, b, c]) => {
        // Forward-only means a pointer may never advance to where it already is.
        expect(mayAdvanceTo(a, a)).toBe(false)
        expect(mayAdvanceTo(a, b) && mayAdvanceTo(b, a)).toBe(false)
        if (mayAdvanceTo(a, b) && mayAdvanceTo(b, c)) {
          expect(mayAdvanceTo(a, c)).toBe(true)
        }
      }),
      { numRuns: 5000 },
    )
  })

  it('never advances past a floor inside its own millisecond', () => {
    // The documented safe direction: with a floor on either side, only a strictly
    // later millisecond may advance. A position given away here is unrecoverable.
    fc.assert(
      fc.property(perKind(orderArbFor, 2), ([a, b]) => {
        const involvesFloor = a.role === 'floor' || b.role === 'floor'
        if (involvesFloor && a.timestamp === b.timestamp) {
          expect(mayAdvanceTo(a, b)).toBe(false)
          expect(mayAdvanceTo(b, a)).toBe(false)
        }
      }),
    )
  })

  it('is the exact inverse of isAfterBoundary on a shared millisecond (#1173)', () => {
    // isAfterBoundary over-counts on a floor (recoverable); mayAdvanceTo refuses
    // (also recoverable). The two rules must stay opposite, or one call site
    // silently gets the other question's answer.
    fc.assert(
      fc.property(perKind(exactArbFor, 1), fc.constantFrom(...TIMESTAMPS), ([row], ts) => {
        const floor: PointerOrder = { role: 'floor', timestamp: ts }
        if (row.timestamp !== ts) return
        expect(isAfterBoundary(row, floor)).toBe(true) // at-or-after: counts
        expect(mayAdvanceTo(row, floor)).toBe(false) // strict: refuses
      }),
    )
  })
})

describe('advance (properties)', () => {
  it('is forward-only and never invents a position', () => {
    fc.assert(
      fc.property(perKind(anyPointerArbFor, 2), ([current, candidate]) => {
        const next = advance(current, candidate)
        // The result is always one of the two inputs.
        expect(next === current || next === candidate).toBe(true)
        // And never lands behind where the pointer already was.
        expect(mayAdvanceTo(current.order, next.order)).toBe(false)
      }),
    )
  })

  it('is idempotent', () => {
    fc.assert(
      fc.property(perKind(anyPointerArbFor, 2), ([current, candidate]) => {
        const once = advance(current, candidate)
        expect(advance(once, candidate)).toBe(once)
      }),
    )
  })

  it('follows isAhead except on the documented floor tie', () => {
    // advance is the join, isAhead is the strict order. They agree everywhere
    // except where the order is partial: a floor and an exact in one millisecond.
    fc.assert(
      fc.property(perKind(anyPointerArbFor, 2), ([current, candidate]) => {
        const tie =
          candidate.order.role === 'floor' &&
          current.order.role === 'exact' &&
          candidate.order.timestamp === current.order.timestamp
        expect(advance(current, candidate)).toBe(
          isAhead(candidate, current) || tie ? candidate : current,
        )
      }),
    )
  })

  it('converges regardless of arrival order when every position is exact', () => {
    // Two clients receiving the same MDS updates in different orders must reach
    // the same pointer. This holds for exact positions because mayAdvanceTo is a
    // total order over them, so the fold is a genuine maximum.
    fc.assert(
      fc.property(
        fc.constantFrom<Kind>('chat', 'room').chain((k) => fc.array(pointerArbFor(k), { minLength: 2, maxLength: 6 })).chain((xs) =>
          fc.tuple(fc.constant(xs), fc.shuffledSubarray(xs, { minLength: xs.length, maxLength: xs.length })),
        ),
        ([xs, shuffled]) => {
          const fold = (ps: ReadPointer[]) => ps.reduce<ReadPointer | undefined>(
            (acc, p) => (acc ? advance(acc, p) : p),
            undefined,
          )
          expect(fold(xs)!.order).toEqual(fold(shuffled)!.order)
        },
      ),
      { numRuns: 3000 },
    )
  })

  it('converges regardless of arrival order once a floor pointer is involved', () => {
    // The property the join exists for, and the one that failed before the tie
    // rule: a #1081 migrated floor and an exact position sharing a millisecond
    // are incomparable, so "keep what arrived first" made the fold depend on
    // arrival order.
    fc.assert(
      fc.property(
        fc
          .constantFrom<Kind>('chat', 'room')
          .chain((k) => fc.array(anyPointerArbFor(k), { minLength: 2, maxLength: 6 }))
          .chain((xs) =>
            fc.tuple(fc.constant(xs), fc.shuffledSubarray(xs, { minLength: xs.length, maxLength: xs.length })),
          ),
        ([xs, shuffled]) => {
          const fold = (ps: ReadPointer[]) =>
            ps.reduce<ReadPointer | undefined>((acc, p) => (acc ? advance(acc, p) : p), undefined)
          expect(fold(xs)!.order).toEqual(fold(shuffled)!.order)
        },
      ),
      { numRuns: 3000 },
    )
  })

  it('resolves a floor/exact tie toward the floor, and over-counts rather than under', () => {
    // Pins the DIRECTION of the tie rule, not merely that one exists. Both
    // arrival orders now land on the floor, and the floor is the over-counting
    // side: it counts the whole shared millisecond as unread, which a read
    // clears. The exact side would report fewer unread than were proven read,
    // and the pointer is forward-only, so that loss cannot be undone.
    const floor: ReadPointer = {
      order: { role: 'floor', timestamp: 2 },
      identity: { state: 'local', messageId: 'a' },
    }
    const exact: ReadPointer = {
      order: exactPosition({ id: 'a', timestamp: new Date(2) }, 'chat'),
      identity: { state: 'local', messageId: 'a' },
    }
    const fold = (ps: ReadPointer[]) =>
      ps.reduce<ReadPointer | undefined>((acc, p) => (acc ? advance(acc, p) : p), undefined)!

    expect(fold([floor, exact]).order).toEqual(floor.order)
    expect(fold([exact, floor]).order).toEqual(floor.order)

    // Same badge either way, and it is the over-counting one.
    const sameMillisecond = ['a', 'b', 'c'].map((id) =>
      exactPosition({ id, timestamp: new Date(2) }, 'chat'),
    )
    const unread = (p: ReadPointer) =>
      sameMillisecond.filter((row) => isAfterBoundary(row, p.order)).length
    expect(unread(fold([floor, exact]))).toBe(3)
    expect(unread(fold([exact, floor]))).toBe(3)
  })
})

describe('pointer identity and persistence (properties)', () => {
  it('keeps the tie-break id and the identity message id in step', () => {
    // serializeReadPointer drops tiebreak.id and deserialize rebuilds it from
    // identity.messageId. A pointer whose two ids disagree would silently change
    // order across a save/load, so makeReadPointer must never produce one.
    fc.assert(
      fc.property(perKind(pointerArbFor, 1), ([p]) => {
        if (p.order.role !== 'exact') return
        expect(p.order.tiebreak.id).toBe(p.identity.messageId)
      }),
    )
  })

  it('round-trips through serialisation without moving', () => {
    fc.assert(
      fc.property(perKind(anyPointerArbFor, 1), ([p]) => {
        const back = deserializeReadPointer(JSON.parse(JSON.stringify(serializeReadPointer(p))))
        expect(back).toBeDefined()
        expect(back!.order).toEqual(p.order)
        expect(back!.identity).toEqual(p.identity)
      }),
    )
  })

  it('never throws and never invents a pointer from hostile input', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(() => deserializeReadPointer(raw)).not.toThrow()
      }),
    )
  })

  it('withArchiveId only ever upgrades the name, never the position', () => {
    fc.assert(
      fc.property(perKind(anyPointerArbFor, 1), fc.constantFrom('', 'arch-1', 'arch-2'), ([p], archiveId) => {
        const next = withArchiveId(p, archiveId)
        // The order is the pointer's position; naming must not move it.
        expect(next.order).toEqual(p.order)
        expect(next.identity.messageId).toBe(p.identity.messageId)
        // An addressable pointer is never downgraded back to local.
        if (p.identity.state === 'addressable') expect(next.identity.state).toBe('addressable')
        // A floor has no provable position inside its millisecond, so it stays local.
        if (p.order.role === 'floor') expect(next.identity.state).toBe(p.identity.state)
        expect(withArchiveId(next, archiveId)).toEqual(next)
      }),
    )
  })
})
