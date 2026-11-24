import { describe, expect, it } from 'vitest'
import { RoomMarkerOrder } from './RoomMarkerOrder'

// Source: the approved room-marker plan requires archive order, never opaque
// ID, nickname, client-ID or timestamp sorting. This is that order's sole owner.
describe('room marker archive order', () => {
  it('uses page order even when opaque IDs sort the other way', () => {
    const order = new RoomMarkerOrder()
    order.page(['z-last-lexically', 'a-first-lexically'])
    expect(order.after('a-first-lexically', 'z-last-lexically')).toBe(true)
    expect(order.after('z-last-lexically', 'a-first-lexically')).toBe(false)
  })

  it('joins forward/backward pages through their actual RSM cursor', () => {
    const order = new RoomMarkerOrder()
    order.page(['archive-middle', 'archive-new'])
    order.page(['archive-old'], { before: 'archive-middle' })
    order.page(['archive-newest'], { after: 'archive-new' })
    expect(order.after('archive-newest', 'archive-old')).toBe(true)
    expect(order.after('archive-old', 'archive-newest')).toBe(false)
    expect(order.after('outside-resident-window', 'archive-old')).toBe(false)
  })

  it('invalidates a remembered archive end for new singleton evidence, not duplicate observations', () => {
    const order = new RoomMarkerOrder()
    const before = order.revision
    order.page(['archive-first'])
    expect(order.revision).toBeGreaterThan(before)
    const pageRevision = order.revision
    order.page(['archive-first'])
    expect(order.revision).toBe(pageRevision)
    order.live('archive-new')
    expect(order.revision).toBeGreaterThan(pageRevision)
    const liveRevision = order.revision
    order.live('archive-new')
    expect(order.revision).toBe(liveRevision)
  })

  it('ignores duplicate and previously ordered stream replay rather than creating a cycle', () => {
    const order = new RoomMarkerOrder()
    order.live('archive-first'); order.live('archive-second')
    order.live('archive-first'); order.live('archive-second'); order.live('archive-third')
    expect(order.after('archive-third', 'archive-first')).toBe(true)
    expect(order.after('archive-first', 'archive-third')).toBe(false)
    expect(order.after('archive-third', 'archive-third')).toBe(false)
  })
})
