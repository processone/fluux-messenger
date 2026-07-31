import { describe, it, expect } from 'vitest'
import { compareOrder, computeFloor, makeCacheOrderKey, pointerlessDefers, isValidCacheOrderKey } from './readState'
import { makeReadPointer } from './readPointer'

describe('compareOrder', () => {
  it('orders by timestamp first', () => {
    expect(compareOrder({ timestamp: 1 }, { timestamp: 2 })).toBeLessThan(0)
  })
  it('room ties break by (from, id)', () => {
    const a = { timestamp: 5, tiebreak: makeCacheOrderKey({ from: 'r@c/al', id: 'z' }, 'room') }
    const b = { timestamp: 5, tiebreak: makeCacheOrderKey({ from: 'r@c/bo', id: 'a' }, 'room') }
    expect(compareOrder(a, b)).toBeLessThan(0) // 'al' < 'bo' wins over id
  })
  it('chat ties break by id ONLY, ignoring from', () => {
    const a = { timestamp: 5, tiebreak: makeCacheOrderKey({ from: 'zed@x', id: 'a' }, 'chat') }
    const b = { timestamp: 5, tiebreak: makeCacheOrderKey({ from: 'amy@x', id: 'b' }, 'chat') }
    expect(compareOrder(a, b)).toBeLessThan(0) // id 'a' < 'b'; `from` must not participate
  })
  it('a missing key sorts before a present one at equal timestamp (conservative)', () => {
    const k = { timestamp: 5, tiebreak: makeCacheOrderKey({ id: 'a' }, 'chat') }
    expect(compareOrder({ timestamp: 5 }, k)).toBeLessThan(0)
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
