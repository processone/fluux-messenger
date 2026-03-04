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

import { ignoreStore } from './ignoreStore'

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
