import { describe, it, expect } from 'vitest'
import {
  compareExact,
  computeFloor,
  isAfterBoundary,
  makeCacheOrderKey,
  mayAdvanceTo,
  type ExactPosition,
  pointerlessDefers,
} from './readState'
import { makeReadPointer } from './readPointer'

describe('compareExact', () => {
  it('orders by timestamp first', () => {
    const a: ExactPosition = { role: 'exact', timestamp: 1, tiebreak: makeCacheOrderKey({ id: 'z' }, 'chat') }
    const b: ExactPosition = { role: 'exact', timestamp: 2, tiebreak: makeCacheOrderKey({ id: 'a' }, 'chat') }
    expect(compareExact(a, b)).toBeLessThan(0) // timestamp wins over the tie-break
  })
  it('room ties break by (from, id)', () => {
    const a: ExactPosition = { role: 'exact', timestamp: 5, tiebreak: makeCacheOrderKey({ from: 'r@c/al', id: 'z' }, 'room') }
    const b: ExactPosition = { role: 'exact', timestamp: 5, tiebreak: makeCacheOrderKey({ from: 'r@c/bo', id: 'a' }, 'room') }
    expect(compareExact(a, b)).toBeLessThan(0) // 'al' < 'bo' wins over id
  })
  it('chat ties break by id ONLY, ignoring from', () => {
    const a: ExactPosition = { role: 'exact', timestamp: 5, tiebreak: makeCacheOrderKey({ from: 'zed@x', id: 'a' }, 'chat') }
    const b: ExactPosition = { role: 'exact', timestamp: 5, tiebreak: makeCacheOrderKey({ from: 'amy@x', id: 'b' }, 'chat') }
    expect(compareExact(a, b)).toBeLessThan(0) // id 'a' < 'b'; `from` must not participate
  })
})

/**
 * The one fact these two describe-blocks exist to keep apart (#1173): at an
 * equal millisecond a FLOOR position means the OPPOSITE thing depending on
 * which question is asked. Both rules predate this split; only one of them was
 * ever written down as code.
 */
describe('isAfterBoundary — the counting/divider question', () => {
  const row: ExactPosition = { role: 'exact', timestamp: 5, tiebreak: makeCacheOrderKey({ id: 'a' }, 'chat') }

  it("counts a row at a FLOOR boundary's own millisecond as after it (over-count, safe)", () => {
    // The old `compareOrder` phrasing of this same fact was "a missing key
    // sorts BEFORE a present one at an equal timestamp". Read from the row's
    // side, that is exactly "the row is after the boundary".
    expect(isAfterBoundary(row, { role: 'floor', timestamp: 5 })).toBe(true)
  })
  it('still orders by timestamp against a floor boundary', () => {
    expect(isAfterBoundary(row, { role: 'floor', timestamp: 6 })).toBe(false)
    expect(isAfterBoundary(row, { role: 'floor', timestamp: 4 })).toBe(true)
  })
  it('uses the tie-break when the boundary has one', () => {
    expect(isAfterBoundary(row, { role: 'exact', timestamp: 5, tiebreak: makeCacheOrderKey({ id: 'b' }, 'chat') })).toBe(false)
    expect(isAfterBoundary(row, { role: 'exact', timestamp: 5, tiebreak: makeCacheOrderKey({ id: 'A' }, 'chat') })).toBe(true)
  })
})

describe('mayAdvanceTo — the advance/seen question', () => {
  const candidate: ExactPosition = { role: 'exact', timestamp: 5, tiebreak: makeCacheOrderKey({ id: 'a' }, 'chat') }

  it('refuses to overtake a FLOOR current position at an equal millisecond', () => {
    // The inverse of the boundary rule above, on identical inputs.
    expect(mayAdvanceTo(candidate, { role: 'floor', timestamp: 5 })).toBe(false)
  })
  it('refuses to advance from a FLOOR candidate at an equal millisecond', () => {
    expect(mayAdvanceTo({ role: 'floor', timestamp: 5 }, candidate)).toBe(false)
  })
  it('still advances by strict millisecond when the timestamps differ', () => {
    expect(mayAdvanceTo({ role: 'floor', timestamp: 6 }, { role: 'floor', timestamp: 5 })).toBe(true)
    expect(mayAdvanceTo({ role: 'floor', timestamp: 4 }, { role: 'floor', timestamp: 5 })).toBe(false)
  })
  it('uses the tie-break when both sides have one', () => {
    expect(mayAdvanceTo(candidate, { role: 'exact', timestamp: 5, tiebreak: makeCacheOrderKey({ id: 'b' }, 'chat') })).toBe(false)
    expect(mayAdvanceTo(candidate, { role: 'exact', timestamp: 5, tiebreak: makeCacheOrderKey({ id: 'A' }, 'chat') })).toBe(true)
  })
})

