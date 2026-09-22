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
import { createMockClient, localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

import { SessionLifecycleEngine, type SessionLifecycleDeps } from './sessionLifecycle'
import { createMockClientWithSDKEvents, createMockRoom, createMockStoreRefs, createMockStores, type MockStoreBindings } from './test-utils'
import type { Contact, StoreBindings } from './types'
import { createStoreBindings } from '../bindings/storeBindings'
import { eventsStore } from '../stores/eventsStore'
import { roomStore } from '../stores/roomStore'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { setupBackgroundSyncSideEffects } from './backgroundSync'
import { NS_MAM } from './namespaces'

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
  let emitFreshSessionInputsReady: ReturnType<typeof vi.fn>
  let connectPresence: ReturnType<typeof vi.fn>
  let unsubscribe: () => void

  beforeEach(() => {
    localStorageMock.clear()
    eventsStore.getState().reset()
    roomStore.getState().reset()
    modules = makeMockModules()
    stores = createMockStores()
    stores.connection.getStatus.mockReturnValue('online')
    stores.room.getRoom.mockImplementation(jid => roomStore.getState().getRoom(jid))
    stores.room.markAllRoomsNotJoined.mockImplementation(() => roomStore.getState().markAllRoomsNotJoined())
    const client = createMockClientWithSDKEvents()
    const refs = createMockStoreRefs()
    unsubscribe = createStoreBindings(client, () => ({
      ...refs, room: roomStore.getState(), events: eventsStore.getState(),
    }))
    ensureE2EEManager = vi.fn()
    emitOnline = vi.fn()
    emitFreshSessionInputsReady = vi.fn()
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
      emitFreshSessionInputsReady,
      emitConversationListReady: vi.fn(),
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

  describe('freshSessionInputsReady', () => {
    // Background archive sync waits on this signal. Every path below uses
    // fetches that are genuinely slow or genuinely failing under fake timers:
    // an immediate mock reply cannot tell a signal that waited for its inputs
    // from one that fired regardless.
    const MARKER = 'fluux:cache-marker:me@example.com/web'
    const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder[0]
    const after = <T,>(ms: number, value: T) =>
      () => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))
    const failAfter = (ms: number, message: string) =>
      () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms))

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('fires after the server list is merged, and merges it with roster names even when the list answers first', async () => {
      let rosterLoaded = false
      modules.roster.fetchRoster.mockImplementation(() =>
        new Promise<void>((resolve) => setTimeout(() => { rosterLoaded = true; resolve() }, 10_000)))
      modules.conversationSync.fetchConversations.mockImplementation(after(1_000, [
        { jid: 'alice@example.com', archived: false },
      ]))
      stores.roster.getContact.mockImplementation((jid: string) =>
        rosterLoaded && jid === 'alice@example.com'
          ? { jid, name: 'Alice Smith', presence: 'online', subscription: 'both' } as Contact
          : undefined)

      const done = engine.handleConnectionSuccess(false)
      await vi.advanceTimersByTimeAsync(5_000)
      // The list is in, the roster is not: nothing merged yet.
      expect(stores.chat.mergeServerConversations).not.toHaveBeenCalled()
      expect(emitFreshSessionInputsReady).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(6_000)
      await done

      expect(stores.chat.mergeServerConversations).toHaveBeenCalledWith([
        { id: 'alice@example.com', name: 'Alice Smith', type: 'chat', archived: false },
      ])
      expect(emitFreshSessionInputsReady).toHaveBeenCalledTimes(1)
      expect(order(stores.chat.mergeServerConversations)).toBeLessThan(order(emitFreshSessionInputsReady))
      expect(order(modules.discovery.fetchServerInfo)).toBeLessThan(order(emitFreshSessionInputsReady))
      expect(localStorageMock.getItem(MARKER)).toEqual(expect.any(String))
    })

    it('fires once when the conversation-list fetch times out, and setup carries on', async () => {
      modules.conversationSync.fetchConversations.mockImplementation(failAfter(15_000, 'list timeout'))

      const done = engine.handleConnectionSuccess(false)
      await vi.advanceTimersByTimeAsync(14_000)
      expect(emitFreshSessionInputsReady).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2_000)
      await done

      expect(emitFreshSessionInputsReady).toHaveBeenCalledTimes(1)
      expect(stores.chat.mergeServerConversations).not.toHaveBeenCalled()
      expect(modules.muc.discoverMucService).toHaveBeenCalledTimes(1)
    })

    it('signals settled inputs before rejecting a roster timeout without a cache marker', async () => {
      modules.roster.fetchRoster.mockImplementation(failAfter(15_000, 'roster timeout'))
      modules.conversationSync.fetchConversations.mockImplementation(after(2_000, [
        { jid: 'alice@example.com', archived: true },
      ]))

      const done = engine.handleConnectionSuccess(false)
      const outcome = done.then(() => 'resolved', (e: Error) => e.message)
      await vi.advanceTimersByTimeAsync(14_000)
      expect(emitFreshSessionInputsReady).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2_000)

      expect(await outcome).toBe('roster timeout')
      expect(emitFreshSessionInputsReady).toHaveBeenCalledTimes(1)
      expect(localStorageMock.getItem(MARKER)).toBeNull()
      expect(stores.chat.mergeServerConversations).toHaveBeenCalledWith([
        { id: 'alice@example.com', name: 'alice', type: 'chat', archived: true },
      ])
      expect(modules.muc.discoverMucService).not.toHaveBeenCalled()
    })

    it('starts archive sync with the merged list before a timed-out roster rejects the session', async () => {
      const client = createMockClient()
      chatStore.getState().reset()
      connectionStore.getState().reset()
      const cleanup = setupBackgroundSyncSideEffects(client)
      try {
        connectionStore.getState().setStatus('online')
        client._emit('online')
        connectionStore.getState().setServerInfo({ identities: [], domain: 'example.com', features: [NS_MAM] })
        const seen = vi.fn()
        client.internal.mam.catchUpAllConversations.mockImplementation(async () => {
          seen([...chatStore.getState().conversationEntities.keys()])
        })
        stores.chat.mergeServerConversations.mockImplementation(batch => chatStore.getState().mergeServerConversations(batch))
        emitFreshSessionInputsReady.mockImplementation(() => client._emit('freshSessionInputsReady'))
        modules.roster.fetchRoster.mockImplementation(failAfter(15_000, 'roster timeout'))
        modules.conversationSync.fetchConversations.mockImplementation(after(2_000, [
          { jid: 'alice@example.com', archived: false },
        ]))
        const done = engine.handleConnectionSuccess(false).catch((error: Error) => error.message)
        await vi.advanceTimersByTimeAsync(14_000)
        expect(client.internal.mam.catchUpAllConversations).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(2_000)
        expect(await done).toBe('roster timeout')
        expect(seen).toHaveBeenCalledExactlyOnceWith(['alice@example.com'])
        expect(localStorageMock.getItem(MARKER)).toBeNull()
      } finally {
        cleanup()
        chatStore.getState().reset()
        connectionStore.getState().reset()
      }
    })

    it('abandons remaining setup at its deadline after signalling inputs while live', async () => {
      // Each fetch stays within its own IQ timeout; together they pass 30 s.
      modules.roster.fetchRoster.mockImplementation(after(14_000, undefined))
      modules.roster.sendInitialPresence.mockImplementation(after(4_000, undefined))
      modules.muc.fetchBookmarks.mockImplementation(after(14_000, {
        roomsToAutojoin: [{ jid: 'room@conference.example.com', nick: 'me' }], allRoomJids: [],
      }))
      modules.conversationSync.fetchConversations.mockImplementation(after(1_000, [
        { jid: 'alice@example.com', archived: false },
      ]))

      const done = engine.handleConnectionSuccess(false)
      const outcome = done.then(() => 'resolved', (e: Error) => e.message)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(emitFreshSessionInputsReady).toHaveBeenCalledTimes(1)
      emitFreshSessionInputsReady.mockClear()
      await vi.advanceTimersByTimeAsync(15_500)
      expect(await outcome).toMatch(/timed out after 30s/)
      expect(localStorageMock.getItem(MARKER)).toBeNull()

      await vi.advanceTimersByTimeAsync(5_000)
      expect(emitFreshSessionInputsReady).not.toHaveBeenCalled()
      expect(modules.muc.autojoinRoom).not.toHaveBeenCalled()
      expect(modules.muc.queryRoomFeatures).not.toHaveBeenCalled()
      expect(modules.muc.discoverMucService).not.toHaveBeenCalled()
      // The list had arrived while the session was still current.
      expect(stores.chat.mergeServerConversations).toHaveBeenCalledTimes(1)
    })

    it('on a cache-cleared SM resume, emits online before setup and ready after it', async () => {
      localStorageMock.removeItem(MARKER)
      modules.roster.fetchRoster.mockImplementation(after(3_000, undefined))

      const done = engine.handleConnectionSuccess(true)
      await vi.advanceTimersByTimeAsync(100)
      expect(emitOnline).toHaveBeenCalledTimes(1)
      expect(emitFreshSessionInputsReady).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(3_000)
      await done

      expect(modules.roster.fetchRoster).toHaveBeenCalledTimes(1)
      expect(emitFreshSessionInputsReady).toHaveBeenCalledTimes(1)
      expect(order(emitOnline)).toBeLessThan(order(emitFreshSessionInputsReady))
      expect(localStorageMock.getItem(MARKER)).toEqual(expect.any(String))
    })

    it('on a cache-cleared SM resume whose roster times out, fails the session and writes no marker', async () => {
      localStorageMock.removeItem(MARKER)
      modules.roster.fetchRoster.mockImplementation(failAfter(15_000, 'roster timeout'))

      const done = engine.handleConnectionSuccess(true)
      const outcome = done.then(() => 'resolved', (e: Error) => e.message)
      await vi.advanceTimersByTimeAsync(14_000)
      expect(emitFreshSessionInputsReady).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2_000)

      expect(await outcome).toBe('roster timeout')
      expect(emitFreshSessionInputsReady).toHaveBeenCalledTimes(1)
      // No marker: the next connection, resumed or not, repeats fresh setup.
      expect(localStorageMock.getItem(MARKER)).toBeNull()
    })

    it('does not certify offline bookmark completion and upgrades the next SM resume', async () => {
      modules.roster.fetchRoster.mockImplementation(after(1_000, undefined))
      modules.conversationSync.fetchConversations.mockImplementation(after(1_000, [
        { jid: 'alice@example.com', archived: true },
      ]))
      modules.muc.fetchBookmarks.mockImplementationOnce(() =>
        failAfter(15_000, 'bookmark timeout')().catch(() => ({ roomsToAutojoin: [], allRoomJids: [] })))

      const done = engine.handleConnectionSuccess(false)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(modules.muc.fetchBookmarks).toHaveBeenCalledTimes(1)
      stores.connection.getStatus.mockReturnValue('reconnecting')
      emitFreshSessionInputsReady.mockClear()
      await vi.advanceTimersByTimeAsync(15_000)
      await done

      expect(localStorageMock.getItem(MARKER)).toBeNull()
      expect(emitFreshSessionInputsReady).not.toHaveBeenCalled()
      expect(modules.muc.discoverMucService).not.toHaveBeenCalled()

      stores.connection.getStatus.mockReturnValue('online')
      const resumed = engine.handleConnectionSuccess(true)
      await vi.advanceTimersByTimeAsync(2_000)
      await resumed
      expect(emitOnline).toHaveBeenCalledTimes(1)
      expect(modules.roster.fetchRoster).toHaveBeenCalledTimes(2)
      expect(emitFreshSessionInputsReady).toHaveBeenCalledTimes(1)
      expect(localStorageMock.getItem(MARKER)).toEqual(expect.any(String))
    })

    it('does not emit readiness when inputs settle after transport loss', async () => {
      modules.roster.fetchRoster.mockImplementation(after(10_000, undefined))
      modules.conversationSync.fetchConversations.mockImplementation(after(1_000, [
        { jid: 'alice@example.com', archived: true },
      ]))
      const done = engine.handleConnectionSuccess(false)
      await vi.advanceTimersByTimeAsync(2_000)
      stores.connection.getStatus.mockReturnValue('reconnecting')
      await vi.advanceTimersByTimeAsync(9_000)
      await done
      expect(stores.chat.mergeServerConversations).not.toHaveBeenCalled()
      expect(emitFreshSessionInputsReady).not.toHaveBeenCalled()
      expect(localStorageMock.getItem(MARKER)).toBeNull()
    })

    it('waits for a slower list after the roster fails before signalling or rejecting', async () => {
      modules.roster.fetchRoster.mockImplementation(failAfter(5_000, 'roster failed'))
      modules.conversationSync.fetchConversations.mockImplementation(after(10_000, [
        { jid: 'alice@example.com', archived: true },
      ]))
      const outcome = vi.fn()
      const done = engine.handleConnectionSuccess(false).then(outcome, outcome)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(outcome).not.toHaveBeenCalled()
      expect(emitFreshSessionInputsReady).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5_000)
      await done
      expect(stores.chat.mergeServerConversations).toHaveBeenCalledWith([
        { id: 'alice@example.com', name: 'alice', type: 'chat', archived: true },
      ])
      expect(emitFreshSessionInputsReady).toHaveBeenCalledTimes(1)
      expect(order(stores.chat.mergeServerConversations)).toBeLessThan(order(emitFreshSessionInputsReady))
      expect(order(emitFreshSessionInputsReady)).toBeLessThan(order(outcome))
      expect(outcome).toHaveBeenCalledWith(new Error('roster failed'))
      expect(localStorageMock.getItem(MARKER)).toBeNull()
    })

    it('does not fire on a plain SM resume', async () => {
      localStorageMock.setItem(MARKER, '123')

      const done = engine.handleConnectionSuccess(true)
      await vi.advanceTimersByTimeAsync(100)
      await done

      expect(emitFreshSessionInputsReady).not.toHaveBeenCalled()
      expect(modules.roster.fetchRoster).not.toHaveBeenCalled()
    })

    it('does not fire for a session superseded mid-chain', async () => {
      modules.roster.fetchRoster.mockImplementationOnce(after(10_000, undefined))
      const first = engine.handleConnectionSuccess(false)
      await vi.advanceTimersByTimeAsync(1_000)

      // A second connection supersedes the first while its roster is in flight.
      const second = engine.handleConnectionSuccess(false)
      await vi.advanceTimersByTimeAsync(100)
      await second
      expect(emitFreshSessionInputsReady).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10_000)
      await first
      expect(emitFreshSessionInputsReady).toHaveBeenCalledTimes(1)
    })
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
