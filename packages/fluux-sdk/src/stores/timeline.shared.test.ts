/**
 * One timeline scenario suite, run against both `chatStore` and `roomStore`.
 *
 * Both stores keep a resident message window per entity (a conversation or a room), and
 * expose the same timeline actions under the same names. A scenario here states what a
 * timeline action does for any entity kind; the suite runs it once per store, so a
 * behaviour that drifts between the two fails here by name. Entity-specific behaviour
 * (occupants, bookmarks, conversation lists) stays in each store's own suites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chatStore } from './chatStore'
import { roomStore } from './roomStore'
import { _resetStorageScopeForTesting } from '../utils/storageScope'
import { setResidentWindowSize } from './shared/residentWindow'
import { _clearAllTransientForTesting } from './shared/transientUnread'
import { _clearRetractedIdentitiesForTesting } from '../utils/retractedIdentities'
import type { Message, RoomMessage } from '../core/types'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
    get _store() { return store },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  const getMessages = vi.fn().mockResolvedValue([])
  return {
    ...actual,
    isMessageCacheAvailable: vi.fn().mockReturnValue(true),
    deleteConversationMessages: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessageWithResult: vi.fn().mockResolvedValue(true),
    saveMessages: vi.fn().mockResolvedValue(true),
    getMessages,
    readMessages: vi.fn((...args: Parameters<typeof actual.readMessages>) =>
      getMessages(...args).then((value: unknown[]) => ({ status: 'ok' as const, value }))),
    getMessagesAround: vi.fn().mockResolvedValue([]),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    updateMessageReactions: vi.fn().mockResolvedValue(true),
  }
})
import * as messageCache from '../utils/messageCache'

type AnyMessage = Message | RoomMessage

/** What a scenario needs from a store; each store supplies it once. */
interface TimelineSurface {
  name: 'chat' | 'room'
  id: string
  reset(): void
  /** Create the entity and make it the active one. */
  open(): void
  message(id: string, iso: string, extra?: Record<string, unknown>): AnyMessage
  add(message: AnyMessage): Promise<void> | void
  window(): AnyMessage[]
  seed(messages: AnyMessage[]): void
  getMessage(messageId: string): AnyMessage | undefined
  updateMessage(messageId: string, updates: Record<string, unknown>): void
  updateReactions(messageId: string, reactor: string, emojis: string[]): Promise<void> | void
  clearMessageStanzaId(stanzaId: string): void
  loadFromCache(): Promise<AnyMessage[]>
  loadOlder(): Promise<AnyMessage[]>
  loadNewer(): Promise<AnyMessage[]>
  recenter(): Promise<boolean>
  liveEdge(): boolean | undefined
  markWindowParked(): void
  setDraft(text: string): void
  getDraft(): string
  clearDraft(): void
  trigger(animation: string): void
  clearAnimation(): void
  animationEntity(): string | undefined
  setTarget(id: string | null): void
  target(): unknown
  setTyping(who: string, typing: boolean): void
  typing(): string[]
  recordPendingRetraction(targetId: string): void
  pendingRetractionCount(): number
  loadAround(anchorId: string): Promise<AnyMessage[]>
  unread(): number
  markAsRead(): void
}

const CHAT_ID = 'peer@example.com'
const ROOM_ID = 'shared@conference.example.com'

