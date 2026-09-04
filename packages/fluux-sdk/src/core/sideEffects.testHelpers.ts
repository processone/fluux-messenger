/**
 * Shared test helpers for side effects tests.
 *
 * Provides mock client with event emitter support and fresh session simulation.
 */
import { vi, type Mock } from 'vitest'
import { connectionStore } from '../stores/connectionStore'
import type { E2EEWarmupHost, SideEffectHost } from './sideEffectHost'

// Mock localStorage for tests that need it
export const localStorageMock = (() => {
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
    get _store() {
      return store
    },
  }
})()

/**
 * Shape of the mock built by {@link createMockClient}, annotated explicitly: a
 * bare `vi.fn()` infers as `Mock<Procedure>`, and `Procedure` is not part of
 * vitest's public export surface, so an inferred type here cannot be named
 * outside this package (TS2742).
 */
export interface MockSideEffectClient {
  messages: {
    queryMAM: Mock
    queryRoomMAM: Mock
  }
  internal: {
    on: Mock<(event: string, handler: (...args: unknown[]) => void) => () => boolean | undefined>
    mam: {
      refreshConversationPreviews: Mock
      refreshArchivedConversationPreviews: Mock
      catchUpAllConversations: Mock
      catchUpRoom: Mock
      catchUpConversationHistory: Mock
      catchUpRoomHistory: Mock
      discoverNewConversationsFromRoster: Mock
    }
  }
  rooms: {
    queryRoomMembers: Mock
  }
  server: {
    discoverMAMSearchCapability: Mock
  }
  isConnected: Mock
  retryPendingDecrypts: Mock
  e2ee: E2EEWarmupHost | null
  subscribe: Mock<(event: string, handler: (payload: unknown) => void) => () => boolean | undefined>
  /** Emit an internal (`on`/`emit`) event to the handlers registered above. */
  _emit: (event: string, ...args: unknown[]) => void
  /** Emit an SDK (`subscribe`/`emitSDK`) event to the handlers registered above. */
  _emitSDK: (event: string, payload: unknown) => void
}

/**
 * Create a minimal mock side-effect host with event emitter support.
 */
export function createMockClient(): MockSideEffectClient & SideEffectHost {
  // Internal events (on/emit pattern: 'online', 'resumed', etc.)
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  // SDK events (subscribe/emitSDK pattern: 'room:joined', 'chat:message', etc.)
  const sdkHandlers = new Map<string, Set<(payload: unknown) => void>>()

  const client: MockSideEffectClient = {
    messages: {
      queryMAM: vi.fn().mockResolvedValue(undefined),
      queryRoomMAM: vi.fn().mockResolvedValue(undefined),
    },
    internal: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (!handlers.has(event)) handlers.set(event, new Set())
        handlers.get(event)!.add(handler)
        return () => handlers.get(event)?.delete(handler)
      }),
      mam: {
        refreshConversationPreviews: vi.fn().mockResolvedValue(undefined),
        refreshArchivedConversationPreviews: vi.fn().mockResolvedValue(undefined),
        catchUpAllConversations: vi.fn().mockResolvedValue(undefined),
        catchUpRoom: vi.fn().mockResolvedValue(undefined),
        catchUpConversationHistory: vi.fn().mockResolvedValue(undefined),
        catchUpRoomHistory: vi.fn().mockResolvedValue(undefined),
        discoverNewConversationsFromRoster: vi.fn().mockResolvedValue(undefined),
      },
    },
    rooms: {
      queryRoomMembers: vi.fn().mockResolvedValue([]),
    },
    server: {
      discoverMAMSearchCapability: vi.fn().mockResolvedValue(undefined),
    },
    isConnected: vi.fn().mockReturnValue(true),
    retryPendingDecrypts: vi.fn().mockResolvedValue(0),
    e2ee: null,
    subscribe: vi.fn((event: string, handler: (payload: unknown) => void) => {
      if (!sdkHandlers.has(event)) sdkHandlers.set(event, new Set())
      sdkHandlers.get(event)!.add(handler)
      return () => sdkHandlers.get(event)?.delete(handler)
    }),
    // Helper for tests to emit internal events
    _emit: (event: string, ...args: unknown[]) => {
      handlers.get(event)?.forEach(h => h(...args))
    },
    // Helper for tests to emit SDK events
    _emitSDK: (event: string, payload: unknown) => {
      sdkHandlers.get(event)?.forEach(h => h(payload))
    },
  }

  return client as MockSideEffectClient & SideEffectHost
}

/**
 * Simulate a fresh session: set store status to 'online' and emit 'online' event.
 * In the real flow, Connection.ts does both in handleConnectionSuccess.
 */
export function simulateFreshSession(client: ReturnType<typeof createMockClient>) {
  connectionStore.getState().setStatus('online')
  client._emit('online')
}

/**
 * Simulate an SM resumption: set store status to 'online' and emit 'resumed' event.
 * In the real flow, Connection.ts does both in handleConnectionSuccess.
 */
export function simulateSmResumption(client: ReturnType<typeof createMockClient>) {
  connectionStore.getState().setStatus('online')
  client._emit('resumed')
}
