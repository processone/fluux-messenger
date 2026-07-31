import { describe, it, expect } from 'vitest'
import {
  compareExact,
  computeFloor,
  isAfterBoundary,
  makeCacheOrderKey,
  mayAdvanceTo,
  pointerlessDefers,
  isValidCacheOrderKey,
} from './readState'
import { makeReadPointer } from './readPointer'

describe('compareExact', () => {
  it('orders by timestamp first', () => {
    const a = { timestamp: 1, tiebreak: makeCacheOrderKey({ id: 'z' }, 'chat') }
    const b = { timestamp: 2, tiebreak: makeCacheOrderKey({ id: 'a' }, 'chat') }
    expect(compareExact(a, b)).toBeLessThan(0) // timestamp wins over the tie-break
  })
  it('room ties break by (from, id)', () => {
    const a = { timestamp: 5, tiebreak: makeCacheOrderKey({ from: 'r@c/al', id: 'z' }, 'room') }
    const b = { timestamp: 5, tiebreak: makeCacheOrderKey({ from: 'r@c/bo', id: 'a' }, 'room') }
    expect(compareExact(a, b)).toBeLessThan(0) // 'al' < 'bo' wins over id
  })
  it('chat ties break by id ONLY, ignoring from', () => {
    const a = { timestamp: 5, tiebreak: makeCacheOrderKey({ from: 'zed@x', id: 'a' }, 'chat') }
    const b = { timestamp: 5, tiebreak: makeCacheOrderKey({ from: 'amy@x', id: 'b' }, 'chat') }
    expect(compareExact(a, b)).toBeLessThan(0) // id 'a' < 'b'; `from` must not participate
  })
})

/**
 * The one fact these two describe-blocks exist to keep apart (#1173): at an
 * equal millisecond a MISSING tie-break means the OPPOSITE thing depending on
 * which question is asked. Both rules predate this split; only one of them was
 * ever written down as code.
 */
describe('isAfterBoundary — the counting/divider question', () => {
  const row = { timestamp: 5, tiebreak: makeCacheOrderKey({ id: 'a' }, 'chat') }

  it("counts a row at a KEYLESS boundary's own millisecond as after it (over-count, safe)", () => {
    // The old `compareOrder` phrasing of this same fact was "a missing key
    // sorts BEFORE a present one at an equal timestamp". Read from the row's
    // side, that is exactly "the row is after the boundary".
    expect(isAfterBoundary(row, { timestamp: 5 })).toBe(true)
  })
  it('still orders by timestamp against a keyless boundary', () => {
    expect(isAfterBoundary(row, { timestamp: 6 })).toBe(false)
    expect(isAfterBoundary(row, { timestamp: 4 })).toBe(true)
  })
  it('uses the tie-break when the boundary has one', () => {
    expect(isAfterBoundary(row, { timestamp: 5, tiebreak: makeCacheOrderKey({ id: 'b' }, 'chat') })).toBe(false)
    expect(isAfterBoundary(row, { timestamp: 5, tiebreak: makeCacheOrderKey({ id: 'A' }, 'chat') })).toBe(true)
  })
})

describe('mayAdvanceTo — the advance/seen question', () => {
  const candidate = { timestamp: 5, tiebreak: makeCacheOrderKey({ id: 'a' }, 'chat') }

  it('refuses to overtake a KEYLESS current position at an equal millisecond', () => {
    // The inverse of the boundary rule above, on identical inputs.
    expect(mayAdvanceTo(candidate, { timestamp: 5 })).toBe(false)
  })
  it('refuses to advance from a KEYLESS candidate at an equal millisecond', () => {
    expect(mayAdvanceTo({ timestamp: 5 }, candidate)).toBe(false)
  })
  it('still advances by strict millisecond when the timestamps differ', () => {
    expect(mayAdvanceTo({ timestamp: 6 }, { timestamp: 5 })).toBe(true)
    expect(mayAdvanceTo({ timestamp: 4 }, { timestamp: 5 })).toBe(false)
  })
  it('uses the tie-break when both sides have one', () => {
    expect(mayAdvanceTo(candidate, { timestamp: 5, tiebreak: makeCacheOrderKey({ id: 'b' }, 'chat') })).toBe(false)
    expect(mayAdvanceTo(candidate, { timestamp: 5, tiebreak: makeCacheOrderKey({ id: 'A' }, 'chat') })).toBe(true)
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

describe('isValidCacheOrderKey', () => {
  it('rejects untrusted shapes', () => {
    expect(isValidCacheOrderKey({ kind: 'room', id: 'x' })).toBe(false) // missing from
    expect(isValidCacheOrderKey({ kind: 'nope', id: 'x' })).toBe(false)
    expect(isValidCacheOrderKey({ kind: 'chat', id: 'x' })).toBe(true)
  })
})