const chatSurface: TimelineSurface = {
  name: 'chat',
  id: CHAT_ID,
  reset() {
    chatStore.setState({
      conversationEntities: new Map(), conversationMeta: new Map(), conversations: new Map(),
      messages: new Map(), activeConversationId: null, archivedConversations: new Set(),
      firstNewMessageMarkers: new Map(), windowAtLiveEdge: new Map(), mamQueryStates: new Map(),
      conversationGaps: new Map(), drafts: new Map(), activeAnimation: null, targetMessageId: null,
    })
  },
  open() {
    chatStore.getState().addConversation({ id: CHAT_ID, name: 'peer', type: 'chat', unreadCount: 0 })
    chatStore.setState({ activeConversationId: CHAT_ID })
  },
  message(id, iso, extra = {}) {
    return {
      type: 'chat', id, stanzaId: undefined, originId: undefined, conversationId: CHAT_ID,
      from: CHAT_ID, body: id, timestamp: new Date(iso), isOutgoing: false, ...extra,
    } as Message
  },
  add: (m) => chatStore.getState().addMessage(m as Message),
  window: () => chatStore.getState().messages.get(CHAT_ID) ?? [],
  seed: (ms) => chatStore.setState(s => ({ messages: new Map(s.messages).set(CHAT_ID, ms as Message[]) })),
  getMessage: (id) => chatStore.getState().getMessage(CHAT_ID, id),
  updateMessage: (id, updates) => chatStore.getState().updateMessage(CHAT_ID, id, updates),
  updateReactions: (id, reactor, emojis) => chatStore.getState().updateReactions(CHAT_ID, id, reactor, emojis),
  clearMessageStanzaId: (stanzaId) => chatStore.getState().clearMessageStanzaId(CHAT_ID, stanzaId),
  loadFromCache: () => chatStore.getState().loadMessagesFromCache(CHAT_ID),
  loadOlder: () => chatStore.getState().loadOlderMessagesFromCache(CHAT_ID),
  loadNewer: () => chatStore.getState().loadNewerMessagesFromCache(CHAT_ID),
  recenter: () => chatStore.getState().recenterToLatest(CHAT_ID),
  liveEdge: () => chatStore.getState().windowAtLiveEdge.get(CHAT_ID),
  markWindowParked: () => chatStore.setState(s => ({ windowAtLiveEdge: new Map(s.windowAtLiveEdge).set(CHAT_ID, false) })),
  setDraft: (t) => chatStore.getState().setDraft(CHAT_ID, t),
  getDraft: () => chatStore.getState().getDraft(CHAT_ID),
  clearDraft: () => chatStore.getState().clearDraft(CHAT_ID),
  trigger: (a) => chatStore.getState().triggerAnimation(CHAT_ID, a, 'Peer'),
  clearAnimation: () => chatStore.getState().clearAnimation(),
  animationEntity: () => chatStore.getState().activeAnimation?.conversationId,
  setTarget: (id) => chatStore.getState().setTargetMessageId(id),
  target: () => chatStore.getState().targetMessageId,
  setTyping: (who, typing) => chatStore.getState().setTyping(CHAT_ID, who, typing),
  typing: () => [...(chatStore.getState().typingStates.get(CHAT_ID) ?? [])],
  recordPendingRetraction: (id) => chatStore.getState().recordPendingRetraction(CHAT_ID, id, CHAT_ID),
  pendingRetractionCount: () => chatStore.getState().pendingRetractions.get(CHAT_ID)?.length ?? 0,
  loadAround: (id) => chatStore.getState().loadMessagesAroundFromCache(CHAT_ID, { id }),
  unread: () => chatStore.getState().conversationMeta.get(CHAT_ID)?.unreadCount ?? 0,
  markAsRead: () => chatStore.getState().markAsRead(CHAT_ID),
}

