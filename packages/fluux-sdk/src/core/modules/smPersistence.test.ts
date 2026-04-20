import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SmPersistence, type SmPersistenceDeps } from './smPersistence'
import type { StorageAdapter, SessionState } from '../types'

/** Create a mock StorageAdapter for testing. */
function createMockStorage() {
  const store = new Map<string, SessionState>()
  return {
    store,
    adapter: {
      getSessionState: vi.fn(async (jid: string) => store.get(jid) ?? null),
      setSessionState: vi.fn(async (jid: string, state: SessionState) => { store.set(jid, state) }),
      clearSessionState: vi.fn(async (jid: string) => { store.delete(jid) }),
      getCredentials: vi.fn(async () => null),
      setCredentials: vi.fn(async () => {}),
      clearCredentials: vi.fn(async () => {}),
    } satisfies StorageAdapter,
  }
}

function createDeps(overrides?: Partial<SmPersistenceDeps>): SmPersistenceDeps {
  return {
    storageAdapter: undefined,
    getJoinedRooms: () => [],
    console: { addEvent: vi.fn() },
    ...overrides,
  }
}

describe('SmPersistence', () => {
  let mockStorage: ReturnType<typeof createMockStorage>

  beforeEach(() => {
    mockStorage = createMockStorage()
  })

  describe('cache operations', () => {
    it('should start with null cache', () => {
      const sm = new SmPersistence(createDeps())
      expect(sm.getCache()).toBeNull()
    })

    it('should update and read cache', () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('sm-123', 42, 7)
      const cache = sm.getCache()
      expect(cache).toMatchObject({ id: 'sm-123', inbound: 42, outbound: 7 })
      expect(cache!.timestamp).toEqual(expect.any(Number))
    })

    it('should clear cache', () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('sm-123', 42, 7)
      sm.clearCache()
      expect(sm.getCache()).toBeNull()
    })

    it('should return null from getCache when cache is stale (> SM timeout)', () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('sm-123', 42, 7)

      vi.useFakeTimers()
      vi.advanceTimersByTime(11 * 60 * 1000)

      expect(sm.getCache()).toBeNull()

      vi.useRealTimers()
    })

    it('should return cache from getCache when within SM timeout', () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('sm-123', 42, 7)

      vi.useFakeTimers()
      vi.advanceTimersByTime(5 * 60 * 1000) // 5 minutes — within timeout

      expect(sm.getCache()).toMatchObject({ id: 'sm-123', inbound: 42, outbound: 7 })

      vi.useRealTimers()
    })
  })

  describe('getState', () => {
    it('should return live state from xmpp client when available', () => {
      const sm = new SmPersistence(createDeps())
      const xmpp = { streamManagement: { id: 'live-id', inbound: 10, outbound: 4, outbound_q: [] } }

      const result = sm.getState(xmpp)
      expect(result).toMatchObject({ id: 'live-id', inbound: 10, outbound: 4 })
      expect(result!.timestamp).toEqual(expect.any(Number))
    })

    it('should fold pending outbound_q items into outbound count', () => {
      const sm = new SmPersistence(createDeps())
      const xmpp = {
        streamManagement: {
          id: 'live-id',
          inbound: 10,
          outbound: 4,
          // 3 stanzas sent but not yet acked by server
          outbound_q: [{ stanza: {} }, { stanza: {} }, { stanza: {} }],
        },
      }

      // Server will report h = 7 (= 4 acked + 3 pending) on resume; we must hydrate
      // sm.outbound to 7 so ackQueue's loop runs 0 iterations against the empty
      // fresh-client queue.
      expect(sm.getState(xmpp)).toMatchObject({ outbound: 7 })
    })

    it('should update cache from live state', () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('old-id', 5, 2)

      const xmpp = { streamManagement: { id: 'live-id', inbound: 10, outbound: 4, outbound_q: [] } }
      sm.getState(xmpp)

      expect(sm.getCache()).toMatchObject({ id: 'live-id', inbound: 10, outbound: 4 })
    })

    it('should fall back to cache when xmpp is null', () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('cached-id', 7, 2)

      expect(sm.getState(null)).toMatchObject({ id: 'cached-id', inbound: 7, outbound: 2 })
    })

    it('should fall back to cache when SM has no id', () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('cached-id', 3, 1)

      const xmpp = { streamManagement: { id: '', inbound: 0, outbound: 0, outbound_q: [] } }
      expect(sm.getState(xmpp)).toMatchObject({ id: 'cached-id', inbound: 3, outbound: 1 })
    })

    it('should return null when no cache and no live state', () => {
      const sm = new SmPersistence(createDeps())
      expect(sm.getState(null)).toBeNull()
    })

    it('should return null when cache is stale (> SM timeout)', () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('old-id', 5, 1)

      // Simulate time passing beyond SM timeout (10 minutes)
      vi.useFakeTimers()
      vi.advanceTimersByTime(11 * 60 * 1000)

      expect(sm.getState(null)).toBeNull()

      vi.useRealTimers()
    })

    it('should return live state even when cache is stale', () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('old-id', 5, 1)

      // Advance past SM timeout
      vi.useFakeTimers()
      vi.advanceTimersByTime(11 * 60 * 1000)

      // Live client state should always be returned (it refreshes the cache)
      const xmpp = { streamManagement: { id: 'live-id', inbound: 20, outbound: 8, outbound_q: [] } }
      const result = sm.getState(xmpp)
      expect(result).toMatchObject({ id: 'live-id', inbound: 20, outbound: 8 })

      vi.useRealTimers()
    })
  })

  describe('persist', () => {
    it('should persist SM state and joined rooms to storage', async () => {
      const rooms = [{ jid: 'room@conf.example.com', nickname: 'me' }]
      const sm = new SmPersistence(createDeps({
        storageAdapter: mockStorage.adapter,
        getJoinedRooms: () => rooms,
      }))
      sm.updateCache('sm-abc', 15, 8)

      await sm.persist('user@example.com', 'res1')

      expect(mockStorage.adapter.setSessionState).toHaveBeenCalledWith('user@example.com', {
        smId: 'sm-abc',
        smInbound: 15,
        smOutbound: 8,
        resource: 'res1',
        timestamp: expect.any(Number),
        joinedRooms: rooms,
      })
    })

    it('should no-op when no storage adapter', async () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('sm-abc', 15, 8)
      await sm.persist('user@example.com', 'res1')
      // No error thrown
    })

    it('should no-op when no cache', async () => {
      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      await sm.persist('user@example.com', 'res1')
      expect(mockStorage.adapter.setSessionState).not.toHaveBeenCalled()
    })

    it('should swallow storage errors', async () => {
      mockStorage.adapter.setSessionState.mockRejectedValue(new Error('quota exceeded'))
      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      sm.updateCache('sm-abc', 15, 8)

      await expect(sm.persist('user@example.com', 'res1')).resolves.toBeUndefined()
    })

    it('should preserve existing rooms when current joinedRooms is empty', async () => {
      const existingRooms = [
        { jid: 'room1@conf.example.com', nickname: 'me' },
        { jid: 'room2@conf.example.com', nickname: 'me' },
      ]
      // Pre-populate storage with rooms from a previous session
      mockStorage.store.set('user@example.com', {
        smId: 'old-sm',
        smInbound: 10,
        smOutbound: 5,
        resource: 'res1',
        timestamp: Date.now() - 5000,
        joinedRooms: existingRooms,
      })

      // Current store returns no rooms (e.g. SM enabled before rooms joined)
      const sm = new SmPersistence(createDeps({
        storageAdapter: mockStorage.adapter,
        getJoinedRooms: () => [],
      }))
      sm.updateCache('new-sm', 0, 0)

      await sm.persist('user@example.com', 'res1')

      // Should update SM state but preserve the existing rooms
      expect(mockStorage.adapter.setSessionState).toHaveBeenCalledWith('user@example.com', {
        smId: 'new-sm',
        smInbound: 0,
        smOutbound: 0,
        resource: 'res1',
        timestamp: expect.any(Number),
        joinedRooms: existingRooms,
      })
    })

    it('should overwrite rooms when current joinedRooms is non-empty', async () => {
      const existingRooms = [
        { jid: 'room1@conf.example.com', nickname: 'me' },
        { jid: 'room2@conf.example.com', nickname: 'me' },
      ]
      mockStorage.store.set('user@example.com', {
        smId: 'old-sm',
        smInbound: 10,
        smOutbound: 5,
        resource: 'res1',
        timestamp: Date.now() - 5000,
        joinedRooms: existingRooms,
      })

      const currentRooms = [{ jid: 'room3@conf.example.com', nickname: 'me' }]
      const sm = new SmPersistence(createDeps({
        storageAdapter: mockStorage.adapter,
        getJoinedRooms: () => currentRooms,
      }))
      sm.updateCache('new-sm', 0, 0)

      await sm.persist('user@example.com', 'res1')

      // Should use current rooms, not preserved ones
      expect(mockStorage.adapter.setSessionState).toHaveBeenCalledWith('user@example.com', expect.objectContaining({
        joinedRooms: currentRooms,
      }))
    })

    it('should save empty rooms when no existing state in storage', async () => {
      // No pre-existing state in storage
      const sm = new SmPersistence(createDeps({
        storageAdapter: mockStorage.adapter,
        getJoinedRooms: () => [],
      }))
      sm.updateCache('new-sm', 0, 0)

      await sm.persist('user@example.com', 'res1')

      expect(mockStorage.adapter.setSessionState).toHaveBeenCalledWith('user@example.com', expect.objectContaining({
        joinedRooms: [],
      }))
    })
  })

  describe('persistNow', () => {
    const sessionKey = 'fluux:session:user@example.com'

    afterEach(() => {
      sessionStorage.removeItem(sessionKey)
    })

    it('should write to sessionStorage synchronously', () => {
      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      sm.updateCache('sm-sync', 20, 11)

      sm.persistNow('user@example.com', 'res1')

      const stored = sessionStorage.getItem(sessionKey)
      expect(stored).toBeTruthy()
      const parsed = JSON.parse(stored!)
      expect(parsed.smId).toBe('sm-sync')
      expect(parsed.smInbound).toBe(20)
      expect(parsed.smOutbound).toBe(11)
      expect(parsed.resource).toBe('res1')
      expect(parsed.timestamp).toEqual(expect.any(Number))
    })

    it('should no-op when no cache', () => {
      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))

      sm.persistNow('user@example.com', 'res1')

      expect(sessionStorage.getItem(sessionKey)).toBeNull()
    })
  })

  describe('load', () => {
    it('should load SM state from storage', async () => {
      mockStorage.store.set('user@example.com', {
        smId: 'stored-id',
        smInbound: 30,
        smOutbound: 12,
        resource: 'res1',
        timestamp: Date.now(),
        joinedRooms: [{ jid: 'room@conf.example.com', nickname: 'me' }],
      })

      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      const result = await sm.load('user@example.com')

      expect(result.smState).toMatchObject({ id: 'stored-id', inbound: 30, outbound: 12 })
      expect(result.joinedRooms).toHaveLength(1)
    })

    it('should return null SM state for stale sessions', async () => {
      mockStorage.store.set('user@example.com', {
        smId: 'old-id',
        smInbound: 10,
        smOutbound: 4,
        resource: 'res1',
        timestamp: Date.now() - 15 * 60 * 1000, // 15 minutes ago
        joinedRooms: [{ jid: 'room@conf.example.com', nickname: 'me' }],
      })

      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      const result = await sm.load('user@example.com')

      expect(result.smState).toBeNull()
      // Joined rooms should still be returned even if SM state is stale
      expect(result.joinedRooms).toHaveLength(1)
    })

    it('should clear stale state from storage', async () => {
      mockStorage.store.set('user@example.com', {
        smId: 'old-id',
        smInbound: 10,
        smOutbound: 4,
        resource: 'res1',
        timestamp: Date.now() - 15 * 60 * 1000,
      })

      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      await sm.load('user@example.com')

      expect(mockStorage.adapter.clearSessionState).toHaveBeenCalledWith('user@example.com')
    })

    it('should drop SM state when smOutbound is missing (pre-outbound persistence format)', async () => {
      // Legacy entries from before smOutbound was persisted — can't safely resume
      // because we have no idea what sm.outbound should be hydrated to. xmpp.js's
      // ackQueue would then crash on the first <resumed h=N/> where N > 0.
      mockStorage.store.set('user@example.com', {
        smId: 'legacy-id',
        smInbound: 7,
        resource: 'res1',
        timestamp: Date.now(),
        joinedRooms: [{ jid: 'room@conf.example.com', nickname: 'me' }],
      } as unknown as import('../types').SessionState)

      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      const result = await sm.load('user@example.com')

      expect(result.smState).toBeNull()
      // Rooms still returned so the app can rejoin after fresh bind
      expect(result.joinedRooms).toHaveLength(1)
    })

    it('should return empty result when no storage adapter', async () => {
      const sm = new SmPersistence(createDeps())
      const result = await sm.load('user@example.com')

      expect(result).toEqual({ smState: null, joinedRooms: [] })
    })

    it('should return empty result when no stored state', async () => {
      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      const result = await sm.load('unknown@example.com')

      expect(result).toEqual({ smState: null, joinedRooms: [] })
    })

    it('should swallow storage errors', async () => {
      mockStorage.adapter.getSessionState.mockRejectedValue(new Error('corrupt'))
      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))

      const result = await sm.load('user@example.com')
      expect(result).toEqual({ smState: null, joinedRooms: [] })
    })
  })

  describe('clear', () => {
    it('should clear SM state from storage', async () => {
      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      await sm.clear('user@example.com')

      expect(mockStorage.adapter.clearSessionState).toHaveBeenCalledWith('user@example.com')
    })

    it('should no-op when no storage adapter', async () => {
      const sm = new SmPersistence(createDeps())
      await expect(sm.clear('user@example.com')).resolves.toBeUndefined()
    })

    it('should swallow storage errors', async () => {
      mockStorage.adapter.clearSessionState.mockRejectedValue(new Error('io error'))
      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))

      await expect(sm.clear('user@example.com')).resolves.toBeUndefined()
    })
  })

  /**
   * End-to-end contract test for the post-reload SM resume flow.
   *
   * This is the scenario the old `patchSmAckQueue` workaround was defending:
   *   1. Client persists SM state (including total outbound count) before reload.
   *   2. Page reloads → fresh xmpp.js client, outbound_q starts empty.
   *   3. Client sends `<resume h=IN previd=.../>` and server replies `<resumed h=N/>`
   *      where N = what server saw us send.
   *   4. xmpp.js internally calls `ackQueue(N)` which does:
   *        for (let i = 0; i < +n - oldOutbound; i++) {
   *          const item = sm.outbound_q.shift(); // undefined if queue empty
   *          sm.outbound++;
   *          sm.emit('ack', item.stanza);        // TypeError on undefined
   *        }
   *
   * If we correctly hydrate `sm.outbound = N` from persisted state, the loop
   * runs zero iterations and the empty queue is never touched → no crash,
   * no sentinel required.
   */
  describe('post-reload resume hydration (no sentinel needed)', () => {
    /** Simulate xmpp.js's ackQueue(n) verbatim. */
    function simulateAckQueue(sm: { outbound: number; outbound_q: Array<{ stanza: unknown }> }, n: number): void {
      const oldOutbound = sm.outbound
      for (let i = 0; i < +n - oldOutbound; i++) {
        const item = sm.outbound_q.shift()
        sm.outbound++
        // ackQueue would emit 'ack' with item.stanza here; the crash is on `item.stanza`
        // when item is undefined. We just read .stanza to reproduce the exact access.
        void (item as { stanza: unknown }).stanza
      }
    }

    it('hydrates sm.outbound so ackQueue runs 0 iterations against empty queue', async () => {
      // 1. Pre-reload: a session where we sent 17 stanzas. Server acked 12;
      //    5 were still pending in outbound_q at the moment we captured state.
      const preReloadSm = {
        id: 'sid-abc',
        inbound: 9,
        outbound: 12,
        outbound_q: Array.from({ length: 5 }, () => ({ stanza: { name: 'message' } })),
      }
      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      sm.getState({ streamManagement: preReloadSm })
      await sm.persist('user@example.com', 'res1')

      // 2. Reload: spin up a brand-new persistence instance + fresh xmpp.js client.
      const sm2 = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      const loaded = await sm2.load('user@example.com')
      expect(loaded.smState).toMatchObject({ id: 'sid-abc', inbound: 9, outbound: 17 })

      const freshSm = { outbound: 0, outbound_q: [] as Array<{ stanza: unknown }> }

      // 3. Hydrate (mirrors Connection.hydrateStreamManagement's behavior).
      freshSm.outbound = loaded.smState!.outbound

      // 4. Server replies <resumed h=17/> — xmpp.js calls ackQueue(17).
      //    Without hydration, `17 - 0 = 17` iterations on an empty queue → crash.
      //    With hydration, `17 - 17 = 0` iterations → nothing touches the queue.
      expect(() => simulateAckQueue(freshSm, 17)).not.toThrow()
      expect(freshSm.outbound).toBe(17)
      expect(freshSm.outbound_q).toHaveLength(0)
    })

    it('handles server h lower than hydrated outbound (no-op loop)', async () => {
      // Defensive case: if server reports fewer stanzas than we persisted (e.g.
      // server lost state but we still try to resume), the loop runs 0 iterations
      // because `n - oldOutbound` is negative.
      const freshSm = { outbound: 17, outbound_q: [] as Array<{ stanza: unknown }> }
      expect(() => simulateAckQueue(freshSm, 5)).not.toThrow()
      expect(freshSm.outbound).toBe(17)
    })
  })
})
