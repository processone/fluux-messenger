/**
 * Session order trace.
 *
 * Guardrail for the post-connect pipeline: the session lifecycle engine and
 * every side effect that reacts to a session starting run together against one
 * client bus, and each scenario's ordered trace of what they did is pinned.
 * A trace lists the engine's calls to its modules and what the side effects
 * ask of the client (archive catch-up, read-marker fetch, saved-messages
 * fetch, conversation list refresh, ...), plus the catch-up indicator.
 *
 * Scenarios: fresh session, stream-management resume, resume upgraded to fresh
 * (the local cache was cleared), and a disconnect in the middle of setup.
 *
 * Only `startSession` knows how a session announces itself to the side
 * effects, so the traces stay comparable when that announcement changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockClient, localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

import { SessionLifecycleEngine, type SessionLifecycleDeps } from './sessionLifecycle'
import { createMockStores } from './test-utils'
import type { StoreBindings } from './types'
import { connectionStore } from '../stores/connectionStore'
import { chatStore } from '../stores/chatStore'
import { roomStore } from '../stores/roomStore'
import { rosterStore } from '../stores/rosterStore'
import { setupChatSideEffects } from './chatSideEffects'
import { setupRoomSideEffects } from './roomSideEffects'
import { setupBackgroundSyncSideEffects } from './backgroundSync'
import { setupMdsSideEffects } from './mdsSideEffects'
import { setupConversationSyncSideEffects } from './conversationSyncSideEffects'
import { setupSavedMessagesSideEffects } from './savedMessagesSideEffects'
import { NS_MAM } from './namespaces'
import type { Room, RoomMessage } from './types/room'

const OWN = 'me@example.com'
const MARKER = `fluux:cache-marker:${OWN}/web`
const PEER = 'alice@example.com'
const ROOM = 'team@conference.example.com'
/** A joined room the user is not looking at: the one a resume seeds from the archive. */
const OTHER_ROOM = 'lounge@conference.example.com'

