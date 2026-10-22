import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { Roster } from './Roster'
import type { ModuleDependencies } from './BaseModule'
import { createStoreBindings, type StoreRefs } from '../../bindings/storeBindings'
import { createMockClientWithSDKEvents, createMockStoreRefs, createMockStores, createMockPresenceReader } from '../test-utils'
import { rosterStore } from '../../stores/rosterStore'
import { eventsStore } from '../../stores/eventsStore'

// Intent: an incoming request accepted on another device must disappear on desktop.
// Fixtures: the two interested resources and subscription directions follow RFC 6121
// §§2.1.2.5 and 3.1.5, including its concrete juliet/romeo addresses and push ID.
// These are standards-derived protocol inputs, NOT captured traffic from a user.
// Roster.handle, real XML Elements, createStoreBindings, and both stores are unmodified.
// Only transport, event bus, and unrelated store methods are test doubles.
const contact = 'romeo@example.net'
const desktop = 'juliet@example.com/chamber'
let roster: Roster
let cleanup: () => void
let deps: ModuleDependencies
let seen: Array<{ event: string; payload: unknown }>

function rosterIQ(subscription: string, type = 'set', ask?: string): Element {
  return xml('iq', { to: desktop, type, id: 'x81g3bdy4n19' },
    xml('query', { xmlns: 'jabber:iq:roster' },
      xml('item', { jid: contact, subscription, ...(ask ? { ask } : {}) })))
}

function pending(): string[] {
  return eventsStore.getState().subscriptionRequests.map(r => r.from)
}

function showReading(label: string): void {
  process.stdout.write(JSON.stringify({
    label,
    rosterSubscription: rosterStore.getState().getContact(contact)?.subscription,
    pendingRequests: pending(),
    removalEvents: seen.filter(e => e.event === 'events:subscription-request-removed'),
    sentStanzas: vi.mocked(deps.sendStanza).mock.calls.map(([s]) => s.toString()),
  }) + '\n')
}

beforeEach(() => {
  eventsStore.getState().reset()
  rosterStore.getState().reset()
  seen = []
  const bus = createMockClientWithSDKEvents()
  const refs = createMockStoreRefs()
  cleanup = createStoreBindings(bus, () => ({
    ...refs, roster: rosterStore.getState(), events: eventsStore.getState(),
  }) as unknown as StoreRefs)
  const readers = createMockStores()
  readers.roster.getContact.mockImplementation(jid => rosterStore.getState().getContact(jid))
  deps = {
    stores: readers,
    presence: createMockPresenceReader(),
    sendStanza: vi.fn(async () => {}),
    sendIQ: vi.fn(),
    getCurrentJid: () => desktop,
    getXmpp: () => null,
    emit: vi.fn(),
    emitSDK: (event, payload) => {
      seen.push({ event, payload })
      bus.emit(event, payload)
    },
  }
  roster = new Roster(deps)
  // Clean initial roster then a genuine subscribe-shaped presence, not store seeding.
  expect(roster.handle(rosterIQ('none', 'result'))).toBe(true)
  expect(roster.handle(xml('presence', {
    from: contact, to: desktop, type: 'subscribe',
  }))).toBe(true)
  expect(pending()).toEqual([contact])
  seen = []
})

afterEach(() => {
  cleanup()
  eventsStore.getState().reset()
  rosterStore.getState().reset()
})

describe('cross-device acceptance: incoming request accepted on a different resource', () => {
  it.each([
    { subscription: 'from', ask: undefined },
    { subscription: 'from', ask: 'subscribe' },
    { subscription: 'both', ask: undefined },
  ])('clears desktop pending request after server push $subscription (ask=$ask)', ({ subscription, ask }) => {
    // This is what the server sends to the *other* interested resource after approval.
    // Do not call desktop.acceptSubscription: it only runs on the accepting device.
    expect(roster.handle(rosterIQ(subscription, 'set', ask))).toBe(true)
    expect(rosterStore.getState().getContact(contact)?.subscription).toBe(subscription)
    expect(deps.sendStanza).not.toHaveBeenCalled()
    showReading(`after remote acceptance: ${subscription}; ask=${ask || 'absent'}`)
    expect(pending(), 'Accepted incoming requests must disappear from desktop Demandes').toEqual([])
  })

  it('control: local desktop acceptance clears the same pending request', async () => {
    await roster.acceptSubscription(contact)
    showReading('after local acceptance')
    expect(pending()).toEqual([])
    expect(vi.mocked(deps.sendStanza).mock.calls.map(([s]) => s.attrs.type)).toEqual(['subscribed', 'subscribe'])
    expect(seen).toContainEqual({ event: 'events:subscription-request-removed', payload: { from: contact } })
  })

  it.each(['none', 'to'])('negative control: $subscription does not establish approval of the inbound request', subscription => {
    expect(roster.handle(rosterIQ(subscription))).toBe(true)
    if (subscription === 'to') {
      // Incoming subscribed approves OUR outgoing subscription, not theirs to us.
      expect(roster.handle(xml('presence', { from: contact, to: desktop, type: 'subscribed' }))).toBe(true)
    }
    showReading(`not inbound approval: ${subscription}`)
    expect(pending()).toEqual([contact])
    expect(deps.sendStanza).not.toHaveBeenCalled()
  })
})
