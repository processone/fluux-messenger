import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ignoreStore } from './ignoreStore'
import { setStorageScopeJid } from '../utils/storageScope'

const ROOM_JID = 'room@conference.example.com'
const alice = { identifier: 'occ-id-alice', displayName: 'Alice' }

describe('ignoreStore account scoping', () => {
  beforeEach(() => {
    localStorage.clear()
    setStorageScopeJid('a@example.com')
    ignoreStore.getState().rehydrate()
  })

  afterEach(() => {
    setStorageScopeJid(null)
    localStorage.clear()
  })

  it('does not carry one account’s ignore list into an account with nothing stored', () => {
    ignoreStore.getState().addIgnored(ROOM_JID, alice)

    setStorageScopeJid('b@example.com')
    ignoreStore.getState().rehydrate()

    expect(ignoreStore.getState().getIgnoredForRoom(ROOM_JID)).toEqual([])
    expect(localStorage.getItem('fluux-ignored-users:b@example.com')).toBeNull()
  })

  it('restores the account’s own list when switching back', () => {
    ignoreStore.getState().addIgnored(ROOM_JID, alice)

    setStorageScopeJid('b@example.com')
    ignoreStore.getState().rehydrate()
    setStorageScopeJid('a@example.com')
    ignoreStore.getState().rehydrate()

    expect(ignoreStore.getState().getIgnoredForRoom(ROOM_JID)).toEqual([alice])
  })
})
