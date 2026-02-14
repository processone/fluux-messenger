/**
 * Tests for background sync side effects.
 *
 * Verifies the multi-stage background process that runs after a fresh session:
 * - Preview refresh
 * - Conversation catch-up
 * - Roster discovery
 * - Room catch-up (delayed)
 * - Daily archived conversation check
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock localStorage before importing stores
import { localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Mock messageCache to prevent IndexedDB operations
vi.mock('../utils/messageCache', () => ({
  saveRoomMessage: vi.fn().mockResolvedValue(undefined),
  saveRoomMessages: vi.fn().mockResolvedValue(undefined),
  getRoomMessages: vi.fn().mockResolvedValue([]),
  getRoomMessage: vi.fn().mockResolvedValue(null),
  getRoomMessageByStanzaId: vi.fn().mockResolvedValue(null),
  updateRoomMessage: vi.fn().mockResolvedValue(undefined),
  deleteRoomMessage: vi.fn().mockResolvedValue(undefined),
  deleteRoomMessages: vi.fn().mockResolvedValue(undefined),
  saveMessage: vi.fn().mockResolvedValue(undefined),
  saveMessages: vi.fn().mockResolvedValue(undefined),
  getMessages: vi.fn().mockResolvedValue([]),
  getMessage: vi.fn().mockResolvedValue(null),
  getMessageByStanzaId: vi.fn().mockResolvedValue(null),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  deleteConversationMessages: vi.fn().mockResolvedValue(undefined),
  clearAllMessages: vi.fn().mockResolvedValue(undefined),
  isMessageCacheAvailable: vi.fn().mockReturnValue(false),
  getOldestMessageTimestamp: vi.fn().mockResolvedValue(null),
  getOldestRoomMessageTimestamp: vi.fn().mockResolvedValue(null),
  getMessageCount: vi.fn().mockResolvedValue(0),
  getRoomMessageCount: vi.fn().mockResolvedValue(0),
  flushPendingRoomMessages: vi.fn().mockResolvedValue(undefined),
}))

import { setupBackgroundSyncSideEffects } from './backgroundSync'
import { connectionStore } from '../stores/connectionStore'
import { NS_MAM } from './namespaces'
import { createMockClient, simulateFreshSession } from './sideEffects.testHelpers'

describe('setupBackgroundSyncSideEffects', () => {
  const ARCHIVED_CHECK_KEY = 'fluux:lastArchivedPreviewCheck'
  let mockClient: ReturnType<typeof createMockClient>
  let cleanup: () => void

  beforeEach(() => {
    connectionStore.getState().reset()
    mockClient = createMockClient()
    localStorageMock.clear()
  })

  afterEach(() => {
    cleanup?.()
  })

  describe('preview refresh on connect', () => {
    it('should trigger refreshConversationPreviews when going online with MAM support', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.mam.refreshConversationPreviews).toHaveBeenCalledTimes(1)
      })
    })

    it('should defer preview refresh to serverInfo discovery when MAM not immediately available', async () => {
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.mam.refreshConversationPreviews).not.toHaveBeenCalled()

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      await vi.waitFor(() => {
        expect(mockClient.mam.refreshConversationPreviews).toHaveBeenCalledTimes(1)
      })
    })

    it('should not double-trigger preview refresh', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.mam.refreshConversationPreviews).toHaveBeenCalledTimes(1)
      })

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM, 'some:other:feature'],
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.mam.refreshConversationPreviews).toHaveBeenCalledTimes(1)
    })

    it('should reset and re-trigger after disconnect/reconnect cycle', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      await vi.waitFor(() => {
        expect(mockClient.mam.refreshConversationPreviews).toHaveBeenCalledTimes(1)
      })

      connectionStore.getState().setStatus('disconnected')

      simulateFreshSession(mockClient)
      await vi.waitFor(() => {
        expect(mockClient.mam.refreshConversationPreviews).toHaveBeenCalledTimes(2)
      })
    })
  })

  describe('daily archived check', () => {
    it('should trigger refreshArchivedConversationPreviews on first connect (no localStorage entry)', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.mam.refreshArchivedConversationPreviews).toHaveBeenCalledTimes(1)
      })
    })

    it('should skip archived check if less than 24h since last check', async () => {
      localStorageMock.setItem(ARCHIVED_CHECK_KEY, String(Date.now() - 1000))

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.mam.refreshConversationPreviews).toHaveBeenCalledTimes(1)
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.mam.refreshArchivedConversationPreviews).not.toHaveBeenCalled()
    })

    it('should trigger archived check after 24h', async () => {
      const staleTimestamp = Date.now() - (25 * 60 * 60 * 1000)
      localStorageMock.setItem(ARCHIVED_CHECK_KEY, String(staleTimestamp))

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.mam.refreshArchivedConversationPreviews).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('background catch-up on connect', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should trigger catchUpAllConversations after preview refresh completes', async () => {
      ;(mockClient.mam.refreshConversationPreviews as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledWith({ concurrency: 2 })
    })

    it('should trigger catchUpAllRooms after a delay', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(mockClient.mam.catchUpAllRooms).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(10_000)

      expect(mockClient.mam.catchUpAllRooms).toHaveBeenCalledTimes(1)
      expect(mockClient.mam.catchUpAllRooms).toHaveBeenCalledWith({ concurrency: 2 })
    })

    it('should cancel room catch-up timer on disconnect', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.advanceTimersByTimeAsync(5_000)
      connectionStore.getState().setStatus('disconnected')

      await vi.advanceTimersByTimeAsync(10_000)

      expect(mockClient.mam.catchUpAllRooms).not.toHaveBeenCalled()
    })

    it('should trigger discoverNewConversationsFromRoster on connect', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.advanceTimersByTimeAsync(100)
      expect(mockClient.mam.discoverNewConversationsFromRoster).toHaveBeenCalledTimes(1)
      expect(mockClient.mam.discoverNewConversationsFromRoster).toHaveBeenCalledWith({ concurrency: 2 })
    })

    it('should re-trigger catch-up on reconnect', async () => {
      ;(mockClient.mam.refreshConversationPreviews as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpAllRooms).toHaveBeenCalledTimes(1)
      })

      connectionStore.getState().setStatus('disconnected')

      simulateFreshSession(mockClient)
      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(2)
      })

      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpAllRooms).toHaveBeenCalledTimes(2)
      })
    })
  })
})
