import { describe, it, expect } from 'vitest'
import { parseStressParam, aggregateRenders } from './perfHarness'

describe('parseStressParam', () => {
  it('returns null when absent', () => {
    expect(parseStressParam(new URLSearchParams(''))).toBeNull()
  })
  it('parses key:value,key:value into a room-join scenario', () => {
    const s = parseStressParam(new URLSearchParams('stress=rooms:15,messages:150,occupants:80,mode:backfill'))
    expect(s).toEqual({ kind: 'room-join', rooms: 15, messagesPerRoom: 150, occupants: 80, mode: 'backfill' })
  })
  it('ignores unknown keys and clamps invalid numbers', () => {
    const s = parseStressParam(new URLSearchParams('stress=rooms:abc,foo:bar,messages:10'))
    expect(s).toEqual({ kind: 'room-join', messagesPerRoom: 10 })
  })
  it('parses the single-big-room repro: activate + instant seed', () => {
    const s = parseStressParam(new URLSearchParams('stress=rooms:1,messages:1000,occupants:97,activate:1,msgStep:0,roomStep:5'))
    expect(s).toEqual({
      kind: 'room-join', rooms: 1, messagesPerRoom: 1000, occupants: 97,
      activate: true, msgStepMs: 0, roomStepMs: 5,
    })
  })
  it('treats activate other than 1/true as false', () => {
    const s = parseStressParam(new URLSearchParams('stress=rooms:1,activate:0'))
    expect(s).toEqual({ kind: 'room-join', rooms: 1, activate: false })
  })
})

describe('aggregateRenders', () => {
  it('sums render counts per component name', () => {
    const counts = {}
    aggregateRenders(counts, [{ componentName: 'RoomItem', count: 1 }, { componentName: 'Tooltip', count: 2 }])
    aggregateRenders(counts, [{ componentName: 'RoomItem', count: 1 }])
    expect(counts).toEqual({ RoomItem: 2, Tooltip: 2 })
  })
})
