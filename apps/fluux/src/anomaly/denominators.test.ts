// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createDenominatorTracker, type DenominatorName } from './denominators'
import { warmRoom } from './identity'
import { initTokenizer, resetValuesForTesting } from './values'

interface Msg {
  id: string
  isOutgoing?: boolean
}
type Arrivals = Map<string, Msg>

function tracker() {
  const seen: DenominatorName[] = []
  return { seen, t: createDenominatorTracker((name) => seen.push(name)) }
}

beforeEach(async () => {
  localStorage.clear()
  resetValuesForTesting()
  await initTokenizer()
})

const state = (arrivals: Arrivals, isRoom = false) => ({
  lastArrivedMessage: arrivals,
  isRoom,
})

describe('arrival denominator', () => {
  it('counts one arrival per conversation that received a new message', () => {
    const { seen, t } = tracker()
    const a: Msg = { id: 'm1' }
    const b: Msg = { id: 'm2' }
    t.observeArrivals(state(new Map([['conv-a', a]])), state(new Map()))
    t.observeArrivals(state(new Map([['conv-a', a], ['conv-b', b]])), state(new Map([['conv-a', a]])))
    expect(seen).toEqual(['message.arrivals.conversation', 'message.arrivals.conversation'])
  })

  it('counts room arrivals separately from conversation arrivals', () => {
    const { seen, t } = tracker()
    const message: Msg = { id: 'm1' }
    t.observeArrivals(
      state(new Map([['room-a', message]]), true),
      state(new Map(), true),
    )
    expect(seen).toEqual(['message.arrivals.room'])
  })

  it('ignores a state change that did not bring a message', () => {
    // The store publishes on typing, presence and read-state writes many times a
    // second. Counting those as arrivals would inflate the denominator until the
    // rate it divides became meaningless.
    const { seen, t } = tracker()
    const arrivals: Arrivals = new Map([['conv-a', { id: 'm1' }]])
    t.observeArrivals(state(arrivals), state(arrivals))
    t.observeArrivals(state(new Map(arrivals)), state(arrivals))
    expect(seen.filter((n) => n === 'message.arrivals.conversation')).toEqual([])
  })

  it('does not recount a conversation whose message is unchanged', () => {
    const { seen, t } = tracker()
    const a: Msg = { id: 'm1' }
    const before = new Map([['conv-a', a]])
    // A NEW Map holding the SAME message: the store rebuilt the map for an unrelated
    // reason. Comparing map identity alone would count an arrival that never happened.
    t.observeArrivals(state(new Map(before)), state(before))
    expect(seen.filter((n) => n === 'message.arrivals.conversation')).toEqual([])
  })
})

describe('room-switch denominator', () => {
  it('counts a switch when the active entity changes', () => {
    const { seen, t } = tracker()
    t.observeActive({ kind: 'room', id: 'room-a' }, null)
    t.observeActive({ kind: 'room', id: 'room-b' }, { kind: 'room', id: 'room-a' })
    expect(seen.filter((n) => n === 'room.switches')).toHaveLength(2)
  })

  it('does not count closing the last conversation as a switch', () => {
    // Leaving for the empty state is not navigation between conversations, and
    // counting it would credit a render burst to a switch that never happened.
    const { seen, t } = tracker()
    t.observeActive(null, { kind: 'room', id: 'room-a' })
    expect(seen.filter((n) => n === 'room.switches')).toEqual([])
  })
})

