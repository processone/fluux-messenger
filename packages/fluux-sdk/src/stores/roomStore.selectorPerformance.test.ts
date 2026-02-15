import { describe, it, expect, beforeEach } from 'vitest'
import { roomStore } from './index'
import type { Room } from '../core/types'

function createRoom(jid: string, options: Partial<Room> = {}): Room {
  return {
    jid,
    name: options.name ?? jid.split('@')[0],
    nickname: options.nickname ?? 'testuser',
    joined: options.joined ?? false,
    isBookmarked: options.isBookmarked ?? false,
    occupants: options.occupants ?? new Map(),
    messages: options.messages ?? [],
    unreadCount: options.unreadCount ?? 0,
    mentionsCount: options.mentionsCount ?? 0,
    typingUsers: options.typingUsers ?? new Set(),
    lastInteractedAt: options.lastInteractedAt,
  }
}

describe('roomStore selector performance', () => {
  beforeEach(() => {
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
    })
  })

  it('allRooms() with 500 rooms completes in under 50ms', () => {
    // Populate with 500 rooms (250 bookmarked, 250 joined)
    for (let i = 0; i < 500; i++) {
      roomStore.getState().addRoom(
        createRoom(`room-${String(i).padStart(3, '0')}@conference.example.com`, {
          joined: i < 250,
          isBookmarked: i >= 250,
          lastInteractedAt: new Date(Date.now() - i * 60000),
        })
      )
    }

    // Warm up
    roomStore.getState().allRooms()

    // Benchmark
    const start = performance.now()
    const iterations = 100
    for (let i = 0; i < iterations; i++) {
      roomStore.getState().allRooms()
    }
    const elapsed = performance.now() - start
    const avgMs = elapsed / iterations

    expect(avgMs).toBeLessThan(50)
    expect(roomStore.getState().allRooms().length).toBe(500)
  })

  it('joinedRooms() with 500 rooms completes in under 50ms', () => {
    for (let i = 0; i < 500; i++) {
      roomStore.getState().addRoom(
        createRoom(`room-${String(i).padStart(3, '0')}@conference.example.com`, {
          joined: i < 250,
          isBookmarked: true,
        })
      )
    }

    // Warm up
    roomStore.getState().joinedRooms()

    const start = performance.now()
    const iterations = 100
    for (let i = 0; i < iterations; i++) {
      roomStore.getState().joinedRooms()
    }
    const elapsed = performance.now() - start
    const avgMs = elapsed / iterations

    expect(avgMs).toBeLessThan(50)
    expect(roomStore.getState().joinedRooms().length).toBe(250)
  })

  it('allRooms() sort is deterministic', () => {
    // Create rooms with specific timestamps
    for (let i = 0; i < 50; i++) {
      roomStore.getState().addRoom(
        createRoom(`room-${String(i).padStart(2, '0')}@conference.example.com`, {
          isBookmarked: true,
          lastInteractedAt: new Date(Date.now() - i * 60000),
        })
      )
    }

    const result1 = roomStore.getState().allRooms()
    const result2 = roomStore.getState().allRooms()

    // Same order both times
    expect(result1.map(r => r.jid)).toEqual(result2.map(r => r.jid))
    // With memoization: same reference when rooms Map hasn't changed
    expect(result1).toBe(result2)
  })

  it('memoized selectors return same reference on repeated calls without state change', () => {
    for (let i = 0; i < 10; i++) {
      roomStore.getState().addRoom(
        createRoom(`room-${i}@conference.example.com`, {
          joined: true,
          isBookmarked: true,
        })
      )
    }

    // First call populates cache
    const joined1 = roomStore.getState().joinedRooms()
    const all1 = roomStore.getState().allRooms()
    const bookmarked1 = roomStore.getState().bookmarkedRooms()

    // Second call should return cached reference (rooms Map hasn't changed)
    const joined2 = roomStore.getState().joinedRooms()
    const all2 = roomStore.getState().allRooms()
    const bookmarked2 = roomStore.getState().bookmarkedRooms()

    expect(joined1).toBe(joined2)
    expect(all1).toBe(all2)
    expect(bookmarked1).toBe(bookmarked2)
  })

  it('memoized selectors return new reference after state mutation', () => {
    for (let i = 0; i < 5; i++) {
      roomStore.getState().addRoom(
        createRoom(`room-${i}@conference.example.com`, {
          joined: true,
          isBookmarked: true,
        })
      )
    }

    const joined1 = roomStore.getState().joinedRooms()

    // Add another room — rooms Map changes
    roomStore.getState().addRoom(
      createRoom('room-new@conference.example.com', { joined: true, isBookmarked: true })
    )

    const joined2 = roomStore.getState().joinedRooms()

    // Should be different reference (state changed)
    expect(joined1).not.toBe(joined2)
    expect(joined2.length).toBe(6)
  })

  it('empty store returns stable EMPTY_ROOM_ARRAY references', () => {
    const joined1 = roomStore.getState().joinedRooms()
    const joined2 = roomStore.getState().joinedRooms()
    const bookmarked1 = roomStore.getState().bookmarkedRooms()
    const bookmarked2 = roomStore.getState().bookmarkedRooms()
    const all1 = roomStore.getState().allRooms()
    const all2 = roomStore.getState().allRooms()

    // Empty arrays should be the same reference (not new [] each time)
    expect(joined1).toBe(joined2)
    expect(bookmarked1).toBe(bookmarked2)
    expect(all1).toBe(all2)
  })
})