const roomSurface: TimelineSurface = {
  name: 'room',
  id: ROOM_ID,
  reset() {
    roomStore.setState({
      rooms: new Map(), roomEntities: new Map(), roomMeta: new Map(), roomRuntime: new Map(),
      messages: new Map(), windowAtLiveEdge: new Map(), activeRoomJid: null,
      firstNewMessageMarkers: new Map(), mamQueryStates: new Map(), roomGaps: new Map(),
      drafts: new Map(), activeAnimation: null, targetMessageId: null,
    })
  },
  open() {
    roomStore.getState().addRoom({
      jid: ROOM_ID, name: 'shared', nickname: 'me', joined: true, isBookmarked: false,
      occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set(),
    })
    roomStore.setState({ activeRoomJid: ROOM_ID })
  },
  message(id, iso, extra = {}) {
    return {
      type: 'groupchat', id, stanzaId: undefined, originId: undefined, occupantId: undefined,
      roomJid: ROOM_ID, from: `${ROOM_ID}/alice`, nick: 'alice', body: id,
      timestamp: new Date(iso), isOutgoing: false, ...extra,
    } as RoomMessage
  },
  add: (m) => roomStore.getState().addMessage(ROOM_ID, m as RoomMessage),
  window: () => roomStore.getState().messages.get(ROOM_ID) ?? [],
  seed: (ms) => roomStore.setState(s => ({ messages: new Map(s.messages).set(ROOM_ID, ms as RoomMessage[]) })),
  getMessage: (id) => roomStore.getState().getMessage(ROOM_ID, id),
  updateMessage: (id, updates) => { void roomStore.getState().updateMessage(ROOM_ID, id, updates) },
  updateReactions: (id, reactor, emojis) => roomStore.getState().updateReactions(ROOM_ID, id, reactor, emojis),
  clearMessageStanzaId: (stanzaId) => roomStore.getState().clearMessageStanzaId(ROOM_ID, stanzaId),
  loadFromCache: () => roomStore.getState().loadMessagesFromCache(ROOM_ID),
  loadOlder: () => roomStore.getState().loadOlderMessagesFromCache(ROOM_ID),
  loadNewer: () => roomStore.getState().loadNewerMessagesFromCache(ROOM_ID),
  recenter: () => roomStore.getState().recenterToLatest(ROOM_ID),
  liveEdge: () => roomStore.getState().windowAtLiveEdge.get(ROOM_ID),
  markWindowParked: () => roomStore.setState(s => ({ windowAtLiveEdge: new Map(s.windowAtLiveEdge).set(ROOM_ID, false) })),
  setDraft: (t) => roomStore.getState().setDraft(ROOM_ID, t),
  getDraft: () => roomStore.getState().getDraft(ROOM_ID),
  clearDraft: () => roomStore.getState().clearDraft(ROOM_ID),
  trigger: (a) => roomStore.getState().triggerAnimation(ROOM_ID, a, 'Alice'),
  clearAnimation: () => roomStore.getState().clearAnimation(),
  animationEntity: () => roomStore.getState().activeAnimation?.roomJid,
  setTarget: (id) => roomStore.getState().setTargetMessageId(id),
  target: () => roomStore.getState().targetMessageId,
  setTyping: (who, typing) => roomStore.getState().setTyping(ROOM_ID, who, typing),
  typing: () => [...(roomStore.getState().rooms.get(ROOM_ID)?.typingUsers ?? [])],
  recordPendingRetraction: (id) => roomStore.getState().recordPendingRetraction(ROOM_ID, id, `${ROOM_ID}/alice`),
  pendingRetractionCount: () => roomStore.getState().pendingRetractions.get(ROOM_ID)?.length ?? 0,
  loadAround: (id) => roomStore.getState().loadMessagesAroundFromCache(ROOM_ID, { id }),
  unread: () => roomStore.getState().roomMeta.get(ROOM_ID)?.unreadCount ?? 0,
  markAsRead: () => roomStore.getState().markAsRead(ROOM_ID),
}

const ids = (ms: AnyMessage[]) => ms.map(m => m.id)

