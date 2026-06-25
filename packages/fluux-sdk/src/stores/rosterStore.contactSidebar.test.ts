import { describe, it, expect, beforeEach } from 'vitest'
import { rosterStore } from './rosterStore'
import type { Contact } from '../core/types'

const c = (jid: string, over: Partial<Contact> = {}): Contact =>
  ({ jid, name: jid.split('@')[0], presence: 'online', subscription: 'both', ...over }) as Contact

describe('rosterStore.contactSidebarEntries', () => {
  beforeEach(() => rosterStore.setState({ contacts: new Map() }))

  it('groups online (non-offline) / offline / errored, each sorted by name, encoded as `group jid`', () => {
    rosterStore.setState({
      contacts: new Map([
        ['b@x', c('b@x', { name: 'Bob', presence: 'online' })],
        ['a@x', c('a@x', { name: 'Alice', presence: 'away' })], // away is non-offline -> online group
        ['z@x', c('z@x', { name: 'Zoe', presence: 'offline' })],
        ['e@x', c('e@x', { name: 'Err', presenceError: 'forbidden' })],
      ]),
    })
    expect(rosterStore.getState().contactSidebarEntries()).toEqual([
      'online a@x', // Alice (away) sorts before Bob (online) by NAME within the group
      'online b@x',
      'offline z@x',
      'errored e@x',
    ])
  })

  it('a non-offline presence flap (online<->away) does NOT reorder — same group, name-stable', () => {
    rosterStore.setState({
      contacts: new Map([
        ['a@x', c('a@x', { name: 'Alice', presence: 'online' })],
        ['b@x', c('b@x', { name: 'Bob', presence: 'online' })],
      ]),
    })
    const before = rosterStore.getState().contactSidebarEntries()
    rosterStore.setState({
      contacts: new Map([
        ['a@x', c('a@x', { name: 'Alice', presence: 'away' })], // still non-offline
        ['b@x', c('b@x', { name: 'Bob', presence: 'online' })],
      ]),
    })
    expect(rosterStore.getState().contactSidebarEntries()).toEqual(before)
  })

  it('online -> offline moves the contact to the offline group (a real reorder)', () => {
    rosterStore.setState({ contacts: new Map([['a@x', c('a@x', { name: 'Alice', presence: 'online' })]]) })
    expect(rosterStore.getState().contactSidebarEntries()).toEqual(['online a@x'])
    rosterStore.setState({ contacts: new Map([['a@x', c('a@x', { name: 'Alice', presence: 'offline' })]]) })
    expect(rosterStore.getState().contactSidebarEntries()).toEqual(['offline a@x'])
  })

  it('returns a referentially-stable empty array when there are no contacts', () => {
    const a = rosterStore.getState().contactSidebarEntries()
    expect(a).toEqual([])
    expect(rosterStore.getState().contactSidebarEntries()).toBe(a)
  })
})
