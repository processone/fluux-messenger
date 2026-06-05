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
})

describe('aggregateRenders', () => {
  it('sums render counts per component name', () => {
    const counts = {}
    aggregateRenders(counts, [{ componentName: 'RoomItem', count: 1 }, { componentName: 'Tooltip', count: 2 }])
    aggregateRenders(counts, [{ componentName: 'RoomItem', count: 1 }])
    expect(counts).toEqual({ RoomItem: 2, Tooltip: 2 })
  })
})