describe.each([chatSurface, roomSurface])('timeline scenarios: $name store', (s) => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    localStorageMock.clear()
    _clearAllTransientForTesting()
    _clearRetractedIdentitiesForTesting()
    vi.clearAllMocks()
    vi.mocked(messageCache.getMessages).mockReset().mockResolvedValue([])
    vi.mocked(messageCache.getMessagesAround).mockReset().mockResolvedValue([])
    // The typed read serves whatever getMessages is set to return, as a readable cache.
    vi.mocked(messageCache.readMessages).mockReset().mockImplementation(
      (...args: Parameters<typeof messageCache.readMessages>) =>
        (messageCache.getMessages as unknown as (...a: unknown[]) => Promise<never>)(...args)
          .then((value) => ({ status: 'ok' as const, value })) as ReturnType<typeof messageCache.readMessages>)
    s.reset()
    s.open()
  })

  afterEach(() => {
    setResidentWindowSize(5000)
  })

  describe('addMessage', () => {
    it('keeps messages in timestamp order whatever the arrival order', () => {
      s.add(s.message('b', '2024-01-15T10:02:00Z'))
      s.add(s.message('a', '2024-01-15T10:01:00Z'))
      s.add(s.message('c', '2024-01-15T10:03:00Z'))
      expect(ids(s.window())).toEqual(['a', 'b', 'c'])
    })

    it('drops a duplicate id and keeps one row', () => {
      s.add(s.message('a', '2024-01-15T10:01:00Z'))
      s.add(s.message('a', '2024-01-15T10:01:00Z'))
      expect(ids(s.window())).toEqual(['a'])
    })

    it('trims the resident window to its bound, keeping the newest', () => {
      setResidentWindowSize(3)
      for (let i = 1; i <= 4; i++) s.add(s.message(`m${i}`, `2024-01-15T10:0${i}:00Z`))
      expect(ids(s.window())).toEqual(['m2', 'm3', 'm4'])
    })

    it('backfills the archive stanza id onto the row a duplicate echo matches', () => {
      s.add(s.message('orig', '2024-01-15T10:00:00Z', { isOutgoing: true, originId: 'origin-1' }))
      s.add(s.message('orig', '2024-01-15T10:00:00Z', { isOutgoing: true, originId: 'origin-1', stanzaId: 'arch-1' }))
      expect(s.window()).toHaveLength(1)
      expect(s.window()[0].stanzaId).toBe('arch-1')
    })

    it('persists a delayed arrival that the window bound trims away', async () => {
      setResidentWindowSize(2)
      s.add(s.message('l1', '2024-01-15T10:01:00Z'))
      s.add(s.message('l2', '2024-01-15T10:02:00Z'))
      vi.mocked(messageCache.saveMessageWithResult).mockClear()
      // A room settles a delayed arrival against the cache first, so its add is awaited.
      await s.add(s.message('late', '2024-01-15T09:00:00Z', { isDelayed: true }))
      expect(ids(s.window())).toEqual(['l1', 'l2'])
      expect(messageCache.saveMessageWithResult).toHaveBeenCalledTimes(1)
    })
  })

  describe('getMessage', () => {
    it('finds a message by id and by server stanza id, and reports a miss as undefined', () => {
      s.add(s.message('a', '2024-01-15T10:01:00Z', { stanzaId: 'srv-a' }))
      expect(s.getMessage('a')?.id).toBe('a')
      expect(s.getMessage('srv-a')?.id).toBe('a')
      expect(s.getMessage('nope')).toBeUndefined()
    })
  })

  describe('updateMessage', () => {
    it('applies a correction to the matching row only', () => {
      s.add(s.message('a', '2024-01-15T10:01:00Z'))
      s.add(s.message('b', '2024-01-15T10:02:00Z'))
      s.updateMessage('a', { body: 'fixed', isEdited: true })
      expect(s.getMessage('a')).toMatchObject({ body: 'fixed', isEdited: true })
      expect(s.getMessage('b')?.body).toBe('b')
    })

    it('marks a retracted row without removing it', () => {
      s.add(s.message('a', '2024-01-15T10:01:00Z'))
      s.updateMessage('a', { isRetracted: true, retractedAt: new Date() })
      expect(s.window()).toHaveLength(1)
      expect(s.getMessage('a')?.isRetracted).toBe(true)
    })
  })

  describe('clearMessageStanzaId', () => {
    it('drops a stale server id from the row that carries it and leaves the row in place', () => {
      s.add(s.message('a', '2024-01-15T10:01:00Z', { stanzaId: 'srv-a' }))
      s.clearMessageStanzaId('srv-a')
      expect(s.window()).toHaveLength(1)
      expect(s.window()[0].stanzaId).toBeUndefined()
    })

    it('ignores a stanza id no row carries', () => {
      s.add(s.message('a', '2024-01-15T10:01:00Z', { stanzaId: 'srv-a' }))
      s.clearMessageStanzaId('absent')
      expect(s.window()[0].stanzaId).toBe('srv-a')
    })
  })

  describe('updateReactions', () => {
    it('records a reaction on the resident row', async () => {
      s.add(s.message('a', '2024-01-15T10:01:00Z'))
      await s.updateReactions('a', s.name === 'chat' ? 'bob@example.com' : 'bob', ['👍'])
      const reactions = s.getMessage('a')?.reactions
      expect(Object.keys(reactions ?? {})).toEqual(['👍'])
    })

    it('patches the durable cache when the entity is resident but the message is not', async () => {
      s.add(s.message('here', '2024-01-15T10:01:00Z'))
      const before = s.window()
      vi.mocked(messageCache.updateMessageReactions).mockClear()
      await s.updateReactions('evicted', s.name === 'chat' ? 'bob@example.com' : 'bob', ['👍'])
      expect(messageCache.updateMessageReactions).toHaveBeenCalledTimes(1)
      expect(s.window()).toBe(before)
    })
  })

  describe('cache pagination', () => {
    it('loadOlder dedupes and sorts an overlapping, out-of-order batch', async () => {
      const cur = s.message('cur', '2024-01-15T11:00:00Z')
      s.seed([cur])
      vi.mocked(messageCache.getMessages).mockResolvedValue([
        { ...cur }, s.message('old2', '2024-01-15T10:30:00Z'), s.message('old1', '2024-01-15T10:00:00Z'),
      ])
      await s.loadOlder()
      expect(ids(s.window())).toEqual(['old1', 'old2', 'cur'])
    })

    it('loadNewer dedupes and sorts an overlapping, out-of-order batch', async () => {
      const cur = s.message('cur', '2024-01-15T11:00:00Z')
      s.seed([cur])
      vi.mocked(messageCache.getMessages).mockResolvedValue([
        s.message('new2', '2024-01-15T13:00:00Z'), { ...cur }, s.message('new1', '2024-01-15T12:00:00Z'),
      ])
      await s.loadNewer()
      expect(ids(s.window())).toEqual(['cur', 'new1', 'new2'])
    })

    it('loadOlder and loadNewer do nothing for an empty window', async () => {
      vi.mocked(messageCache.getMessages).mockResolvedValue([s.message('x', '2024-01-15T10:00:00Z')])
      expect(await s.loadOlder()).toEqual([])
      expect(await s.loadNewer()).toEqual([])
      expect(s.window()).toEqual([])
    })

    it('loadNewer that returns fewer rows than asked reaches the live edge', async () => {
      const cur = s.message('cur', '2024-01-15T11:00:00Z')
      s.seed([cur])
      s.markWindowParked()
      vi.mocked(messageCache.getMessages).mockResolvedValue([s.message('n1', '2024-01-15T12:00:00Z')])
      await s.loadNewer()
      expect(s.liveEdge()).not.toBe(false)
    })

    it('loadOlder past the bound slides the window off the live edge', async () => {
      setResidentWindowSize(2)
      s.seed([s.message('c1', '2024-01-15T11:00:00Z'), s.message('c2', '2024-01-15T11:30:00Z')])
      vi.mocked(messageCache.getMessages).mockResolvedValue([s.message('o1', '2024-01-15T10:00:00Z')])
      await s.loadOlder()
      expect(ids(s.window())).toEqual(['o1', 'c1'])
      expect(s.liveEdge()).toBe(false)
    })

    it('loadFromCache fills an empty window with the latest slice', async () => {
      vi.mocked(messageCache.getMessages).mockResolvedValue([
        s.message('a', '2024-01-15T10:00:00Z'), s.message('b', '2024-01-15T10:01:00Z'),
      ])
      const read = await s.loadFromCache()
      expect(ids(read)).toEqual(['a', 'b'])
      expect(ids(s.window())).toEqual(['a', 'b'])
    })

    it('loadFromCache leaves a parked window where it is', async () => {
      s.seed([s.message('old', '2024-01-15T09:00:00Z')])
      s.markWindowParked()
      vi.mocked(messageCache.getMessages).mockResolvedValue([s.message('latest', '2024-01-15T12:00:00Z')])
      await s.loadFromCache()
      expect(ids(s.window())).toEqual(['old'])
    })

    it('recenterToLatest merges the latest slice and clears the parked flag', async () => {
      s.seed([s.message('old', '2024-01-15T09:00:00Z')])
      s.markWindowParked()
      vi.mocked(messageCache.getMessages).mockResolvedValue([s.message('latest', '2024-01-15T12:00:00Z')])
      expect(await s.recenter()).toBe(true)
      expect(ids(s.window())).toContain('latest')
      expect(s.liveEdge()).not.toBe(false)
    })
  })

  describe('drafts', () => {
    it('stores, reads back and clears a draft', () => {
      expect(s.getDraft()).toBe('')
      s.setDraft('hello')
      expect(s.getDraft()).toBe('hello')
      s.clearDraft()
      expect(s.getDraft()).toBe('')
    })
  })

  describe('animation and scroll target', () => {
    it('triggers and clears an animation for the entity', () => {
      s.trigger('confetti')
      expect(s.animationEntity()).toBe(s.id)
      s.clearAnimation()
      expect(s.animationEntity()).toBeUndefined()
    })

    it('sets and clears the target message', () => {
      s.setTarget('m-9')
      expect(s.target()).toBe('m-9')
      s.setTarget(null)
      expect(s.target()).toBeNull()
    })
  })

  describe('typing', () => {
    it('adds and removes a typist, and forgets the entity once nobody types', () => {
      s.setTyping('bob', true)
      s.setTyping('carol', true)
      expect(s.typing().sort()).toEqual(['bob', 'carol'])
      s.setTyping('bob', false)
      expect(s.typing()).toEqual(['carol'])
      s.setTyping('carol', false)
      expect(s.typing()).toEqual([])
    })

    it('clears a typist by itself after the auto-clear delay', () => {
      vi.useFakeTimers()
      try {
        s.setTyping('bob', true)
        vi.advanceTimersByTime(60_000)
        expect(s.typing()).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('pending retractions', () => {
    it('records a retraction that arrived before its target and tombstones the target on arrival', async () => {
      s.recordPendingRetraction('late-target')
      expect(s.pendingRetractionCount()).toBe(1)
      await s.add(s.message('late-target', '2024-01-15T10:00:00Z', { from: s.name === 'chat' ? s.id : `${s.id}/alice` }))
      await Promise.resolve()
      expect(s.getMessage('late-target')?.isRetracted).toBe(true)
    })
  })

  describe('cache read failures', () => {
    it('loadFromCache, loadOlder and loadNewer resolve to an empty read when the cache throws', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        s.seed([s.message('cur', '2024-01-15T11:00:00Z')])
        vi.mocked(messageCache.getMessages).mockRejectedValue(new Error('idb down'))
        vi.mocked(messageCache.readMessages).mockRejectedValue(new Error('idb down'))
        expect(await s.loadFromCache()).toEqual([])
        expect(await s.loadOlder()).toEqual([])
        expect(await s.loadNewer()).toEqual([])
        expect(ids(s.window())).toEqual(['cur'])
      } finally {
        warn.mockRestore()
        error.mockRestore()
      }
    })
  })

  describe('loadAround', () => {
    it('makes the slice around an anchor resident and returns it', async () => {
      const slice = [
        s.message('a1', '2024-01-15T09:00:00Z'), s.message('a2', '2024-01-15T09:30:00Z'), s.message('a3', '2024-01-15T09:45:00Z'),
      ]
      vi.mocked(messageCache.getMessagesAround).mockResolvedValue(slice)
      const read = await s.loadAround('a2')
      expect(ids(read)).toEqual(['a1', 'a2', 'a3'])
      expect(ids(s.window())).toEqual(['a1', 'a2', 'a3'])
    })

    it('returns nothing and leaves the window alone when the around read is empty', async () => {
      s.seed([s.message('cur', '2024-01-15T11:00:00Z')])
      expect(await s.loadAround('missing')).toEqual([])
      expect(ids(s.window())).toEqual(['cur'])
    })
  })

  describe('read state', () => {
    it('counts an inactive arrival as unread and markAsRead zeroes it', () => {
      s.reset()
      s.open()
      // Deactivate so an arrival counts as unread.
      if (s.name === 'chat') chatStore.setState({ activeConversationId: null })
      else roomStore.setState({ activeRoomJid: null })
      s.add(s.message('u1', '2024-01-15T10:00:00Z'))
      expect(s.unread()).toBe(1)
      s.markAsRead()
      expect(s.unread()).toBe(0)
    })
  })
})
