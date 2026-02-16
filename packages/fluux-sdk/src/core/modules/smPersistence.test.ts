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
      sm.updateCache('sm-123', 42)
      expect(sm.getCache()).toEqual({ id: 'sm-123', inbound: 42 })
    })

    it('should clear cache', () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('sm-123', 42)
      sm.clearCache()
      expect(sm.getCache()).toBeNull()
    })
  })

  describe('getState', () => {
    it('should return live state from xmpp client when available', () => {
      const sm = new SmPersistence(createDeps())
      const xmpp = { streamManagement: { id: 'live-id', inbound: 10 } }

      const result = sm.getState(xmpp)
      expect(result).toEqual({ id: 'live-id', inbound: 10 })
    })

    it('should update cache from live state', () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('old-id', 5)

      const xmpp = { streamManagement: { id: 'live-id', inbound: 10 } }
      sm.getState(xmpp)

      expect(sm.getCache()).toEqual({ id: 'live-id', inbound: 10 })
    })

    it('should fall back to cache when xmpp is null', () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('cached-id', 7)

      expect(sm.getState(null)).toEqual({ id: 'cached-id', inbound: 7 })
    })

    it('should fall back to cache when SM has no id', () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('cached-id', 3)

      const xmpp = { streamManagement: { id: '', inbound: 0 } }
      expect(sm.getState(xmpp)).toEqual({ id: 'cached-id', inbound: 3 })
    })

    it('should return null when no cache and no live state', () => {
      const sm = new SmPersistence(createDeps())
      expect(sm.getState(null)).toBeNull()
    })
  })

  describe('persist', () => {
    it('should persist SM state and joined rooms to storage', async () => {
      const rooms = [{ jid: 'room@conf.example.com', nickname: 'me' }]
      const sm = new SmPersistence(createDeps({
        storageAdapter: mockStorage.adapter,
        getJoinedRooms: () => rooms,
      }))
      sm.updateCache('sm-abc', 15)

      await sm.persist('user@example.com', 'res1')

      expect(mockStorage.adapter.setSessionState).toHaveBeenCalledWith('user@example.com', {
        smId: 'sm-abc',
        smInbound: 15,
        resource: 'res1',
        timestamp: expect.any(Number),
        joinedRooms: rooms,
      })
    })

    it('should no-op when no storage adapter', async () => {
      const sm = new SmPersistence(createDeps())
      sm.updateCache('sm-abc', 15)
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
      sm.updateCache('sm-abc', 15)

      await expect(sm.persist('user@example.com', 'res1')).resolves.toBeUndefined()
    })
  })

  describe('persistNow', () => {
    const sessionKey = 'fluux:session:user@example.com'

    afterEach(() => {
      sessionStorage.removeItem(sessionKey)
    })

    it('should write to sessionStorage synchronously', () => {
      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      sm.updateCache('sm-sync', 20)

      sm.persistNow('user@example.com', 'res1')

      const stored = sessionStorage.getItem(sessionKey)
      expect(stored).toBeTruthy()
      const parsed = JSON.parse(stored!)
      expect(parsed.smId).toBe('sm-sync')
      expect(parsed.smInbound).toBe(20)
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
        resource: 'res1',
        timestamp: Date.now(),
        joinedRooms: [{ jid: 'room@conf.example.com', nickname: 'me' }],
      })

      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      const result = await sm.load('user@example.com')

      expect(result.smState).toEqual({ id: 'stored-id', inbound: 30 })
      expect(result.joinedRooms).toHaveLength(1)
    })

    it('should return null SM state for stale sessions', async () => {
      mockStorage.store.set('user@example.com', {
        smId: 'old-id',
        smInbound: 10,
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
        resource: 'res1',
        timestamp: Date.now() - 15 * 60 * 1000,
      })

      const sm = new SmPersistence(createDeps({ storageAdapter: mockStorage.adapter }))
      await sm.load('user@example.com')

      expect(mockStorage.adapter.clearSessionState).toHaveBeenCalledWith('user@example.com')
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
})
