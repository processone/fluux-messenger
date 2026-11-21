import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoreBindings } from './storeBindings'
import { createMockClientWithSDKEvents, createMockStoreRefs } from '../core/test-utils'
import { rosterStore } from '../stores/rosterStore'
import type { Contact } from '../core/types'

// Finding 2: SDK presence bursts must publish once without losing aggregation,
// lifecycle ordering, or the Contacts sidebar's cached name/group order.
const emma: Contact = { jid: 'emma@fluux.chat', name: 'Emma Wilson', presence: 'offline', subscription: 'both' }
const james: Contact = { jid: 'james@fluux.chat', name: 'James Chen', presence: 'offline', subscription: 'both' }

describe('contact presence publication', () => {
  let client: ReturnType<typeof createMockClientWithSDKEvents>
  let unsubscribe: () => void
  beforeEach(() => {
    vi.useFakeTimers()
    rosterStore.getState().reset()
    rosterStore.getState().setContacts([emma, james], 'me@fluux.chat')
    client = createMockClientWithSDKEvents()
    const refs = createMockStoreRefs()
    unsubscribe = createStoreBindings(client, () => ({ ...refs, roster: rosterStore.getState() }))
  })
  afterEach(() => {
    unsubscribe()
    rosterStore.getState().reset()
    vi.useRealTimers()
  })
  const available = (fullJid = `${emma.jid}/desktop`, show: 'away' | 'chat' | 'dnd' | null = null, priority = 5, statusMessage?: string) =>
    client.emit('contacts:presence', { fullJid, show, priority, statusMessage, client: 'Fluux' })
  const unavailable = (fullJid: string) => client.emit('contacts:presence-offline', { fullJid })

  it('aggregates a burst in wire order with immediate protocol reads and one immutable publication', () => {
    const before = rosterStore.getState().contacts
    const listener = vi.fn()
    const detach = rosterStore.subscribe(listener)
    try {
      available(`${emma.jid}/desktop`, 'away', 5, 'Back soon')
      available(`${emma.jid}/phone`, 'chat', 5, 'On mobile')
      expect(rosterStore.getState().getContact(emma.jid)).toMatchObject({ presence: 'online', statusMessage: 'On mobile' })
      unavailable(`${emma.jid}/phone`)
      available(`${james.jid}/laptop`, 'dnd', 10, 'In a meeting')
      available('unknown@fluux.chat/phone')
      expect(rosterStore.getState().getContact(emma.jid)).toMatchObject({ presence: 'away', statusMessage: 'Back soon' })
      expect(listener).not.toHaveBeenCalled()
      expect(rosterStore.getState().contacts).toBe(before)
      vi.runOnlyPendingTimers()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(rosterStore.getState().contacts).not.toBe(before)
      expect(before.get(emma.jid)).toMatchObject(emma)
      expect(before.get(emma.jid)?.resources).toBeUndefined()
      expect(rosterStore.getState().contacts.get(james.jid)).toMatchObject({ presence: 'dnd', statusMessage: 'In a meeting' })
      expect(rosterStore.getState().contacts.size).toBe(before.size)
    } finally { detach() }
  })

  it('retains priority, idle time and last-resource removal through alternating updates', () => {
    const lastInteraction = new Date('2026-01-01T12:00:00Z')
    client.emit('contacts:presence', { fullJid: `${emma.jid}/desktop`, show: 'dnd', priority: 10, lastInteraction, statusMessage: 'Busy' })
    client.emit('contacts:presence', { fullJid: `${emma.jid}/phone`, show: 'chat', priority: 5, lastInteraction, statusMessage: 'On mobile' })
    expect(rosterStore.getState().getContact(emma.jid)).toMatchObject({ presence: 'dnd', lastInteraction })
    unavailable(`${emma.jid}/desktop`)
    expect(rosterStore.getState().getContact(emma.jid)?.presence).toBe('online')
    unavailable(`${emma.jid}/phone`)
    const offline = rosterStore.getState().getContact(emma.jid)!
    expect(offline).toMatchObject({ presence: 'offline', resources: undefined, statusMessage: undefined, lastInteraction: undefined })
    expect(offline.lastSeen).toEqual(new Date())
    vi.runOnlyPendingTimers()
    expect(rosterStore.getState().contacts.get(emma.jid)).toBe(offline)
  })

  it('accepts bare-JID resource keys and ignores unknown contacts without scheduling work', () => {
    available('unknown@fluux.chat/phone')
    expect(vi.getTimerCount()).toBe(0)
    available(emma.jid, 'away', 0)
    expect(rosterStore.getState().getContact(emma.jid)?.resources?.has('')).toBe(true)
    unavailable(emma.jid)
    vi.runOnlyPendingTimers()
    expect(rosterStore.getState().contacts.get(emma.jid)?.presence).toBe('offline')
  })

  it('keeps avatar completion in the pending contact without splitting the burst', () => {
    const listener = vi.fn()
    const detach = rosterStore.subscribe(listener)
    try {
      available()
      client.emit('contacts:avatar', { jid: emma.jid, avatar: 'blob:avatar', avatarHash: 'hash' })
      available(`${james.jid}/desktop`)
      expect(listener).not.toHaveBeenCalled()
      vi.runOnlyPendingTimers()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(rosterStore.getState().getContact(emma.jid)).toMatchObject({ presence: 'online', avatar: 'blob:avatar', avatarHash: 'hash' })
    } finally { detach() }
  })

  it.each(['reset', 'replace', 'switch', 'remove', 'resetPresence'] as const)('does not resurrect stale presence after %s', boundary => {
    available()
    const store = rosterStore.getState()
    if (boundary === 'reset') store.reset()
    if (boundary === 'replace') store.setContacts([emma, james])
    if (boundary === 'switch') { store.switchAccount('other@fluux.chat'); store.setContacts([emma, james]) }
    if (boundary === 'remove') store.removeContact(emma.jid)
    if (boundary === 'resetPresence') store.resetAllPresence()
    const after = rosterStore.getState().contacts
    vi.runOnlyPendingTimers()
    expect(rosterStore.getState().contacts).toBe(after)
    expect(rosterStore.getState().getContact(emma.jid)?.presence ?? 'offline').toBe('offline')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('orders errors, recovery, rename and direct synchronous mutations with the queued state', () => {
    available()
    client.emit('contacts:presence-error', { jid: emma.jid, error: 'Remote server not found' })
    expect(rosterStore.getState().contacts.get(emma.jid)).toMatchObject({ presence: 'offline', presenceError: 'Remote server not found', resources: undefined })
    available()
    client.emit('contacts:contact-updated', { jid: emma.jid, updates: { name: 'Emma Renamed' } })
    expect(rosterStore.getState().contacts.get(emma.jid)).toMatchObject({ name: 'Emma Renamed', presence: 'online', presenceError: undefined })
    available(`${james.jid}/phone`)
    rosterStore.getState().updateAvatar(james.jid, 'blob:avatar', 'hash')
    expect(rosterStore.getState().contacts.get(james.jid)).toMatchObject({ presence: 'online', avatar: 'blob:avatar', avatarHash: 'hash' })
    rosterStore.getState().updatePresence(`${james.jid}/desktop`, 'dnd', 10)
    expect(rosterStore.getState().contacts.get(james.jid)?.presence).toBe('dnd')
    rosterStore.getState().removePresence(`${james.jid}/desktop`)
    expect(rosterStore.getState().contacts.get(james.jid)?.presence).toBe('online')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['disconnect', 'dispose'] as const)('flushes accepted work on %s and removes its timer', boundary => {
    available()
    if (boundary === 'dispose') unsubscribe()
    else client.emit('connection:status', { status: 'offline' })
    expect(rosterStore.getState().contacts.get(emma.jid)?.presence).toBe('online')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('caches Contacts order across status changes but invalidates membership, name and error groups', () => {
    const entries = () => rosterStore.getState().contactSidebarEntries()
    expect(entries()).toEqual([`offline ${emma.jid}`, `offline ${james.jid}`])
    expect(entries()).toBe(entries())
    available()
    vi.runOnlyPendingTimers()
    const online = entries()
    available(`${emma.jid}/desktop`, 'away', 5, 'Back soon')
    vi.runOnlyPendingTimers()
    const compare = vi.spyOn(String.prototype, 'localeCompare')
    try {
      expect(entries()).toBe(online)
      expect(entries()).toBe(online)
      expect(compare).not.toHaveBeenCalled()
    } finally { compare.mockRestore() }
    available(`${james.jid}/desktop`)
    vi.runOnlyPendingTimers()
    expect(entries()).toEqual([`online ${emma.jid}`, `online ${james.jid}`])
    rosterStore.getState().updateContact(james.jid, { name: 'Aaron Chen' })
    expect(entries()).toEqual([`online ${james.jid}`, `online ${emma.jid}`])
    client.emit('contacts:presence-error', { jid: james.jid, error: 'Remote server not found' })
    expect(entries()).toEqual([`online ${emma.jid}`, `errored ${james.jid}`])
    available(`${james.jid}/desktop`)
    vi.runOnlyPendingTimers()
    expect(entries()).toEqual([`online ${james.jid}`, `online ${emma.jid}`])
    unavailable(`${emma.jid}/desktop`)
    vi.runOnlyPendingTimers()
    expect(entries()).toEqual([`online ${james.jid}`, `offline ${emma.jid}`])
    rosterStore.getState().removeContact(james.jid)
    expect(entries()).toEqual([`offline ${emma.jid}`])
  })
})