describe('session order trace', () => {
  let trace: string[]
  let client: ReturnType<typeof createMockClient>
  let engine: SessionLifecycleEngine
  let stores: ReturnType<typeof createMockStores>
  let stops: Array<() => void>
  let unsubscribeCatchUp: () => void

  const record = (label: string, result?: unknown) => vi.fn(async () => { trace.push(label); return result })

  function makeModules() {
    return {
      discovery: {
        resetSessionCache: vi.fn(() => { trace.push('discovery.resetSessionCache') }),
        fetchServerInfo: record('discovery.fetchServerInfo'),
        discoverHttpUploadService: record('discovery.discoverHttpUploadService'),
      },
      admin: { discoverAdminCommands: record('admin.discoverAdminCommands') },
      roster: {
        fetchRoster: record('roster.fetchRoster'),
        sendInitialPresence: record('roster.sendInitialPresence'),
        sendPresenceProbes: record('roster.sendPresenceProbes'),
      },
      muc: {
        fetchBookmarks: vi.fn(async () => { trace.push('muc.fetchBookmarks'); return { roomsToAutojoin: [], allRoomJids: [] } }),
        autojoinRoom: record('muc.autojoinRoom'),
        discoverMucService: record('muc.discoverMucService'),
        rejoinActiveRooms: record('muc.rejoinActiveRooms'),
        queryRoomFeatures: vi.fn().mockResolvedValue(null),
        queueRoomJoin: vi.fn(() => vi.fn()),
      },
      profile: {
        refreshAllAvatarBlobUrls: record('profile.refreshAllAvatarBlobUrls'),
        fetchOwnProfile: record('profile.fetchOwnProfile'),
        restoreAllRoomAvatarHashes: record('profile.restoreAllRoomAvatarHashes'),
      },
      push: {
        queryServices: vi.fn().mockResolvedValue(undefined),
        checkSupport: record('push.checkSupport'),
      },
      conversationSync: { fetchConversations: record('conversationSync.fetchConversations', []) },
    }
  }

  /**
   * One session starting, as the transport reports it. `resume` is a stream
   * resumed (the engine upgrades it to a fresh session when the cache marker
   * is gone); anything else is a fresh stream.
   */
  async function startSession(resume: boolean, disconnectDurationMs?: number): Promise<void> {
    client._emit(resume ? 'resumed' : 'online')
    await engine.handleConnectionSuccess(resume, undefined, disconnectDurationMs)
  }

  /** The room's own presence comes back: the active room fetches its archive unless the session already holds it. */
  async function confirmRoomJoin(): Promise<void> {
    trace.push('--- room join confirmed ---')
    roomStore.getState().markAllRoomsNotJoined()
    roomStore.getState().setRoomJoined(ROOM, true)
    client._emitSDK('room:joined', { roomJid: ROOM, joined: true })
    await advance(2_000)
  }

  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-10-16T08:00:00Z'))
    localStorageMock.clear()
    trace = []
    connectionStore.getState().reset()
    chatStore.getState().reset()
    roomStore.getState().reset()
    rosterStore.getState().reset()
    connectionStore.setState({ jid: `${OWN}/web`, status: 'online', windowVisible: true })
    connectionStore.getState().setServerInfo({ identities: [], domain: 'example.com', features: [NS_MAM] })

    // A conversation the user has open, and a joined room that still needs its archive.
    chatStore.getState().addConversation({ id: PEER, name: 'Alice', type: 'chat', unreadCount: 0 })
    chatStore.getState().setActiveConversation(PEER)
    roomStore.getState().addRoom({
      jid: ROOM, name: 'Team', nickname: 'me', joined: true, isBookmarked: true, supportsMAM: true,
      occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set(),
      isQuickChat: false,
    } as Room, [{
      type: 'groupchat', id: 'm1', roomJid: ROOM, from: `${ROOM}/alice`, nick: 'alice', body: 'hi',
      timestamp: new Date('2026-10-16T07:00:00Z'), isOutgoing: false,
    } as RoomMessage])
    roomStore.getState().setActiveRoom(ROOM)
    roomStore.getState().addRoom({
      jid: OTHER_ROOM, name: 'Lounge', nickname: 'me', joined: true, isBookmarked: true, supportsMAM: true,
      occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set(),
      isQuickChat: false,
    } as Room)

    client = createMockClient()
    const watch = (label: string, mock: ReturnType<typeof vi.fn>, result?: unknown) =>
      mock.mockImplementation(async () => { trace.push(label); return result })
    watch('mam.catchUpAllConversations', client.internal.mam.catchUpAllConversations)
    watch('mam.catchUpConversationHistory', client.internal.mam.catchUpConversationHistory)
    watch('mam.catchUpRoom', client.internal.mam.catchUpRoom)
    watch('mam.catchUpRoomHistory', client.internal.mam.catchUpRoomHistory)
    watch('mam.discoverNewConversationsFromRoster', client.internal.mam.discoverNewConversationsFromRoster, true)
    watch('mam.refreshArchivedConversationPreviews', client.internal.mam.refreshArchivedConversationPreviews)
    watch('messages.queryMAM', client.messages.queryMAM)
    watch('messages.queryRoomMAM', client.messages.queryRoomMAM)
    watch('server.discoverMAMSearchCapability', client.server.discoverMAMSearchCapability)
    watch('retryPendingDecrypts', client.retryPendingDecrypts, 0)
    watch('waitForReplayIngested', client.internal.waitForReplayIngested)
    Object.assign(client.internal, {
      mds: {
        fetchAllDisplayedResult: vi.fn(async () => { trace.push('mds.fetchAllDisplayedResult'); return { status: 'unknown' } }),
        publishDisplayed: vi.fn().mockResolvedValue(undefined),
        retractDisplayed: vi.fn().mockResolvedValue(undefined),
      },
      savedMessages: {
        fetchAll: vi.fn(async () => { trace.push('savedMessages.fetchAll'); return { status: 'unavailable', condition: 'service-unavailable' } }),
        publish: vi.fn().mockResolvedValue(undefined),
        retract: vi.fn().mockResolvedValue(undefined),
        fetchMaxItems: vi.fn().mockResolvedValue(undefined),
        sealState: vi.fn(() => 'unavailable'),
        open: vi.fn(async () => ({ entries: [], locked: [], rejected: [], sealedSeen: 0 })),
      },
      conversationSync: { publishConversations: record('conversationSync.publishConversations') },
      refreshConversationList: vi.fn(async () => { trace.push('refreshConversationList') }),
    })

    stores = createMockStores()
    stores.connection.getStatus.mockImplementation(() => connectionStore.getState().status)
    const modules = makeModules()
    engine = new SessionLifecycleEngine({
      ...modules,
      getStores: () => stores as unknown as StoreBindings,
      getCurrentJid: () => `${OWN}/web`,
      getXmpp: () => null,
      ensureE2EEManager: vi.fn(() => { trace.push('ensureE2EEManager') }),
      sendStanza: vi.fn().mockResolvedValue(undefined),
      emitSDK: vi.fn(),
      emitOnline: () => client._emit('online'),
      emitFreshSessionInputsReady: () => { trace.push('freshSessionInputsReady'); client._emit('freshSessionInputsReady') },
      emitFreshSessionDiscoverySettled: () => { trace.push('freshSessionDiscoverySettled'); client._emit('freshSessionDiscoverySettled') },
      emitConversationListReady: (list: unknown) => { trace.push('conversationListReady'); client._emit('conversationListReady', list) },
      connectPresence: vi.fn(() => { trace.push('presence.connect') }),
    } as unknown as SessionLifecycleDeps)

    stops = [
      setupChatSideEffects(client),
      setupRoomSideEffects(client),
      setupBackgroundSyncSideEffects(client),
      setupMdsSideEffects(client),
      setupConversationSyncSideEffects(client),
      setupSavedMessagesSideEffects(client),
    ]
    unsubscribeCatchUp = connectionStore.subscribe(
      (s) => s.isCatchingUp,
      (catchingUp) => { trace.push(`catching-up:${catchingUp}`) },
    )
  })

  afterEach(() => {
    unsubscribeCatchUp()
    stops.forEach((stop) => stop())
    connectionStore.getState().setStatus('disconnected')
    vi.useRealTimers()
  })

  it('fresh session', async () => {
    await startSession(false)
    await advance(20_000)
    await confirmRoomJoin()
    expect(trace).toMatchSnapshot()
  })

  it('stream-management resume', async () => {
    localStorageMock.setItem(MARKER, '1')
    await startSession(true, 600_000)
    await advance(20_000)
    await confirmRoomJoin()
    expect(trace).toMatchSnapshot()
  })

  it('resume upgraded to fresh because the cache marker is gone', async () => {
    await startSession(true, 600_000)
    await advance(20_000)
    await confirmRoomJoin()
    expect(trace).toMatchSnapshot()
  })

  it('the resume after an upgraded one resumes normally', async () => {
    await startSession(true, 600_000)
    await advance(20_000)
    await confirmRoomJoin()
    trace.push('--- next connection ---')
    connectionStore.getState().setStatus('reconnecting')
    connectionStore.getState().setStatus('online')
    await startSession(true, 600_000)
    await advance(20_000)
    await confirmRoomJoin()
    expect(trace).toMatchSnapshot()
  })

  it('disconnect in the middle of setup', async () => {
    let releaseBookmarks: (v: { roomsToAutojoin: []; allRoomJids: [] }) => void = () => {}
    const modulesBookmarks = new Promise<{ roomsToAutojoin: []; allRoomJids: [] }>((r) => { releaseBookmarks = r })
    const deps = (engine as unknown as { deps: SessionLifecycleDeps }).deps
    deps.muc.fetchBookmarks = vi.fn(async () => { trace.push('muc.fetchBookmarks'); return modulesBookmarks }) as never

    const done = startSession(false)
    await advance(100)
    trace.push('--- transport lost ---')
    connectionStore.getState().setStatus('reconnecting')
    releaseBookmarks({ roomsToAutojoin: [], allRoomJids: [] })
    await done
    await advance(20_000)
    trace.push('--- resumed afterwards ---')
    connectionStore.getState().setStatus('online')
    localStorageMock.setItem(MARKER, '1')
    await startSession(true, 5_000)
    await advance(20_000)
    await confirmRoomJoin()
    expect(trace).toMatchSnapshot()
  })
})