describe('breadcrumbs', () => {
  // The ring exists so a record can say what was happening just BEFORE it. Nothing
  // emitted crumbs, so every anomaly in the field arrived contextless — which is why
  // a recurring main-thread stall could not be attributed to anything.
  function tracked() {
    const crumbs: string[][] = []
    const t = createDenominatorTracker(
      () => {},
      (parts) => crumbs.push(parts.map((p) => (typeof p === 'object' && p !== null ? p.s : String(p)))),
    )
    return { crumbs, t }
  }

  it('leaves a crumb naming the conversation a message arrived in', () => {
    const { crumbs, t } = tracked()
    const msg = { id: 'm1', isOutgoing: false }
    t.observeArrivals(state(new Map([['conv-a', msg]])), state(new Map()))
    expect(crumbs).toHaveLength(1)
    expect(crumbs[0][0]).toBe('msg:in')
    // A token, never the JID: a crumb is written to a file like any other value.
    expect(crumbs[0][1]).toMatch(/^c:/)
  })

  it('labels an outgoing message as outgoing', () => {
    const { crumbs, t } = tracked()
    const msg = { id: 'm1', isOutgoing: true }
    t.observeArrivals(state(new Map([['conv-a', msg]])), state(new Map()))
    expect(crumbs[0][0]).toBe('msg:out')
  })

  it('uses the room token namespace for room arrivals', async () => {
    const roomJid = 'team@conference.fluux.chat'
    await warmRoom(roomJid)
    const { crumbs, t } = tracked()
    const msg = { id: 'm1', isOutgoing: false }
    t.observeArrivals(
      state(new Map([[roomJid, msg]]), true),
      state(new Map(), true),
    )
    expect(crumbs[0]).toEqual(['msg:in', expect.stringMatching(/^c:[0-9a-f]{16}$/)])
  })

  it('leaves a crumb naming the entity that became active', () => {
    const { crumbs, t } = tracked()
    t.observeActive({ kind: 'conversation', id: 'room-a' }, null)
    expect(crumbs).toHaveLength(1)
    expect(crumbs[0][0]).toBe('activate')
    expect(crumbs[0][1]).toMatch(/^c:/)
  })

  it('leaves a crumb when the last conversation is closed', () => {
    // Not a switch, so it is not a denominator — but it IS a state change worth
    // seeing in the seconds before a freeze.
    const { crumbs, t } = tracked()
    t.observeActive(null, { kind: 'conversation', id: 'room-a' })
    expect(crumbs.map((c) => c[0])).toEqual(['deactivate'])
  })

  it('stays silent on store churn that changed neither', () => {
    // The stores publish many times a second. A crumb per publication would flush the
    // ring in under a second and bury the events worth reading.
    const { crumbs, t } = tracked()
    const arrivals = new Map([['conv-a', { id: 'm1' }]])
    t.observeArrivals(state(arrivals), state(arrivals))
    t.observeArrivals(state(new Map(arrivals)), state(arrivals))
    t.observeActive(
      { kind: 'conversation', id: 'conv-a' },
      { kind: 'conversation', id: 'conv-a' },
    )
    expect(crumbs).toEqual([])
  })

  it('works with no crumb sink at all, which is every caller that only counts', () => {
    const seen: string[] = []
    const t = createDenominatorTracker((n) => seen.push(n))
    expect(() => t.observeActive({ kind: 'conversation', id: 'room-a' }, null)).not.toThrow()
    expect(seen).toEqual(['room.switches'])
  })
})

describe('crumb tokens resolve once the entity is warm', () => {
  it('names a warmed room by its real token, not the unresolved sentinel', async () => {
    // The crumb freezes its token at the instant it is written, so an activation
    // recorded before the first warm names `c:unresolved` forever. `install.ts`
    // therefore warms on the store transition rather than waiting for the sampler.
    await warmRoom('team@conference.fluux.chat')

    const crumbs: string[][] = []
    const t = createDenominatorTracker(
      () => {},
      (parts) =>
        crumbs.push(parts.map((p) => (typeof p === 'object' && p !== null ? p.s : String(p)))),
    )
    t.observeActive({ kind: 'room', id: 'team@conference.fluux.chat' }, null)

    expect(crumbs[0][0]).toBe('activate')
    expect(crumbs[0][1]).toMatch(/^c:[0-9a-f]{16}$/)
  })

  it('falls back to the sentinel rather than the JID when the entity is cold', () => {
    // Uncorrelatable, but never a leak: an unwarmed entity must degrade to the
    // sentinel, never to the raw identifier.
    const crumbs: string[][] = []
    const t = createDenominatorTracker(
      () => {},
      (parts) =>
        crumbs.push(parts.map((p) => (typeof p === 'object' && p !== null ? p.s : String(p)))),
    )
    t.observeActive({ kind: 'room', id: 'cold@conference.fluux.chat' }, null)
    expect(crumbs[0][1]).toBe('c:unresolved')
    expect(JSON.stringify(crumbs)).not.toContain('@')
  })
})
