import { describe, it, expect } from 'vitest'
import { compareOrder, computeFloor, makeArchiveOrderKey, pointerlessDefers, isValidArchiveOrderKey } from './readState'
import { makeReadPointer } from './readPointer'

describe('compareOrder', () => {
  it('orders by timestamp first', () => {
    expect(compareOrder({ timestamp: 1 }, { timestamp: 2 })).toBeLessThan(0)
  })
  it('room ties break by (from, id)', () => {
    const a = { timestamp: 5, archiveOrderKey: makeArchiveOrderKey({ from: 'r@c/al', id: 'z' }, 'room') }
    const b = { timestamp: 5, archiveOrderKey: makeArchiveOrderKey({ from: 'r@c/bo', id: 'a' }, 'room') }
    expect(compareOrder(a, b)).toBeLessThan(0) // 'al' < 'bo' wins over id
  })
  it('chat ties break by id ONLY, ignoring from', () => {
    const a = { timestamp: 5, archiveOrderKey: makeArchiveOrderKey({ from: 'zed@x', id: 'a' }, 'chat') }
    const b = { timestamp: 5, archiveOrderKey: makeArchiveOrderKey({ from: 'amy@x', id: 'b' }, 'chat') }
    expect(compareOrder(a, b)).toBeLessThan(0) // id 'a' < 'b'; `from` must not participate
  })
  it('a missing key sorts before a present one at equal timestamp (conservative)', () => {
    const k = { timestamp: 5, archiveOrderKey: makeArchiveOrderKey({ id: 'a' }, 'chat') }
    expect(compareOrder({ timestamp: 5 }, k)).toBeLessThan(0)
  })
})

describe('computeFloor', () => {
  it('is pointer-wins, not max (migrated pointer behind historyFloor=now)', () => {
    const p = makeReadPointer({ id: 'm', timestamp: new Date(1000) })
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

describe('isValidArchiveOrderKey', () => {
  it('rejects untrusted shapes', () => {
    expect(isValidArchiveOrderKey({ kind: 'room', id: 'x' })).toBe(false) // missing from
    expect(isValidArchiveOrderKey({ kind: 'nope', id: 'x' })).toBe(false)
    expect(isValidArchiveOrderKey({ kind: 'chat', id: 'x' })).toBe(true)
  })
})
