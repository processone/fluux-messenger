import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rosterStore } from './rosterStore'
import { createStoreBindings } from '../bindings/storeBindings'
import { createMockClientWithSDKEvents, createMockStoreRefs } from '../core/test-utils'

// A failed listener must not interrupt a presence flush or the operation after it.
const peer = 'emma@fluux.chat'
const failure = new Error('UI subscriber failed')

beforeEach(() => {
  vi.useFakeTimers()
  rosterStore.getState().setContacts([{ jid: peer, name: 'Emma Wilson', presence: 'offline', subscription: 'both' }])
})
afterEach(() => { rosterStore.getState().reset(); vi.useRealTimers() })

function failingSubscriber() {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  const detach = rosterStore.subscribe(() => { throw failure })
  return { report, stop: () => { detach(); report.mockRestore() } }
}

function queuePresence() {
  rosterStore.getState().queuePresence(`${peer}/desktop`, null, 5)
}

describe('roster subscriber failure containment', () => {
  it('reports a failed listener and delivers timer-flushed presence to later listeners', () => {
    const failing = failingSubscriber()
    const following = vi.fn()
    const detach = rosterStore.subscribe(following)
    try {
      queuePresence()
      expect(() => vi.runOnlyPendingTimers()).not.toThrow()
      expect(rosterStore.getState().contacts.get(peer)?.presence).toBe('online')
      expect(following).toHaveBeenCalledTimes(1)
      expect(failing.report).toHaveBeenCalledExactlyOnceWith('[SDK] Store subscriber failed:', failure)
    } finally { detach(); failing.stop() }
  })

  it.each(['removeContact', 'setPresenceError', 'resetAllPresence', 'updateContact', 'addOrUpdateContact', 'updatePresence', 'removePresence', 'updateAvatar'] as const)(
    'finishes %s after its pending-presence flush notifies a failed listener', action => {
      queuePresence()
      const failing = failingSubscriber()
      try {
        const store = rosterStore.getState()
        expect(() => {
          switch (action) {
            case 'removeContact': store.removeContact(peer); break
            case 'setPresenceError': store.setPresenceError(peer, 'Remote server not found'); break
            case 'resetAllPresence': store.resetAllPresence(); break
            case 'updateContact': store.updateContact(peer, { name: 'Emma Renamed' }); break
            case 'addOrUpdateContact': store.addOrUpdateContact({ jid: peer, name: 'Emma Renamed', presence: 'offline', subscription: 'both' }); break
            case 'updatePresence': store.updatePresence(`${peer}/phone`, 'dnd', 10); break
            case 'removePresence': store.removePresence(`${peer}/desktop`); break
            case 'updateAvatar': store.updateAvatar(peer, 'blob:avatar', 'hash'); break
          }
        }).not.toThrow()
        const contact = rosterStore.getState().contacts.get(peer)
        switch (action) {
          case 'removeContact': expect(contact).toBeUndefined(); break
          case 'setPresenceError': expect(contact).toMatchObject({ presence: 'offline', presenceError: 'Remote server not found' }); break
          case 'resetAllPresence':
          case 'removePresence': expect(contact).toMatchObject({ presence: 'offline', resources: undefined }); break
          case 'updateContact':
          case 'addOrUpdateContact': expect(contact).toMatchObject({ name: 'Emma Renamed', presence: 'online' }); break
          case 'updatePresence': expect(contact?.presence).toBe('dnd'); break
          case 'updateAvatar': expect(contact).toMatchObject({ avatar: 'blob:avatar', avatarHash: 'hash', presence: 'online' }); break
        }
        expect(failing.report).toHaveBeenCalledWith('[SDK] Store subscriber failed:', failure)
        expect(vi.getTimerCount()).toBe(0)
      } finally { failing.stop() }
    },
  )

  it('removes bindings despite a failed listener during the cleanup flush', () => {
    const client = createMockClientWithSDKEvents()
    const refs = createMockStoreRefs()
    const unsubscribe = createStoreBindings(client, () => ({ ...refs, roster: rosterStore.getState() }))
    const failing = failingSubscriber()
    try {
      client.emit('contacts:presence', { fullJid: `${peer}/desktop`, show: null, priority: 5 })
      expect(() => unsubscribe()).not.toThrow()
      const committed = rosterStore.getState().contacts.get(peer)
      expect(committed?.presence).toBe('online')
      client.emit('contacts:presence', { fullJid: `${peer}/desktop`, show: 'away', priority: 5 })
      expect(rosterStore.getState().getContact(peer)).toBe(committed)
      expect(vi.getTimerCount()).toBe(0)
      expect(failing.report).toHaveBeenCalledWith('[SDK] Store subscriber failed:', failure)
    } finally { failing.stop(); unsubscribe() }
  })
})