describe('computeFloor', () => {
  it('is pointer-wins, not max (migrated pointer behind historyFloor=now)', () => {
    const p = makeReadPointer({ id: 'm', timestamp: new Date(1000) }, 'chat')
    expect(computeFloor(p, new Date(9_999_999))!.getTime()).toBe(1000)
  })
  it('falls back to historyFloor when pointerless', () => {
    expect(computeFloor(undefined, new Date(42))!.getTime()).toBe(42)
  })
})

describe('pointerlessDefers', () => {
  it('defers pointerless with a real persisted count', () => expect(pointerlessDefers(undefined, 3)).toBe(true))
  it('allows a pointerless zero (genuinely fresh)', () => expect(pointerlessDefers(undefined, 0)).toBe(false))
})

/**
 * A reused MUC nick puts two occupants under one `(from, id)`. The occupant rung
 * is what separates their positions; these tests pin the rung itself.
 */
describe('the occupant rung', () => {
  const roomRow = (occupantId?: string): ExactPosition => ({
    role: 'exact',
    timestamp: 5,
    tiebreak: makeCacheOrderKey({ from: 'r@c/nick', id: 'm1', occupantId }, 'room'),
  })

  it('separates two rows that differ only by occupant-id', () => {
    expect(compareExact(roomRow('a'), roomRow('b'))).toBeLessThan(0)
    expect(compareExact(roomRow('b'), roomRow('a'))).toBeGreaterThan(0)
    expect(compareExact(roomRow('a'), roomRow('a'))).toBe(0)
  })

  it("counts the other occupant's row instead of swallowing it", () => {
    // The defect this rung closes: with the pointer on occupant a's row, b's
    // row compared EQUAL and was silently dropped from the unread count.
    expect(isAfterBoundary(roomRow('b'), roomRow('a'))).toBe(true)
    expect(mayAdvanceTo(roomRow('b'), roomRow('a'))).toBe(true)
  })

  it('leaves two occupant-less rows tied, exactly as before', () => {
    expect(compareExact(roomRow(), roomRow())).toBe(0)
    expect(isAfterBoundary(roomRow(), roomRow())).toBe(false)
    expect(mayAdvanceTo(roomRow(), roomRow())).toBe(false)
  })

  it('never lets an occupant-id reach a CHAT key', () => {
    const chatRow = (occupantId?: string): ExactPosition => ({
      role: 'exact',
      timestamp: 5,
      tiebreak: makeCacheOrderKey({ from: 'r@c/nick', id: 'm1', occupantId }, 'chat'),
    })
    expect(compareExact(chatRow('a'), chatRow('b'))).toBe(0)
  })
})

/**
 * The MIXED pair: one side names its occupant and the other CANNOT — a pointer
 * hydrated from a blob written before occupant-ids were carried, against a row
 * that has one (or the reverse, a legacy cached row under a current pointer).
 *
 * This is the pair the change actually has to get right. Every existing user
 * meets it on first read; the new/new pair above is the easy case.
 */
describe('the MIXED pair — one side has no occupant identity', () => {
  const room = (occupantId?: string): ExactPosition => ({
    role: 'exact',
    timestamp: 5,
    tiebreak: makeCacheOrderKey({ from: 'r@c/nick', id: 'm1', occupantId }, 'room'),
  })

  it('COUNTS the row in both directions of the mixture — over-count, never under-count', () => {
    expect(isAfterBoundary(room('x'), room())).toBe(true)
    // The direction a bare sentinel order loses: an occupant-less row under a
    // pointer that names one would sort BEFORE the boundary and vanish.
    expect(isAfterBoundary(room(), room('x'))).toBe(true)
  })

  it('lets the pointer advance onto the row that names its occupant, so the over-count clears', () => {
    expect(mayAdvanceTo(room('x'), room())).toBe(true)
  })

  it('refuses to advance onto a row that cannot name the occupant the pointer holds', () => {
    expect(mayAdvanceTo(room(), room('x'))).toBe(false)
  })

  it('keeps compareExact a TOTAL order across the mixed pair', () => {
    // Transitive: absent, then 'a', then 'b'. A rule that made an absent
    // occupant compare EQUAL to every present one would not be, and
    // `sortMessagesByTimestamp` would then produce an arbitrary permutation.
    expect(compareExact(room(), room('a'))).toBeLessThan(0)
    expect(compareExact(room('a'), room('b'))).toBeLessThan(0)
    expect(compareExact(room(), room('b'))).toBeLessThan(0)
  })
})
