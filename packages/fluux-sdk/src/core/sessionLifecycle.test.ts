/**
 * SessionLifecycleEngine unit tests.
 *
 * The engine orchestrates everything that happens after a successful
 * connection: it routes to the SM-resumption or fresh-session path, owns the
 * monotonic session-generation guard, and merges the server conversation list.
 * It drives its collaborators (modules, stores) exclusively through injected
 * dependencies, so these tests pin the two behaviours most likely to break in
 * an extraction — the resume-vs-fresh dispatch and the server-conversation
 * merge mapping — using mock modules the global client never sees.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

import { SessionLifecycleEngine, type SessionLifecycleDeps } from './sessionLifecycle'
import { createMockClientWithSDKEvents, createMockRoom, createMockStoreRefs, createMockStores, type MockStoreBindings } from './test-utils'
import type { StoreBindings } from './types'
import { createStoreBindings } from '../bindings/storeBindings'
import { eventsStore } from '../stores/eventsStore'
import { roomStore } from '../stores/roomStore'

/** Minimal module mocks — only the methods the engine actually calls. */
function makeMockModules() {
  return {
    discovery: {
      resetSessionCache: vi.fn(),
      fetchServerInfo: vi.fn().mockResolvedValue(undefined),
      discoverHttpUploadService: vi.fn().mockResolvedValue(undefined),
    },
    admin: { discoverAdminCommands: vi.fn().mockResolvedValue(undefined) },
    roster: {
      fetchRoster: vi.fn().mockResolvedValue(undefined),
      sendInitialPresence: vi.fn().mockResolvedValue(undefined),
      sendPresenceProbes: vi.fn().mockResolvedValue(undefined),
    },
    muc: {
      fetchBookmarks: vi.fn().mockResolvedValue({ roomsToAutojoin: [], allRoomJids: [] }),
      joinRoom: vi.fn().mockResolvedValue(undefined),
      autojoinRoom: vi.fn().mockResolvedValue(undefined),
      discoverMucService: vi.fn().mockResolvedValue(undefined),
      rejoinActiveRooms: vi.fn().mockResolvedValue(undefined),
      queryRoomFeatures: vi.fn().mockResolvedValue(null),
    },
    profile: {
      refreshAllAvatarBlobUrls: vi.fn().mockResolvedValue(undefined),
      fetchOwnProfile: vi.fn().mockResolvedValue(undefined),
      restoreAllRoomAvatarHashes: vi.fn().mockResolvedValue(undefined),
    },
    webPush: { queryServices: vi.fn().mockResolvedValue(undefined) },
    conversationSync: { fetchConversations: vi.fn().mockResolvedValue([]) },
  }
}

