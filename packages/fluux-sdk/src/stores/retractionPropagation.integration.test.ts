/**
 * XEP-0424 retraction at the SOURCE: the retracted body must leave the durable
 * cache and the search index, not merely stop being rendered.
 *
 * These tests run the real `messageCache` and `searchIndex` against fake
 * IndexedDB and assert on the STORED bytes — `expectNoTraceOf` reads every row of
 * both databases back and fails if the retracted text survives anywhere. A test
 * that only inspected the in-memory store would pass with the body still on disk,
 * which is the defect this file covers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB } from 'idb'
import { chatStore } from './chatStore'
import { roomStore } from './roomStore'
import {
  retractChatMessageInStorage,
  retractRoomMessageInStorage,
} from './shared/retractionStorage'
import * as messageCache from '../utils/messageCache'
import * as searchIndex from '../utils/searchIndex'
import {
  _clearRetractedIdentitiesForTesting,
  chatRetractionAliases,
  noteRetractedIdentity,
  roomRetractionAliases,
} from '../utils/retractedIdentities'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { localStorageMock } from '../core/sideEffects.testHelpers'
import type { Message, Room, RoomMessage } from '../core/types'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

const SCOPE = 'romeo@montague.example'
const OTHER_SCOPE = 'mercutio@verona.example'
const CHAT = 'juliet@capulet.example'
const OTHER_CHAT = 'benvolio@montague.example'
const ROOM = 'balcony@conference.montague.example'
const OTHER_ROOM = 'square@conference.verona.example'

/** The word every test hides in a body and then demands the storage forget. */
const SECRET = 'plutonium'

function chatMessage(overrides: Partial<Message> = {}): Message {
  return {
    type: 'chat',
    id: 'chat-1',
    conversationId: CHAT,
    from: CHAT,
    body: `the ${SECRET} shipment`,
    timestamp: new Date(1_700_000_000_000),
    isOutgoing: false,
    ...overrides,
  }
}

function roomMessage(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    type: 'groupchat',
    id: 'room-1',
    roomJid: ROOM,
    from: `${ROOM}/alice`,
    nick: 'alice',
    body: `the ${SECRET} shipment`,
    timestamp: new Date(1_700_000_000_000),
    isOutgoing: false,
    ...overrides,
  }
}

function room(): Room {
  return {
    jid: ROOM,
    name: 'balcony',
    joined: true,
    occupants: [],
    unreadCount: 0,
  } as unknown as Room
}

function switchScopeWhileIterating(scope: string): string[] {
  return new Proxy(['👍'], {
    get(target, property, receiver) {
      if (property !== Symbol.iterator) return Reflect.get(target, property, receiver)
      return function* () {
        setStorageScopeJid(scope)
        yield* target
      }
    },
  })
}

/** Every value stored in both scoped databases, serialized. */
async function dumpStorage(scope = SCOPE): Promise<string> {
  const parts: string[] = []
  const cache = await openDB(`fluux-message-cache:${scope}`)
  for (const store of [...cache.objectStoreNames]) {
    parts.push(JSON.stringify(await cache.getAll(store)))
  }
  cache.close()
  const index = await openDB(`fluux-search-index:${scope}`)
  for (const store of [...index.objectStoreNames]) {
    parts.push(JSON.stringify(await index.getAll(store)))
  }
  index.close()
  return parts.join('\n')
}

/** The criterion: no retracted content anywhere on disk, index postings included. */
async function expectNoTraceOf(text: string): Promise<void> {
  expect(await dumpStorage()).not.toContain(text)
  expect(await searchIndex.search(text)).toEqual([])
}

async function searchInScope(scope: string, text: string): Promise<searchIndex.SearchIndexResult[]> {
  setStorageScopeJid(scope)
  await searchIndex.initSearchIndex(scope)
  return searchIndex.search(text)
}

