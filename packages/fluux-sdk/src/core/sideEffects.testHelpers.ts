/**
 * Shared test helpers for side effects tests.
 *
 * Provides mock client with event emitter support and fresh session simulation.
 */
import { vi } from 'vitest'
import { connectionStore } from '../stores/connectionStore'
import type { XMPPClient } from './XMPPClient'

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
 * Create a minimal mock XMPPClient with event emitter support.
 */
export function createMockClient() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()

  const client = {
    chat: {
      queryMAM: vi.fn().mockResolvedValue(undefined),
      queryRoomMAM: vi.fn().mockResolvedValue(undefined),
    },
    mam: {
      refreshConversationPreviews: vi.fn().mockResolvedValue(undefined),
      refreshArchivedConversationPreviews: vi.fn().mockResolvedValue(undefined),
      catchUpAllConversations: vi.fn().mockResolvedValue(undefined),
      catchUpAllRooms: vi.fn().mockResolvedValue(undefined),
      discoverNewConversationsFromRoster: vi.fn().mockResolvedValue(undefined),
    },
    isConnected: vi.fn().mockReturnValue(true),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(handler)
      return () => handlers.get(event)?.delete(handler)
    }),
    // Helper for tests to emit events
    _emit: (event: string, ...args: unknown[]) => {
      handlers.get(event)?.forEach(h => h(...args))
    },
  }

  return client as typeof client & XMPPClient
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