describe('SessionLifecycleEngine', () => {
  let modules: ReturnType<typeof makeMockModules>
  let stores: MockStoreBindings
  let engine: SessionLifecycleEngine
  let ensureE2EEManager: ReturnType<typeof vi.fn>
  let emitOnline: ReturnType<typeof vi.fn>
  let connectPresence: ReturnType<typeof vi.fn>
  let unsubscribe: () => void

  beforeEach(() => {
    localStorageMock.clear()
    eventsStore.getState().reset()
    roomStore.getState().reset()
    modules = makeMockModules()
    stores = createMockStores()
    stores.room.getRoom.mockImplementation(jid => roomStore.getState().getRoom(jid))
    stores.room.markAllRoomsNotJoined.mockImplementation(() => roomStore.getState().markAllRoomsNotJoined())
    const client = createMockClientWithSDKEvents()
    const refs = createMockStoreRefs()
    unsubscribe = createStoreBindings(client, () => ({
      ...refs, room: roomStore.getState(), events: eventsStore.getState(),
    }))
    ensureE2EEManager = vi.fn()
    emitOnline = vi.fn()
    connectPresence = vi.fn()
    const deps = {
      ...modules,
      getStores: () => stores as unknown as StoreBindings,
      getCurrentJid: () => 'me@example.com/web',
      getXmpp: () => null,
      ensureE2EEManager,
      sendStanza: vi.fn().mockResolvedValue(undefined),
      emitSDK: client.emit,
      emitOnline,
      connectPresence,
    } as unknown as SessionLifecycleDeps
    engine = new SessionLifecycleEngine(deps)
  })

  afterEach(() => {
    unsubscribe()
    eventsStore.getState().reset()
    roomStore.getState().reset()
  })

  it('routes a fresh connection through the fresh-session path (roster fetch, carbons)', async () => {
    await engine.handleConnectionSuccess(false)

    expect(connectPresence).toHaveBeenCalledTimes(1)
    expect(ensureE2EEManager).toHaveBeenCalledTimes(1)
    // Fresh session fetches the roster; SM resumption never does.
    expect(modules.roster.fetchRoster).toHaveBeenCalledTimes(1)
    expect(engine.isSmResumed()).toBe(false)
  })

  it('routes an SM resumption without re-fetching the roster', async () => {
    // Cache marker present → normal resume path (no full-sync upgrade).
    localStorageMock.setItem('fluux:cache-marker:me@example.com/web', '123')

    await engine.handleConnectionSuccess(true)

    expect(modules.roster.fetchRoster).not.toHaveBeenCalled()
    expect(modules.roster.sendInitialPresence).toHaveBeenCalledTimes(1)
    expect(engine.isSmResumed()).toBe(true)
  })

  it('increments the session generation on each connection so a stale run can bail', async () => {
    await engine.handleConnectionSuccess(false)
    await engine.handleConnectionSuccess(false)
    // Two connections → generation advanced twice; roster fetched once per fresh pass.
    expect(modules.roster.fetchRoster).toHaveBeenCalledTimes(2)
  })

  describe('voice state at the session membership boundary', () => {
    const roomJid = 'room@conference.example.com'
    const request = { roomJid, id: 'voice-1', jid: 'visitor@example.com/mobile', nick: 'Visitor' }
    const previousRooms = [{ jid: roomJid, nickname: 'Mod', autojoin: true }]

    beforeEach(() => {
      roomStore.getState().addRoom(createMockRoom(roomJid, { joined: true, autojoin: true }))
      eventsStore.getState().addVoiceRequest(request)
      eventsStore.getState().setVoiceRequestStatus(roomJid, {
        status: 'error', error: 'Forbidden', requestId: request.id,
      })
      eventsStore.getState().setVoiceRequestStatus('other@conference.example.com', { status: 'sent' })
      modules.muc.fetchBookmarks.mockResolvedValue({
        roomsToAutojoin: [{ jid: roomJid, nick: 'Mod' }], allRoomJids: [roomJid],
      })
      modules.muc.queryRoomFeatures.mockResolvedValue({ isNonAnonymous: true, isPrivate: false })
    })

    it('clears voice state when a fresh session resets a room that privacy prevents rejoining', async () => {
      eventsStore.getState().addSubscriptionRequest('contact@example.com')
      const subscriptions = eventsStore.getState().subscriptionRequests

      await engine.handleConnectionSuccess(false, previousRooms)
      await vi.waitFor(() => expect(stores.room.isNonAnonymousRoomAcknowledged).toHaveBeenCalledWith(roomJid))

      expect(roomStore.getState().getRoom(roomJid)?.joined).toBe(false)
      expect(modules.muc.autojoinRoom).not.toHaveBeenCalled()
      expect(modules.muc.rejoinActiveRooms).not.toHaveBeenCalled()
      expect(eventsStore.getState()).toMatchObject({ voiceRequests: [], voiceRequestStatuses: {} })
      expect(eventsStore.getState().subscriptionRequests).toBe(subscriptions)
    })

    it.each([5_000, 180_000])('preserves voice state after successful resumption with a %i ms disconnect', async disconnectDurationMs => {
      localStorageMock.setItem('fluux:cache-marker:me@example.com/web', '123')
      const { voiceRequests, voiceRequestStatuses } = eventsStore.getState()

      await engine.handleConnectionSuccess(true, previousRooms, disconnectDurationMs)

      expect(engine.isSmResumed()).toBe(true)
      expect(roomStore.getState().getRoom(roomJid)?.joined).toBe(true)
      expect(eventsStore.getState().voiceRequests).toBe(voiceRequests)
      expect(eventsStore.getState().voiceRequestStatuses).toBe(voiceRequestStatuses)
    })
  })

  // Issue #1126: unattended rejoining of a password-protected room depends on
  // the bookmark's password reaching the join on connect.
  it('autojoins a bookmarked room with its stored password', async () => {
    modules.muc.fetchBookmarks.mockResolvedValue({
      roomsToAutojoin: [{ jid: 'secret@conference.example.com', nick: 'mynick', password: 'from-bookmark' }],
      allRoomJids: ['secret@conference.example.com'],
    })

    await engine.handleConnectionSuccess(false)
    // The autojoin runs in a detached async task after a disco#info probe.
    await vi.waitFor(() => expect(modules.muc.autojoinRoom).toHaveBeenCalled())

    expect(modules.muc.autojoinRoom).toHaveBeenCalledWith(
      'secret@conference.example.com',
      'mynick',
      expect.objectContaining({ password: 'from-bookmark' })
    )
  })

  it('merges the server conversation list through the injected chat binding', () => {
    stores.roster.getContact.mockReturnValue(undefined)

    engine.mergeServerConversations([
      { jid: 'alice@example.com', archived: true },
      { jid: 'bob@example.com', archived: false },
    ])

    expect(stores.chat.mergeServerConversations).toHaveBeenCalledTimes(1)
    const batch = stores.chat.mergeServerConversations.mock.calls[0][0]
    expect(batch).toEqual([
      { id: 'alice@example.com', name: 'alice', type: 'chat', archived: true },
      { id: 'bob@example.com', name: 'bob', type: 'chat', archived: false },
    ])
  })
})