/**
 * Let the stores' fire-and-forget durable writes settle. A retraction resolves
 * through several sequential IndexedDB round trips, and fake-indexeddb completes
 * each on a macrotask, so this drains macrotasks rather than microtasks.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('retraction propagates to the cache and the search index', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory()
    _resetStorageScopeForTesting()
    messageCache._resetDBForTesting()
    searchIndex._resetDBForTesting()
    _clearRetractedIdentitiesForTesting()
    localStorage.clear()
    setStorageScopeJid(SCOPE)
    await searchIndex.initSearchIndex(SCOPE)
    chatStore.setState({ messages: new Map(), pendingRetractions: new Map() })
    roomStore.setState({ messages: new Map(), rooms: new Map(), pendingRetractions: new Map() })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await searchIndex.closeSearchIndex()
  })

  // ===========================================================================
  // Case 1 — the target is no longer resident when the retraction arrives
  // ===========================================================================

  describe('target not resident', () => {
    it('erases a cached 1:1 message the resident window no longer holds', async () => {
      const message = chatMessage()
      await messageCache.saveMessage(message)
      await searchIndex.indexMessage(message)
      expect(await searchIndex.search(SECRET)).toHaveLength(1)

      // The conversation was deactivated: nothing resident to patch.
      expect(chatStore.getState().messages.get(CHAT)).toBeUndefined()

      chatStore.getState().recordPendingRetraction(CHAT, message.id, CHAT)
      await settle()

      const stored = await messageCache.getMessage(message.id)
      expect(stored?.isRetracted).toBe(true)
      expect(stored?.body).toBe('')
      await expectNoTraceOf(SECRET)
    })

    it('erases every chat row sharing the authorized stanza identity', async () => {
      const first = chatMessage({ id: 'copy-a', stanzaId: 'shared-archive', body: 'holmium copy' })
      const second = chatMessage({ id: 'copy-b', stanzaId: 'shared-archive', body: 'thulium copy' })
      await messageCache.saveMessages([first, second])
      await searchIndex.indexMessages([first, second])

      chatStore.getState().recordPendingRetraction(CHAT, 'shared-archive', CHAT)
      await settle()

      expect((await messageCache.getMessage(first.id))?.isRetracted).toBe(true)
      expect((await messageCache.getMessage(second.id))?.isRetracted).toBe(true)
      expect(await searchIndex.search('holmium')).toEqual([])
      expect(await searchIndex.search('thulium')).toEqual([])
    })

    it('erases every cached chat copy from the resident storage sink', async () => {
      const first = chatMessage({
        id: 'resident-a',
        stanzaId: 'resident-archive-a',
        originId: 'resident-origin',
        body: 'holmium resident',
      })
      const second = chatMessage({
        id: 'resident-b',
        stanzaId: 'resident-archive-b',
        originId: 'resident-origin',
        body: 'thulium resident',
      })
      await messageCache.saveMessages([first, second])
      await searchIndex.indexMessages([first, second])
      chatStore.setState({ messages: new Map([[CHAT, [first]]]) })

      chatStore.getState().recordPendingRetraction(CHAT, first.originId!, first.from)
      await settle()

      expect((await messageCache.getMessage(first.id))?.isRetracted).toBe(true)
      expect((await messageCache.getMessage(second.id))?.isRetracted).toBe(true)
      expect(await searchIndex.search('holmium')).toEqual([])
      expect(await searchIndex.search('thulium')).toEqual([])
    })

    it('erases every indexed room copy in the cached identity closure', async () => {
      const first = roomMessage({
        id: 'room-closure-first',
        stanzaId: 'room-closure-stanza-1',
        originId: 'room-closure-origin',
        occupantId: 'room-closure-occupant',
        body: 'curium room closure',
      })
      const second = roomMessage({
        id: 'room-closure-second',
        stanzaId: 'room-closure-stanza-2',
        originId: first.originId,
        occupantId: first.occupantId,
        body: 'fermium room closure',
      })
      await searchIndex.indexMessages([first, second])
      await messageCache.saveRoomMessages([first, second])

      roomStore.getState().recordPendingRetraction(
        ROOM,
        second.stanzaId!,
        second.from,
        second.occupantId
      )
      await settle()

      expect((await messageCache.getRoomMessage(ROOM, first.id, first.from))?.body).toBe('')
      expect(await searchIndex.search('curium')).toEqual([])
      expect(await searchIndex.search('fermium')).toEqual([])
    })

    it('does not mutate a globally keyed chat row outside the resolved owner', async () => {
      const target = chatMessage({ id: 'shared-client-id', from: 'romeo@montague.example' })
      const otherConversation = chatMessage({
        id: target.id,
        conversationId: OTHER_CHAT,
        from: target.from,
        body: 'other-conversation terbium',
      })
      await messageCache.saveMessage(otherConversation)
      await searchIndex.indexMessage(otherConversation)

      await retractChatMessageInStorage(CHAT, target, { retractedAt: new Date() })

      expect(await messageCache.getMessage(target.id)).toMatchObject({
        conversationId: OTHER_CHAT,
        from: target.from,
        body: 'other-conversation terbium',
      })
      expect((await messageCache.getMessage(target.id))?.isRetracted).toBeFalsy()
      expect(await searchIndex.search('terbium')).toHaveLength(1)

      const otherSender = chatMessage({
        id: 'shared-sender-id',
        from: 'mallory@montague.example',
        body: 'other-sender ytterbium',
      })
      await messageCache.saveMessage(otherSender)
      await searchIndex.indexMessage(otherSender)

      await retractChatMessageInStorage(
        CHAT,
        { ...target, id: otherSender.id },
        { retractedAt: new Date() }
      )

      expect(await messageCache.getMessage(otherSender.id)).toMatchObject({
        conversationId: CHAT,
        from: otherSender.from,
        body: 'other-sender ytterbium',
      })
      expect((await messageCache.getMessage(otherSender.id))?.isRetracted).toBeFalsy()
      expect(await searchIndex.search('ytterbium')).toHaveLength(1)
    })

    it('erases a cached room message the resident window no longer holds', async () => {
      const message = roomMessage({ stanzaId: 'archive-1', occupantId: 'occ-alice' })
      await messageCache.saveRoomMessage(message)
      await searchIndex.indexMessage(message)
      expect(await searchIndex.search(SECRET)).toHaveLength(1)

      expect(roomStore.getState().messages.get(ROOM)).toBeUndefined()

      roomStore.getState().recordPendingRetraction(ROOM, 'archive-1', message.from, 'occ-alice')
      await settle()

      const stored = await messageCache.getRoomMessage(ROOM, message.id)
      expect(stored?.isRetracted).toBe(true)
      expect(stored?.body).toBe('')
      await expectNoTraceOf(SECRET)
    })

    it('removes the pending record once the cached tombstone protects reload', async () => {
      const message = chatMessage()
      await messageCache.saveMessage(message)

      chatStore.getState().recordPendingRetraction(CHAT, message.id, CHAT)
      await settle()

      expect(chatStore.getState().pendingRetractions.get(CHAT) ?? []).toEqual([])
    })

    it('leaves a cached message alone when the retraction is not from its author', async () => {
      const message = roomMessage({ stanzaId: 'archive-1', occupantId: 'occ-alice' })
      await messageCache.saveRoomMessage(message)
      await searchIndex.indexMessage(message)

      roomStore.getState().recordPendingRetraction(ROOM, 'archive-1', `${ROOM}/mallory`, 'occ-mallory')
      await settle()

      const stored = await messageCache.getRoomMessage(ROOM, message.id)
      expect(stored?.isRetracted).toBeFalsy()
      expect(stored?.body).toContain(SECRET)
      expect(await searchIndex.search(SECRET)).toHaveLength(1)
    })

    it('does not let an unauthorized unresolved room retraction scrub a later write', async () => {
      const message = roomMessage({ stanzaId: 'archive-late', occupantId: 'occ-alice' })

      roomStore.getState().recordPendingRetraction(ROOM, 'archive-late', message.from, 'occ-mallory')
      await settle()

      await messageCache.saveRoomMessage(message)
      await searchIndex.indexMessage(message)

      expect((await messageCache.getRoomMessage(ROOM, message.id))?.isRetracted).toBeFalsy()
      expect(await searchIndex.search(SECRET)).toHaveLength(1)
    })

    it('does not let an unauthorized unresolved chat retraction scrub a later write', async () => {
      const message = chatMessage()

      chatStore.getState().recordPendingRetraction(CHAT, message.id, 'mallory@montague.example')
      await settle()

      await messageCache.saveMessage(message)
      await searchIndex.indexMessage(message)

      expect((await messageCache.getMessage(message.id))?.isRetracted).toBeFalsy()
      expect(await searchIndex.search(SECRET)).toHaveLength(1)
    })

    it('removes the search document for an already-tombstoned chat target', async () => {
      const message = chatMessage()
      await messageCache.saveMessage(message)
      await searchIndex.indexMessage(message)
      await messageCache.updateMessage(message.id, { isRetracted: true, retractedAt: new Date() })

      chatStore.getState().recordPendingRetraction(CHAT, message.id, message.from)
      await settle()

      expect(await searchIndex.search(SECRET)).toEqual([])
    })

    it('removes the search document for an already-tombstoned room target', async () => {
      const message = roomMessage({ stanzaId: 'already-tombstoned', occupantId: 'occ-alice' })
      await messageCache.saveRoomMessage(message)
      await searchIndex.indexMessage(message)
      await messageCache.updateRoomMessage(
        ROOM,
        message.id,
        { isRetracted: true, retractedAt: new Date() },
        message.from
      )

      roomStore.getState().recordPendingRetraction(
        ROOM,
        message.stanzaId!,
        message.from,
        message.occupantId
      )
      await settle()

      expect(await searchIndex.search(SECRET)).toEqual([])
    })

    it('preserves a resident chat tombstone timestamp during duplicate cleanup', async () => {
      const message = chatMessage()
      const retractedAt = new Date('2026-07-22T03:53:00Z')
      await messageCache.saveMessage(message)
      await searchIndex.indexMessage(message)
      await messageCache.updateMessage(message.id, { isRetracted: true, retractedAt })
      chatStore.setState({
        messages: new Map([[CHAT, [{ ...message, isRetracted: true, retractedAt }]]]),
      })

      chatStore.getState().recordPendingRetraction(CHAT, message.id, message.from)
      await settle()

      expect((await messageCache.getMessage(message.id))?.retractedAt).toEqual(retractedAt)
      expect(chatStore.getState().messages.get(CHAT)?.[0].retractedAt).toEqual(retractedAt)
      expect(await searchIndex.search(SECRET)).toEqual([])
    })

    it('preserves a resident room tombstone timestamp during duplicate cleanup', async () => {
      const message = roomMessage({ stanzaId: 'duplicate-room', occupantId: 'occ-alice' })
      const retractedAt = new Date('2026-07-22T03:53:00Z')
      await messageCache.saveRoomMessage(message)
      await searchIndex.indexMessage(message)
      await messageCache.updateRoomMessage(
        ROOM,
        message.id,
        { isRetracted: true, retractedAt },
        message.from
      )
      roomStore.getState().addRoom(room(), [{ ...message, isRetracted: true, retractedAt }])

      roomStore.getState().recordPendingRetraction(
        ROOM,
        message.stanzaId!,
        message.from,
        message.occupantId
      )
      await settle()

      expect((await messageCache.getRoomMessage(ROOM, message.id))?.retractedAt).toEqual(retractedAt)
      expect(roomStore.getState().messages.get(ROOM)?.[0].retractedAt).toEqual(retractedAt)
      expect(await searchIndex.search(SECRET)).toEqual([])
    })

    it('finishes chat index cleanup when restored replay finds a tombstone', async () => {
      const message = chatMessage()
      const retractedAt = new Date()
      await messageCache.saveMessage(message)
      await searchIndex.indexMessage(message)
      await messageCache.updateMessage(message.id, { isRetracted: true, retractedAt })
      _clearRetractedIdentitiesForTesting()
      chatStore.setState({
        messages: new Map(),
        pendingRetractions: new Map([[
          CHAT,
          [{ targetId: message.id, actorJid: message.from, retractedAt: retractedAt.getTime() }],
        ]]),
      })

      await chatStore.getState().loadMessagesFromCache(CHAT)
      await settle()

      expect(await searchIndex.search(SECRET)).toEqual([])
    })

    it('finishes room index cleanup when restored replay finds a tombstone', async () => {
      const message = roomMessage({ stanzaId: 'restored-room', occupantId: 'occ-alice' })
      const retractedAt = new Date()
      await messageCache.saveRoomMessage(message)
      await searchIndex.indexMessage(message)
      await messageCache.updateRoomMessage(
        ROOM,
        message.id,
        { isRetracted: true, retractedAt },
        message.from
      )
      _clearRetractedIdentitiesForTesting()
      roomStore.getState().addRoom(room(), [])
      roomStore.setState({
        pendingRetractions: new Map([[
          ROOM,
          [{
            targetId: message.stanzaId!,
            actorJid: message.from,
            actorOccupantId: message.occupantId,
            retractedAt: retractedAt.getTime(),
          }],
        ]]),
      })

      await roomStore.getState().loadMessagesFromCache(ROOM)
      await settle()

      expect(await searchIndex.search(SECRET)).toEqual([])
    })
  })

  // ===========================================================================
  // Case 2 — the retraction names an archive id assigned AFTER the index row
  // ===========================================================================

  describe('archive id assigned after the index row was written', () => {
    it('erases a room document indexed under the composite id before the stanza id arrived', async () => {
      // Indexed while the message had no archive id: its document lives under
      // `room:<roomJid>:<from>:<id>` and can never be found under the stanza form.
      const early = roomMessage({ occupantId: 'occ-alice' })
      await messageCache.saveRoomMessage(early)
      await searchIndex.indexMessage(early)

      // The MAM copy arrives and merges the archive id onto the same row.
      await messageCache.saveRoomMessage({ ...early, stanzaId: 'archive-late' })
      expect((await messageCache.getRoomMessage(ROOM, early.id))?.stanzaId).toBe('archive-late')

      roomStore.getState().recordPendingRetraction(ROOM, 'archive-late', early.from, 'occ-alice')
      await settle()

      await expectNoTraceOf(SECRET)
    })

    it('erases a 1:1 message whose archive id reached the cache after indexing', async () => {
      const early = chatMessage()
      await messageCache.saveMessage(early)
      await searchIndex.indexMessage(early)

      await messageCache.updateMessage(early.id, { stanzaId: 'archive-late' })
      expect((await messageCache.getMessage(early.id))?.stanzaId).toBe('archive-late')

      chatStore.getState().recordPendingRetraction(CHAT, 'archive-late', CHAT)
      await settle()

      await expectNoTraceOf(SECRET)
    })
  })

  // ===========================================================================
  // Case 3 — MUC nick reassignment: same room, nick and client id
  // ===========================================================================

  describe('room after a nick reassignment', () => {
    const OTHER_SECRET = 'polonium'

    it('does not delete the neighbour document that shares the composite index id', async () => {
      // The departed occupant's message was indexed before its archive id
      // arrived, so it owns the composite id `room:<roomJid>:<from>:<id>`.
      const departed = roomMessage({
        id: 'shared-id',
        occupantId: 'occ-alice-1',
        body: `the ${OTHER_SECRET} shipment`,
        timestamp: new Date(1_700_000_000_000),
      })
      await searchIndex.indexMessage(departed)

      // The nick was reassigned. Same room, same nick, same client id — only the
      // archive and occupant ids differ.
      const reassigned = roomMessage({
        id: 'shared-id',
        occupantId: 'occ-alice-2',
        stanzaId: 'archive-recent',
        timestamp: new Date(1_700_000_500_000),
      })
      await messageCache.saveRoomMessage(reassigned)
      await searchIndex.indexMessage(reassigned)

      await retractRoomMessageInStorage(ROOM, reassigned, { retractedAt: new Date() })

      await expectNoTraceOf(SECRET)
      // The departed occupant's message is a different message and keeps its own
      // document: the retraction did not reach across the shared composite id.
      expect(await searchIndex.search(OTHER_SECRET)).toHaveLength(1)
    })

    it('does not mutate the departed occupant cache row from the resident sink', async () => {
      const departed = roomMessage({
        id: 'shared-cache-id',
        occupantId: 'occ-alice-1',
        body: `the ${OTHER_SECRET} cache shipment`,
      })
      await messageCache.saveRoomMessage(departed)
      await searchIndex.indexMessage(departed)

      const reassigned = roomMessage({
        id: departed.id,
        occupantId: 'occ-alice-2',
        stanzaId: 'archive-recent-cache',
      })
      await retractRoomMessageInStorage(ROOM, reassigned, { retractedAt: new Date() })

      expect(await messageCache.getRoomMessage(ROOM, departed.id, departed.from)).toMatchObject({
        occupantId: departed.occupantId,
        body: departed.body,
      })
      expect((await messageCache.getRoomMessage(ROOM, departed.id, departed.from))?.isRetracted).toBeFalsy()
      expect(await searchIndex.search(OTHER_SECRET)).toHaveLength(1)
    })

    it('does not apply a verified lower-tier alias after occupant reassignment', async () => {
      const departed = roomMessage({
        id: 'reused-id',
        stanzaId: 'departed-archive',
        occupantId: 'occ-alice-1',
      })
      await retractRoomMessageInStorage(ROOM, departed, { retractedAt: new Date() })

      const reassigned = roomMessage({
        id: departed.id,
        stanzaId: 'reassigned-archive',
        occupantId: 'occ-alice-2',
        body: 'innocent ytterbium',
      })
      await messageCache.saveRoomMessage(reassigned)
      await searchIndex.indexMessage(reassigned)

      expect((await messageCache.getRoomMessage(ROOM, reassigned.id))?.body).toBe('innocent ytterbium')
      expect((await messageCache.getRoomMessage(ROOM, reassigned.id))?.isRetracted).toBeFalsy()
      expect(await searchIndex.search('ytterbium')).toHaveLength(1)
    })

    it('does not use equal body and timestamp as composite document ownership', async () => {
      const departed = roomMessage({
        id: 'shared-id',
        occupantId: 'occ-alice-1',
        body: 'OK',
      })
      await searchIndex.indexMessage(departed)

      const reassigned = roomMessage({
        id: 'shared-id',
        occupantId: 'occ-alice-2',
        stanzaId: 'archive-recent',
        body: 'OK',
      })
      await messageCache.saveRoomMessage(reassigned)
      await searchIndex.indexMessage(reassigned)

      await retractRoomMessageInStorage(ROOM, reassigned, { retractedAt: new Date() })

      expect(await searchIndex.search('OK')).toEqual([
        expect.objectContaining({ indexId: `room:${ROOM}:${departed.from}:shared-id` }),
      ])
    })

    it('does not fall through from an unauthorized room stanza tier to a client-id tier', async () => {
      const authoritative = roomMessage({
        id: 'authoritative-row',
        stanzaId: 'shared-reference',
        occupantId: 'occ-alice-1',
        body: 'authoritative body',
      })
      const lowerTier = roomMessage({
        id: 'shared-reference',
        stanzaId: 'other-archive',
        occupantId: 'occ-alice-2',
        body: 'lower tier body',
      })
      await messageCache.saveRoomMessages([authoritative, lowerTier])
      await searchIndex.indexMessages([authoritative, lowerTier])

      roomStore.getState().recordPendingRetraction(
        ROOM,
        'shared-reference',
        lowerTier.from,
        'occ-alice-2'
      )
      await settle()

      await messageCache.saveRoomMessage(lowerTier)

      expect(roomStore.getState().pendingRetractions.get(ROOM)).toBeUndefined()
      expect((await messageCache.getRoomMessage(ROOM, authoritative.id))?.isRetracted).toBeFalsy()
      expect((await messageCache.getRoomMessage(ROOM, lowerTier.id))?.isRetracted).toBeFalsy()
      expect((await messageCache.getRoomMessage(ROOM, lowerTier.id))?.body).toBe('lower tier body')
      expect(await searchIndex.search('lower tier')).toHaveLength(1)
    })

    it('does not fall through from an unauthorized chat stanza tier to a client-id tier', async () => {
      const authoritative = chatMessage({
        id: 'authoritative-row',
        stanzaId: 'shared-reference',
        body: 'authoritative body',
      })
      const lowerTier = chatMessage({
        id: 'shared-reference',
        stanzaId: 'other-archive',
        from: 'mallory@montague.example',
        body: 'lower tier body',
      })
      await messageCache.saveMessages([authoritative, lowerTier])
      await searchIndex.indexMessages([authoritative, lowerTier])

      chatStore.getState().recordPendingRetraction(
        CHAT,
        'shared-reference',
        lowerTier.from
      )
      await settle()

      await messageCache.saveMessage(lowerTier)

      expect(chatStore.getState().pendingRetractions.get(CHAT)).toBeUndefined()
      expect((await messageCache.getMessage(authoritative.id))?.isRetracted).toBeFalsy()
      expect((await messageCache.getMessage(lowerTier.id))?.isRetracted).toBeFalsy()
      expect((await messageCache.getMessage(lowerTier.id))?.body).toBe('lower tier body')
      expect(await searchIndex.search('lower tier')).toHaveLength(1)
    })

    it('keeps a canonical stanza document owned by another room', async () => {
      const otherRoomMessage = roomMessage({
        roomJid: OTHER_ROOM,
        from: `${OTHER_ROOM}/alice`,
        stanzaId: 'shared-archive-id',
        body: `the ${OTHER_SECRET} shipment`,
      })
      await searchIndex.indexMessage(otherRoomMessage)

      const target = roomMessage({
        stanzaId: 'shared-archive-id',
        occupantId: 'occ-alice',
      })
      await messageCache.saveRoomMessage(target)
      await retractRoomMessageInStorage(ROOM, target, { retractedAt: new Date() })

      expect(await searchIndex.search(OTHER_SECRET)).toHaveLength(1)
    })

    it('refuses a retraction whose occupant id does not match the cached row', async () => {
      const departed = roomMessage({
        id: 'shared-id',
        stanzaId: 'archive-old',
        occupantId: 'occ-alice-1',
      })
      await messageCache.saveRoomMessage(departed)
      await searchIndex.indexMessage(departed)

      // The nick's new owner cannot retract what the previous owner wrote, even
      // though room, nick and client id all match.
      roomStore.getState().recordPendingRetraction(ROOM, 'shared-id', departed.from, 'occ-alice-2')
      await settle()

      expect((await messageCache.getRoomMessage(ROOM, 'shared-id'))?.body).toContain(SECRET)
      expect(await searchIndex.search(SECRET)).toHaveLength(1)
    })

    it('accepts the same retraction from the occupant that wrote it', async () => {
      const departed = roomMessage({
        id: 'shared-id',
        stanzaId: 'archive-old',
        occupantId: 'occ-alice-1',
      })
      await messageCache.saveRoomMessage(departed)
      await searchIndex.indexMessage(departed)

      roomStore.getState().recordPendingRetraction(ROOM, 'shared-id', departed.from, 'occ-alice-1')
      await settle()

      await expectNoTraceOf(SECRET)
    })
  })

  // ===========================================================================
  // Case 4 — a resident retraction racing the target's own durable write
  // ===========================================================================

  describe('retraction racing the cache write', () => {
    it('does not let a 1:1 save that lands after the retraction store the body', async () => {
      const message = chatMessage()
      // The retraction reaches the cache first and finds nothing to tombstone;
      // the target's own write is still queued behind it.
      const retraction = retractChatMessageInStorage(CHAT, message, { retractedAt: new Date() })
      const save = messageCache.saveMessage(message)
      const index = searchIndex.indexMessage(message)

      await Promise.all([retraction, save, index])
      await settle()

      expect((await messageCache.getMessage(message.id))?.isRetracted).toBe(true)
      await expectNoTraceOf(SECRET)
    })

    it('does not let a room save that lands after the retraction store the body', async () => {
      const message = roomMessage({ stanzaId: 'archive-1', occupantId: 'occ-alice' })
      const retraction = retractRoomMessageInStorage(ROOM, message, { retractedAt: new Date() })
      const save = messageCache.saveRoomMessage(message)
      const index = searchIndex.indexMessage(message)

      await Promise.all([retraction, save, index])
      await settle()

      expect((await messageCache.getRoomMessage(ROOM, message.id))?.isRetracted).toBe(true)
      await expectNoTraceOf(SECRET)
    })

    it('does not let a background catch-up write the body of an already-retracted 1:1 message', async () => {
      // Nothing cached and nothing resident: the retraction can only be recorded.
      const message = chatMessage()
      chatStore.getState().recordPendingRetraction(CHAT, message.id, CHAT)
      await settle()

      // MAM then fetches the range for a conversation the user never opens, so
      // the pending record is never replayed against a resident window.
      await messageCache.saveMessages([message])
      await searchIndex.indexMessages([message])

      expect((await messageCache.getMessage(message.id))?.isRetracted).toBe(true)
      await expectNoTraceOf(SECRET)
    })

    it('does not let a background catch-up write the body of an already-retracted room message', async () => {
      const message = roomMessage({ stanzaId: 'archive-1', occupantId: 'occ-alice' })
      roomStore.getState().recordPendingRetraction(ROOM, 'archive-1', message.from, 'occ-alice')
      await settle()

      await messageCache.saveRoomMessages([message])
      await searchIndex.indexMessages([message])

      expect((await messageCache.getRoomMessage(ROOM, message.id))?.isRetracted).toBe(true)
      await expectNoTraceOf(SECRET)
    })

    it('retains an unresolved actor after an unauthorized lower-tier write', async () => {
      const target = roomMessage({
        id: 'author-copy',
        stanzaId: 'ambiguous-reference',
        occupantId: 'occ-alice',
      })
      roomStore.getState().recordPendingRetraction(
        ROOM,
        target.stanzaId!,
        target.from,
        target.occupantId
      )
      await settle()

      const unrelated = roomMessage({
        id: target.stanzaId!,
        stanzaId: undefined,
        from: `${ROOM}/bob`,
        nick: 'bob',
        occupantId: 'occ-bob',
        body: 'innocent zirconium',
      })
      await messageCache.saveRoomMessage(unrelated)
      await searchIndex.indexMessage(unrelated)
      await messageCache.saveRoomMessage(target)
      await searchIndex.indexMessage(target)

      expect((await messageCache.getRoomMessage(ROOM, unrelated.id))?.body).toBe('innocent zirconium')
      expect((await messageCache.getRoomMessage(ROOM, target.id))?.isRetracted).toBe(true)
      expect(await searchIndex.search('zirconium')).toHaveLength(1)
      await expectNoTraceOf(SECRET)
    })

    it('retains the durable pending record after an unauthorized resident match', async () => {
      const target = roomMessage({
        id: 'resident-author-copy',
        stanzaId: 'resident-ambiguous-reference',
        occupantId: 'occ-alice',
      })
      const unrelated = roomMessage({
        id: target.stanzaId!,
        stanzaId: undefined,
        from: `${ROOM}/bob`,
        nick: 'bob',
        occupantId: 'occ-bob',
        body: 'innocent tantalum',
      })
      roomStore.getState().addRoom(room(), [])
      roomStore.getState().recordPendingRetraction(
        ROOM,
        target.stanzaId!,
        target.from,
        target.occupantId
      )
      await settle()

      roomStore.getState().addMessage(ROOM, unrelated)
      expect(roomStore.getState().pendingRetractions.get(ROOM)).toHaveLength(1)

      roomStore.getState().addMessage(ROOM, target)
      const residentTarget = roomStore.getState().messages.get(ROOM)?.find(
        (message) => message.id === target.id
      )
      expect(residentTarget?.isRetracted).toBe(true)
      expect(roomStore.getState().pendingRetractions.get(ROOM) ?? []).toHaveLength(0)
    })

    it('retains an unresolved actor after an unauthorized cache probe', async () => {
      const target = chatMessage({ id: 'author-copy', stanzaId: 'ambiguous-chat-reference' })
      const unrelated = chatMessage({
        id: target.stanzaId!,
        stanzaId: undefined,
        from: 'mallory@montague.example',
        body: 'innocent niobium',
      })
      await messageCache.saveMessage(unrelated)
      await searchIndex.indexMessage(unrelated)

      chatStore.getState().recordPendingRetraction(CHAT, target.stanzaId!, target.from)
      await settle()
      await messageCache.saveMessage(target)
      await searchIndex.indexMessage(target)

      expect((await messageCache.getMessage(unrelated.id))?.body).toBe('innocent niobium')
      expect((await messageCache.getMessage(target.id))?.isRetracted).toBe(true)
      expect(await searchIndex.search('niobium')).toHaveLength(1)
      await expectNoTraceOf(SECRET)
    })

    it('does not let a later MAM re-delivery resurrect a retracted body', async () => {
      const message = chatMessage()
      await messageCache.saveMessage(message)
      await retractChatMessageInStorage(CHAT, message, { retractedAt: new Date() })

      // A later run has no ledger: the tombstoned row is the only evidence left.
      _clearRetractedIdentitiesForTesting()

      // The archive hands the message back, body and all.
      await messageCache.saveMessage(message)
      await searchIndex.indexMessage(message)

      expect((await messageCache.getMessage(message.id))?.isRetracted).toBe(true)
      await expectNoTraceOf(SECRET)
    })

    it('does not let a later MAM re-delivery resurrect a retracted room body', async () => {
      const message = roomMessage({ stanzaId: 'archive-1', occupantId: 'occ-alice' })
      await messageCache.saveRoomMessage(message)
      await retractRoomMessageInStorage(ROOM, message, { retractedAt: new Date() })

      _clearRetractedIdentitiesForTesting()

      await messageCache.saveRoomMessage(message)
      await searchIndex.indexMessage(message)

      expect((await messageCache.getRoomMessage(ROOM, message.id))?.isRetracted).toBe(true)
      await expectNoTraceOf(SECRET)
    })

    it('finds an earlier room tombstone through a lower identity tier', async () => {
      const early = roomMessage({ occupantId: 'occ-alice' })
      await messageCache.saveRoomMessage(early)
      await retractRoomMessageInStorage(ROOM, early, { retractedAt: new Date() })
      _clearRetractedIdentitiesForTesting()

      const redelivered = { ...early, stanzaId: 'archive-late' }
      await searchIndex.indexMessage(redelivered)
      await messageCache.saveRoomMessage(redelivered)

      expect((await messageCache.getRoomMessage(ROOM, early.id))?.isRetracted).toBe(true)
      await expectNoTraceOf(SECRET)
    })

    it('rechecks the ledger immediately before single and batched index writes', async () => {
      const single = chatMessage({ id: 'single-race', body: 'single promethium' })
      const batch = Array.from({ length: 51 }, (_, index) =>
        chatMessage({
          id: `batch-race-${index}`,
          body: index === 50 ? 'last technetium' : `ordinary batch ${index}`,
        })
      )
      const cacheCheck = vi.spyOn(messageCache, 'areRetractedInCache')
      cacheCheck.mockImplementationOnce(async (messages) => {
        noteRetractedIdentity(
          { kind: 'chat', entityId: CHAT, accountScope: SCOPE },
          chatRetractionAliases(messages[0] as Message),
          messages[0] as Message,
          Date.now()
        )
        return messages.map(() => false)
      })

      await searchIndex.indexMessage(single)

      cacheCheck.mockImplementationOnce(async (messages) => {
        const last = messages[messages.length - 1] as Message
        noteRetractedIdentity(
          { kind: 'chat', entityId: CHAT, accountScope: SCOPE },
          chatRetractionAliases(last),
          last,
          Date.now()
        )
        return messages.map(() => false)
      })
      await searchIndex.indexMessages(batch)

      expect(await searchIndex.search('promethium')).toEqual([])
      expect(await searchIndex.search('technetium')).toEqual([])
    })

    it('does not apply a verified stanza alias to an unrelated chat client id', async () => {
      const retracted = chatMessage({ id: 'original-id', stanzaId: 'shared-raw-id' })
      await retractChatMessageInStorage(CHAT, retracted, { retractedAt: new Date() })

      const unrelated = chatMessage({
        id: 'shared-raw-id',
        stanzaId: undefined,
        body: 'unrelated hafnium',
      })
      await messageCache.saveMessage(unrelated)

      expect((await messageCache.getMessage(unrelated.id))?.body).toBe('unrelated hafnium')
      expect((await messageCache.getMessage(unrelated.id))?.isRetracted).toBeFalsy()
    })

    it('does not apply a verified stanza alias to an unrelated room client id', async () => {
      const retracted = roomMessage({
        id: 'original-room-id',
        stanzaId: 'shared-room-raw-id',
        occupantId: 'occ-alice',
      })
      await retractRoomMessageInStorage(ROOM, retracted, { retractedAt: new Date() })

      const unrelated = roomMessage({
        id: 'shared-room-raw-id',
        stanzaId: undefined,
        occupantId: 'occ-bob',
        from: `${ROOM}/bob`,
        nick: 'bob',
        body: 'unrelated lutetium',
      })
      await messageCache.saveRoomMessage(unrelated)

      expect((await messageCache.getRoomMessage(ROOM, unrelated.id))?.body).toBe('unrelated lutetium')
      expect((await messageCache.getRoomMessage(ROOM, unrelated.id))?.isRetracted).toBeFalsy()
    })

    it('keeps competing pending actors until an authorized chat actor matches', async () => {
      const message = chatMessage({ id: 'competing-chat-actors' })
      chatStore.getState().recordPendingRetraction(CHAT, message.id, 'mallory@example.com')
      await settle()
      chatStore.getState().recordPendingRetraction(CHAT, message.id, message.from)
      await settle()

      await messageCache.saveMessage(message)
      await searchIndex.indexMessage(message)

      expect((await messageCache.getMessage(message.id))?.isRetracted).toBe(true)
      await expectNoTraceOf(SECRET)
    })

    it('keeps competing pending actors until an authorized room occupant matches', async () => {
      const message = roomMessage({ id: 'competing-room-actors', occupantId: 'occ-alice' })
      roomStore.getState().recordPendingRetraction(ROOM, message.id, message.from, 'occ-mallory')
      await settle()
      roomStore.getState().recordPendingRetraction(ROOM, message.id, message.from, message.occupantId)
      await settle()

      await messageCache.saveRoomMessage(message)
      await searchIndex.indexMessage(message)

      expect((await messageCache.getRoomMessage(ROOM, message.id))?.isRetracted).toBe(true)
      await expectNoTraceOf(SECRET)
    })

    it('finds a chat tombstone through stanza and origin identity tiers', async () => {
      const stanzaTarget = chatMessage({ id: 'stanza-old', stanzaId: 'shared-stanza' })
      const originTarget = chatMessage({ id: 'origin-old', originId: 'shared-origin' })
      await messageCache.saveMessages([stanzaTarget, originTarget])
      await retractChatMessageInStorage(CHAT, stanzaTarget, { retractedAt: new Date() })
      await retractChatMessageInStorage(CHAT, originTarget, { retractedAt: new Date() })
      _clearRetractedIdentitiesForTesting()

      const stanzaCopy = { ...stanzaTarget, id: 'stanza-new', body: 'stanza dysprosium' }
      const originCopy = { ...originTarget, id: 'origin-new', body: 'origin erbium' }
      await messageCache.saveMessages([stanzaCopy, originCopy])
      await searchIndex.indexMessages([stanzaCopy, originCopy])

      expect((await messageCache.getMessage(stanzaCopy.id))?.isRetracted).toBe(true)
      expect((await messageCache.getMessage(originCopy.id))?.isRetracted).toBe(true)
      expect(await searchIndex.search('dysprosium')).toEqual([])
      expect(await searchIndex.search('erbium')).toEqual([])
    })

    it('cleans the transitive chat identity closure after resolving one stanza', async () => {
      const first = chatMessage({
        id: 'closure-first',
        stanzaId: 'closure-stanza-1',
        originId: 'closure-origin-1',
      })
      const bridge = chatMessage({
        id: 'closure-bridge',
        stanzaId: 'closure-stanza-2',
        originId: first.originId,
      })
      const last = chatMessage({
        id: 'closure-last',
        stanzaId: bridge.stanzaId,
        originId: 'closure-origin-2',
      })
      await messageCache.saveMessages([first, bridge, last])
      await searchIndex.indexMessages([first, bridge, last])

      await retractChatMessageInStorage(
        CHAT,
        first,
        { retractedAt: new Date() },
        SCOPE,
        first.stanzaId
      )

      for (const message of [first, bridge, last]) {
        expect((await messageCache.getMessage(message.id))?.body).toBe('')
        expect((await messageCache.getMessage(message.id))?.isRetracted).toBe(true)
      }
      await expectNoTraceOf(SECRET)
    })

    it('removes resolved chat pending state before a lower-tier id can reuse it', async () => {
      const target = chatMessage({ id: 'resolved-chat-target', stanzaId: 'reused-chat-reference' })
      await messageCache.saveMessage(target)

      chatStore.getState().recordPendingRetraction(CHAT, target.stanzaId!, target.from)
      await settle()

      expect(chatStore.getState().pendingRetractions.get(CHAT) ?? []).toEqual([])
      const unrelated = chatMessage({
        id: target.stanzaId!,
        stanzaId: 'unrelated-chat-stanza',
        body: 'unrelated rhenium',
      })
      await messageCache.saveMessage(unrelated)
      expect((await messageCache.getMessage(unrelated.id))?.body).toBe('unrelated rhenium')
      expect((await messageCache.getMessage(unrelated.id))?.isRetracted).toBeFalsy()
    })

    it('removes resolved room pending state before a lower-tier id can reuse it', async () => {
      const target = roomMessage({
        id: 'resolved-room-target',
        stanzaId: 'reused-room-reference',
        occupantId: 'resolved-room-occupant',
      })
      await messageCache.saveRoomMessage(target)

      roomStore.getState().recordPendingRetraction(
        ROOM,
        target.stanzaId!,
        target.from,
        target.occupantId
      )
      await settle()

      expect(roomStore.getState().pendingRetractions.get(ROOM) ?? []).toEqual([])
      const unrelated = roomMessage({
        id: target.stanzaId!,
        stanzaId: 'unrelated-room-stanza',
        occupantId: target.occupantId,
        body: 'unrelated osmium',
      })
      await messageCache.saveRoomMessage(unrelated)
      expect((await messageCache.getRoomMessage(ROOM, unrelated.id, unrelated.from))?.body).toBe('unrelated osmium')
      expect((await messageCache.getRoomMessage(ROOM, unrelated.id, unrelated.from))?.isRetracted).toBeFalsy()
    })

    it('retains competing room actors for separate messages sharing a client id', async () => {
      const alice = roomMessage({
        id: 'shared-pending-client-id',
        stanzaId: undefined,
        occupantId: 'shared-pending-alice',
      })
      const bob = roomMessage({
        id: alice.id,
        stanzaId: undefined,
        from: `${ROOM}/bob`,
        nick: 'bob',
        occupantId: 'shared-pending-bob',
      })
      roomStore.getState().recordPendingRetraction(ROOM, alice.id, alice.from, alice.occupantId)
      roomStore.getState().recordPendingRetraction(ROOM, bob.id, bob.from, bob.occupantId)
      await settle()

      await messageCache.saveRoomMessage(alice)
      expect((await messageCache.getRoomMessage(ROOM, alice.id, alice.from))?.isRetracted).toBe(true)

      await messageCache.saveRoomMessage(bob)
      expect((await messageCache.getRoomMessage(ROOM, bob.id, bob.from))?.isRetracted).toBe(true)
      expect((await messageCache.getRoomMessage(ROOM, alice.id, alice.from))?.body).toBe('')
      expect((await messageCache.getRoomMessage(ROOM, bob.id, bob.from))?.body).toBe('')
    })
  })

  describe('account scope continuity', () => {
    it('keeps single and batched index writes in their starting account', async () => {
      const single = chatMessage({ id: 'scope-single', body: 'single cobalt' })
      const batch = chatMessage({ id: 'scope-batch', body: 'batch iridium' })
      const cacheCheck = vi.spyOn(messageCache, 'areRetractedInCache')
      cacheCheck.mockImplementationOnce(async (messages, scopeJid) => {
        expect(scopeJid).toBe(SCOPE)
        setStorageScopeJid(OTHER_SCOPE)
        return messages.map(() => false)
      })

      await searchIndex.indexMessage(single)

      setStorageScopeJid(SCOPE)
      cacheCheck.mockImplementationOnce(async (messages, scopeJid) => {
        expect(scopeJid).toBe(SCOPE)
        setStorageScopeJid(OTHER_SCOPE)
        return messages.map(() => false)
      })
      await searchIndex.indexMessages([batch])

      expect(await searchInScope(SCOPE, 'cobalt')).toHaveLength(1)
      expect(await searchInScope(SCOPE, 'iridium')).toHaveLength(1)
      expect(await searchInScope(OTHER_SCOPE, 'cobalt')).toEqual([])
      expect(await searchInScope(OTHER_SCOPE, 'iridium')).toEqual([])
    })

    it('removes from the account where the retraction started', async () => {
      const target = chatMessage({ id: 'shared-account-id', body: 'alpha tungsten' })
      await messageCache.saveMessage(target)
      await searchIndex.indexMessage(target)

      setStorageScopeJid(OTHER_SCOPE)
      await searchIndex.initSearchIndex(OTHER_SCOPE)
      const other = chatMessage({ id: target.id, body: 'beta vanadium' })
      await messageCache.saveMessage(other)
      await searchIndex.indexMessage(other)

      setStorageScopeJid(SCOPE)
      const updateMessage = messageCache.updateMessage
      vi.spyOn(messageCache, 'updateMessage').mockImplementationOnce(async (...args) => {
        await updateMessage(...args)
        setStorageScopeJid(OTHER_SCOPE)
      })

      await retractChatMessageInStorage(CHAT, target, { retractedAt: new Date() })

      expect(await searchInScope(SCOPE, 'tungsten')).toEqual([])
      expect(await searchInScope(OTHER_SCOPE, 'vanadium')).toHaveLength(1)
    })

    it('keeps chat and room reaction writes in their starting account scope', async () => {
      const chat = chatMessage({ id: 'reaction-chat' })
      const roomTarget = roomMessage({ id: 'reaction-room', occupantId: 'occ-alice' })
      await messageCache.saveMessage(chat)
      await messageCache.saveRoomMessage(roomTarget)
      noteRetractedIdentity(
        { kind: 'chat', entityId: CHAT, accountScope: SCOPE },
        chatRetractionAliases(chat),
        chat,
        Date.now()
      )
      noteRetractedIdentity(
        { kind: 'room', entityId: ROOM, accountScope: SCOPE },
        roomRetractionAliases(roomTarget),
        roomTarget,
        Date.now()
      )

      setStorageScopeJid(SCOPE)
      await messageCache.updateMessageReactions(
        CHAT,
        chat.id,
        'benvolio@example.com',
        switchScopeWhileIterating(OTHER_SCOPE)
      )
      setStorageScopeJid(SCOPE)
      await messageCache.updateRoomMessageReactions(
        ROOM,
        roomTarget.id,
        `${ROOM}/benvolio`,
        switchScopeWhileIterating(OTHER_SCOPE)
      )
      setStorageScopeJid(SCOPE)

      expect((await messageCache.getMessage(chat.id))?.isRetracted).toBe(true)
      expect((await messageCache.getRoomMessage(ROOM, roomTarget.id))?.isRetracted).toBe(true)
      await expectNoTraceOf(SECRET)
    })
  })

  // ===========================================================================
  // No regression on history reload or on search
  // ===========================================================================

  describe('history reload and search are unaffected', () => {
    it('reloads the tombstone from the cache into the resident window', async () => {
      const kept = chatMessage({ id: 'chat-kept', body: 'an ordinary line', timestamp: new Date(1_699_999_000_000) })
      const message = chatMessage()
      await messageCache.saveMessages([kept, message])
      await searchIndex.indexMessages([kept, message])

      chatStore.getState().recordPendingRetraction(CHAT, message.id, CHAT)
      await settle()

      await chatStore.getState().loadMessagesFromCache(CHAT)
      const resident = chatStore.getState().messages.get(CHAT) ?? []
      expect(resident.map((m) => m.id)).toEqual(['chat-kept', 'chat-1'])
      expect(resident[1].isRetracted).toBe(true)
      expect(resident[0].body).toBe('an ordinary line')
      expect(await searchIndex.search('ordinary')).toHaveLength(1)
    })

    it('keeps the XEP-0425 moderator fields the same update carries', async () => {
      const message = roomMessage({ stanzaId: 'archive-1', occupantId: 'occ-alice' })
      await messageCache.saveRoomMessage(message)
      await searchIndex.indexMessage(message)
      roomStore.getState().addRoom(room(), [message])

      roomStore.getState().updateMessage(ROOM, 'archive-1', {
        isRetracted: true,
        retractedAt: new Date(),
        isModerated: true,
        moderatedBy: 'friar',
        moderationReason: 'off topic',
      })
      await settle()

      const stored = await messageCache.getRoomMessage(ROOM, message.id)
      expect(stored?.isModerated).toBe(true)
      expect(stored?.moderatedBy).toBe('friar')
      expect(stored?.moderationReason).toBe('off topic')
      await expectNoTraceOf(SECRET)
    })

    it('leaves other room messages searchable and intact', async () => {
      const kept = roomMessage({ id: 'room-kept', stanzaId: 'archive-kept', body: 'an ordinary line', occupantId: 'occ-bob', from: `${ROOM}/bob`, nick: 'bob' })
      const message = roomMessage({ stanzaId: 'archive-1', occupantId: 'occ-alice' })
      await messageCache.saveRoomMessages([kept, message])
      await searchIndex.indexMessages([kept, message])
      roomStore.getState().addRoom(room(), [])

      roomStore.getState().recordPendingRetraction(ROOM, 'archive-1', message.from, 'occ-alice')
      await settle()

      expect((await messageCache.getRoomMessage(ROOM, 'room-kept'))?.body).toBe('an ordinary line')
      expect(await searchIndex.search('ordinary')).toHaveLength(1)
      await expectNoTraceOf(SECRET)
    })
  })
})
