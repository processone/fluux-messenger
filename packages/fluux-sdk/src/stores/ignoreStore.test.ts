import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock localStorage (needed by reset() which calls localStorage.removeItem directly)
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      store = {}
    }),
  }
})()

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Mock persist middleware as a pass-through so store works without real storage
vi.mock('zustand/middleware', () => ({
  persist: (fn: unknown) => fn,
}))

import { ignoreStore, isMessageFromIgnoredUser, isReplyToIgnoredUser } from './ignoreStore'

const ROOM_JID = 'room@conference.example.com'
const ROOM_JID_2 = 'room2@conference.example.com'

const alice = { identifier: 'occ-id-alice', displayName: 'Alice', jid: 'alice@example.com' }
const bob = { identifier: 'occ-id-bob', displayName: 'Bob', jid: 'bob@example.com' }
const charlie = { identifier: 'charlie-nick', displayName: 'Charlie' }

describe('ignoreStore', () => {
  beforeEach(() => {
    ignoreStore.getState().reset()
  })

  describe('addIgnored', () => {
    it('should add a user to the ignored list for a room', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)

      const ignored = ignoreStore.getState().ignoredUsers[ROOM_JID]
      expect(ignored).toHaveLength(1)
      expect(ignored![0]).toEqual(alice)
    })

    it('should add multiple users to the same room', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      ignoreStore.getState().addIgnored(ROOM_JID, bob)

      const ignored = ignoreStore.getState().ignoredUsers[ROOM_JID]
      expect(ignored).toHaveLength(2)
      expect(ignored![0]).toEqual(alice)
      expect(ignored![1]).toEqual(bob)
    })

    it('should not add duplicate users (same identifier)', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      ignoreStore.getState().addIgnored(ROOM_JID, alice)

      const ignored = ignoreStore.getState().ignoredUsers[ROOM_JID]
      expect(ignored).toHaveLength(1)
    })

    it('should allow same user in different rooms', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      ignoreStore.getState().addIgnored(ROOM_JID_2, alice)

      expect(ignoreStore.getState().ignoredUsers[ROOM_JID]).toHaveLength(1)
      expect(ignoreStore.getState().ignoredUsers[ROOM_JID_2]).toHaveLength(1)
    })

    it('should create the room key if it does not exist', () => {
      expect(ignoreStore.getState().ignoredUsers[ROOM_JID]).toBeUndefined()

      ignoreStore.getState().addIgnored(ROOM_JID, alice)

      expect(ignoreStore.getState().ignoredUsers[ROOM_JID]).toBeDefined()
    })
  })

  describe('removeIgnored', () => {
    it('should remove a user from the ignored list', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      ignoreStore.getState().addIgnored(ROOM_JID, bob)

      ignoreStore.getState().removeIgnored(ROOM_JID, alice.identifier)

      const ignored = ignoreStore.getState().ignoredUsers[ROOM_JID]
      expect(ignored).toHaveLength(1)
      expect(ignored![0]).toEqual(bob)
    })

    it('should delete the room key when last user is removed', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      ignoreStore.getState().removeIgnored(ROOM_JID, alice.identifier)

      expect(ignoreStore.getState().ignoredUsers[ROOM_JID]).toBeUndefined()
    })

    it('should not change state when removing non-existent identifier', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      const stateBefore = ignoreStore.getState().ignoredUsers

      ignoreStore.getState().removeIgnored(ROOM_JID, 'nonexistent')

      expect(ignoreStore.getState().ignoredUsers).toBe(stateBefore)
    })

    it('should not change state when room does not exist', () => {
      const stateBefore = ignoreStore.getState().ignoredUsers

      ignoreStore.getState().removeIgnored('no-such-room@example.com', alice.identifier)

      expect(ignoreStore.getState().ignoredUsers).toBe(stateBefore)
    })

    it('should not affect other rooms', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      ignoreStore.getState().addIgnored(ROOM_JID_2, bob)

      ignoreStore.getState().removeIgnored(ROOM_JID, alice.identifier)

      expect(ignoreStore.getState().ignoredUsers[ROOM_JID]).toBeUndefined()
      expect(ignoreStore.getState().ignoredUsers[ROOM_JID_2]).toHaveLength(1)
    })
  })

  describe('setIgnoredForRoom', () => {
    it('should replace the entire ignore list for a room', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      ignoreStore.getState().setIgnoredForRoom(ROOM_JID, [bob, charlie])

      const ignored = ignoreStore.getState().ignoredUsers[ROOM_JID]
      expect(ignored).toHaveLength(2)
      expect(ignored![0]).toEqual(bob)
      expect(ignored![1]).toEqual(charlie)
    })

    it('should delete the room key when setting empty list', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      ignoreStore.getState().setIgnoredForRoom(ROOM_JID, [])

      expect(ignoreStore.getState().ignoredUsers[ROOM_JID]).toBeUndefined()
    })

    it('should not affect other rooms', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      ignoreStore.getState().addIgnored(ROOM_JID_2, bob)

      ignoreStore.getState().setIgnoredForRoom(ROOM_JID, [charlie])

      expect(ignoreStore.getState().ignoredUsers[ROOM_JID]).toEqual([charlie])
      expect(ignoreStore.getState().ignoredUsers[ROOM_JID_2]).toEqual([bob])
    })
  })

  describe('isIgnored', () => {
    it('should return true for ignored user', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)

      expect(ignoreStore.getState().isIgnored(ROOM_JID, alice.identifier)).toBe(true)
    })

    it('should return false for non-ignored user', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)

      expect(ignoreStore.getState().isIgnored(ROOM_JID, bob.identifier)).toBe(false)
    })

    it('should return false for unknown room', () => {
      expect(ignoreStore.getState().isIgnored('no-such-room@example.com', alice.identifier)).toBe(false)
    })

    it('should return false after user is removed', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      ignoreStore.getState().removeIgnored(ROOM_JID, alice.identifier)

      expect(ignoreStore.getState().isIgnored(ROOM_JID, alice.identifier)).toBe(false)
    })
  })

  describe('getIgnoredForRoom', () => {
    it('should return the ignored users for a room', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      ignoreStore.getState().addIgnored(ROOM_JID, bob)

      const result = ignoreStore.getState().getIgnoredForRoom(ROOM_JID)
      expect(result).toHaveLength(2)
      expect(result).toEqual([alice, bob])
    })

    it('should return empty array for unknown room', () => {
      const result = ignoreStore.getState().getIgnoredForRoom('no-such-room@example.com')
      expect(result).toEqual([])
    })

    it('should return empty array after reset', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      ignoreStore.getState().reset()

      expect(ignoreStore.getState().getIgnoredForRoom(ROOM_JID)).toEqual([])
    })
  })

  describe('isMessageFromIgnoredUser', () => {
    it('should match by occupantId (highest priority)', () => {
      const ignored = [{ identifier: 'occ-alice', displayName: 'Alice', jid: 'alice@example.com' }]
      const msg = { occupantId: 'occ-alice', nick: 'Alice' }

      expect(isMessageFromIgnoredUser(ignored, msg)).toBe(true)
    })

    it('should match by nick when identifier is nick', () => {
      const ignored = [{ identifier: 'Alice', displayName: 'Alice' }]
      const msg = { nick: 'Alice' }

      expect(isMessageFromIgnoredUser(ignored, msg)).toBe(true)
    })

    it('should match by JID via nickToJidCache when identifier is bareJid', () => {
      const ignored = [{ identifier: 'alice@example.com', displayName: 'Alice', jid: 'alice@example.com' }]
      const msg = { nick: 'Alice' }
      const cache = new Map([['Alice', 'alice@example.com']])

      expect(isMessageFromIgnoredUser(ignored, msg, cache)).toBe(true)
    })

    it('should cross-match via jid field when identifier is occupantId (MAM history case)', () => {
      // Identifier is occupantId, message has no occupantId (old MAM message),
      // but the stored jid field can be matched via nickToJidCache
      const ignored = [{ identifier: 'occ-alice', displayName: 'Alice', jid: 'alice@example.com' }]
      const msg = { nick: 'Alice' } // No occupantId
      const cache = new Map([['Alice', 'alice@example.com']])

      expect(isMessageFromIgnoredUser(ignored, msg, cache)).toBe(true)
    })

    it('should not match unrelated users', () => {
      const ignored = [{ identifier: 'occ-alice', displayName: 'Alice', jid: 'alice@example.com' }]
      const msg = { occupantId: 'occ-bob', nick: 'Bob' }
      const cache = new Map([['Bob', 'bob@example.com']])

      expect(isMessageFromIgnoredUser(ignored, msg, cache)).toBe(false)
    })

    it('should return false for empty ignored list', () => {
      const msg = { occupantId: 'occ-alice', nick: 'Alice' }

      expect(isMessageFromIgnoredUser([], msg)).toBe(false)
    })

    it('should not match when no occupantId and no cache', () => {
      // Identifier is occupantId, message has no occupantId, no cache available
      const ignored = [{ identifier: 'occ-alice', displayName: 'Alice', jid: 'alice@example.com' }]
      const msg = { nick: 'Alice' }

      expect(isMessageFromIgnoredUser(ignored, msg)).toBe(false)
    })

    it('should match multiple ignored users', () => {
      const ignored = [
        { identifier: 'occ-alice', displayName: 'Alice' },
        { identifier: 'occ-bob', displayName: 'Bob' },
      ]
      const msgAlice = { occupantId: 'occ-alice', nick: 'Alice' }
      const msgBob = { occupantId: 'occ-bob', nick: 'Bob' }
      const msgCharlie = { occupantId: 'occ-charlie', nick: 'Charlie' }

      expect(isMessageFromIgnoredUser(ignored, msgAlice)).toBe(true)
      expect(isMessageFromIgnoredUser(ignored, msgBob)).toBe(true)
      expect(isMessageFromIgnoredUser(ignored, msgCharlie)).toBe(false)
    })
  })

  describe('isReplyToIgnoredUser', () => {
    const ROOM = 'room@conference.example.com'

    it('should return true when replyTo.to nick matches ignored nick identifier', () => {
      const ignored = [{ identifier: 'Alice', displayName: 'Alice' }]

      expect(isReplyToIgnoredUser(ignored, { to: `${ROOM}/Alice` })).toBe(true)
    })

    it('should return true when replyTo.to nick matches via nickToJidCache', () => {
      const ignored = [{ identifier: 'alice@example.com', displayName: 'Alice', jid: 'alice@example.com' }]
      const cache = new Map([['Alice', 'alice@example.com']])

      expect(isReplyToIgnoredUser(ignored, { to: `${ROOM}/Alice` }, cache)).toBe(true)
    })

    it('should return true when identifier is occupantId but jid cross-matches via cache', () => {
      const ignored = [{ identifier: 'occ-alice', displayName: 'Alice', jid: 'alice@example.com' }]
      const cache = new Map([['Alice', 'alice@example.com']])

      expect(isReplyToIgnoredUser(ignored, { to: `${ROOM}/Alice` }, cache)).toBe(true)
    })

    it('should return false when replyTo.to nick does not match any ignored user', () => {
      const ignored = [{ identifier: 'occ-alice', displayName: 'Alice' }]

      expect(isReplyToIgnoredUser(ignored, { to: `${ROOM}/Bob` })).toBe(false)
    })

    it('should return false when replyTo is undefined', () => {
      const ignored = [{ identifier: 'occ-alice', displayName: 'Alice' }]

      expect(isReplyToIgnoredUser(ignored, undefined)).toBe(false)
    })

    it('should return false when replyTo.to is undefined', () => {
      const ignored = [{ identifier: 'occ-alice', displayName: 'Alice' }]

      expect(isReplyToIgnoredUser(ignored, {})).toBe(false)
    })

    it('should return false for empty ignored list', () => {
      expect(isReplyToIgnoredUser([], { to: `${ROOM}/Alice` })).toBe(false)
    })

    it('should not match when identifier is occupantId without jid and no cache', () => {
      // occupantId-only identifier cannot match a nick from replyTo.to
      const ignored = [{ identifier: 'occ-alice', displayName: 'Alice' }]

      expect(isReplyToIgnoredUser(ignored, { to: `${ROOM}/Alice` })).toBe(false)
    })
  })

  describe('reset', () => {
    it('should clear all ignored users', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      ignoreStore.getState().addIgnored(ROOM_JID_2, bob)

      ignoreStore.getState().reset()

      expect(ignoreStore.getState().ignoredUsers).toEqual({})
    })

    it('should remove localStorage key', () => {
      ignoreStore.getState().addIgnored(ROOM_JID, alice)
      localStorageMock.removeItem.mockClear()

      ignoreStore.getState().reset()

      expect(localStorageMock.removeItem).toHaveBeenCalledWith('fluux-ignored-users')
    })

    it('should be idempotent', () => {
      ignoreStore.getState().reset()
      ignoreStore.getState().reset()

      expect(ignoreStore.getState().ignoredUsers).toEqual({})
    })
  })
})
