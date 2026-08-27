// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createDenominatorTracker, type DenominatorName } from './denominators'

interface Msg {
  id: string
}
type Arrivals = Map<string, Msg>

function tracker() {
  const seen: DenominatorName[] = []
  return { seen, t: createDenominatorTracker((name) => seen.push(name)) }
}

const state = (arrivals: Arrivals, active?: string | null) => ({
  lastArrivedMessage: arrivals,
  activeId: active ?? null,
})

describe('arrival denominator', () => {
  it('counts one arrival per conversation that received a new message', () => {
    const { seen, t } = tracker()
    const a: Msg = { id: 'm1' }
    const b: Msg = { id: 'm2' }
    t.observe(state(new Map([['conv-a', a]])), state(new Map()))
    t.observe(state(new Map([['conv-a', a], ['conv-b', b]])), state(new Map([['conv-a', a]])))
    expect(seen).toEqual(['message.arrivals', 'message.arrivals'])
  })

  it('ignores a state change that did not bring a message', () => {
    // The store publishes on typing, presence and read-state writes many times a
    // second. Counting those as arrivals would inflate the denominator until the
    // rate it divides became meaningless.
    const { seen, t } = tracker()
    const arrivals: Arrivals = new Map([['conv-a', { id: 'm1' }]])
    t.observe(state(arrivals, 'conv-a'), state(arrivals, null))
    t.observe(state(arrivals, 'conv-b'), state(arrivals, 'conv-a'))
    expect(seen.filter((n) => n === 'message.arrivals')).toEqual([])
  })

  it('does not recount a conversation whose message is unchanged', () => {
    const { seen, t } = tracker()
    const a: Msg = { id: 'm1' }
    const before = new Map([['conv-a', a]])
    // A NEW Map holding the SAME message: the store rebuilt the map for an unrelated
    // reason. Comparing map identity alone would count an arrival that never happened.
    t.observe(state(new Map(before)), state(before))
    expect(seen.filter((n) => n === 'message.arrivals')).toEqual([])
  })
})

describe('room-switch denominator', () => {
  it('counts a switch when the active entity changes', () => {
    const { seen, t } = tracker()
    const arrivals: Arrivals = new Map()
    t.observe(state(arrivals, 'room-a'), state(arrivals, null))
    t.observe(state(arrivals, 'room-b'), state(arrivals, 'room-a'))
    expect(seen.filter((n) => n === 'room.switches')).toHaveLength(2)
  })

  it('does not count closing the last conversation as a switch', () => {
    // Leaving for the empty state is not navigation between conversations, and
    // counting it would credit a render burst to a switch that never happened.
    const { seen, t } = tracker()
    const arrivals: Arrivals = new Map()
    t.observe(state(arrivals, null), state(arrivals, 'room-a'))
    expect(seen.filter((n) => n === 'room.switches')).toEqual([])
  })
})
