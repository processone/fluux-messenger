/**
 * Two messages from one sender sharing a client id, told apart by their archive
 * ids, against the real cache on fake IndexedDB: each must be held as its own
 * row, found by its own anchor, and written or deleted only through its own
 * identity — from the cache API and from the chat store's resident mutators.
 * The room tests pin the witness behaviour the chat side mirrors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { Message, RoomMessage, SDKEvents, StoreBindings } from '../core/types'
import * as cache from './messageCache'
import * as searchIndex from './searchIndex'
import { _clearRetractedIdentitiesForTesting } from './retractedIdentities'
import { _resetStorageScopeForTesting, buildScopedStorageKey, setStorageScopeJid } from './storageScope'
import { chatStore } from '../stores/chatStore'
import { Chat } from '../core/modules/Chat'
import { MAM } from '../core/modules/MAM'
import type { ModuleDependencies } from '../core/modules/BaseModule'
import { createPresenceReader } from '../core/presenceReader'
import { createStoreBindings, type StoreRefs } from '../bindings/storeBindings'
import type { SDKEventSource } from '../core/types/eventSource'
import { xml, type Element } from '@xmpp/client'
import { localStorageMock } from '../core/sideEffects.testHelpers'
import { flush as flushThrottledStorage } from '../stores/shared/throttledStorage'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

const SCOPE = 'twins@example.test'
const CONV = 'alice@example.test'
const ROOM = 'room@conference.example.test'
const T = 1_700_000_000_000

function chat(over: Partial<Message>): Message {
  return {
    type: 'chat', id: 'X', conversationId: CONV, from: CONV, originId: undefined, stanzaId: undefined,
    body: 'body', timestamp: new Date(T), isOutgoing: false, ...over,
  }
}

function room(over: Partial<RoomMessage>): RoomMessage {
  return {
    type: 'groupchat', roomJid: ROOM, from: `${ROOM}/nick`, nick: 'nick', id: 'X', originId: undefined,
    stanzaId: undefined, occupantId: undefined, body: 'b', timestamp: new Date(T), isOutgoing: false, ...over,
  }
}

const first = () => chat({ stanzaId: 's1', body: 'first apple' })
const second = () => chat({ stanzaId: 's2', body: 'second banana', timestamp: new Date(T + 1000) })
const stored = async () => cache.getMessages(CONV, {})

/** Fake IndexedDB completes each request on a macrotask; the stores' durable writes are fire-and-forget. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(async () => {
  _resetStorageScopeForTesting()
  globalThis.indexedDB = new IDBFactory()
  cache._resetDBForTesting()
  searchIndex._resetDBForTesting()
  _clearRetractedIdentitiesForTesting()
  localStorage.clear()
  setStorageScopeJid(SCOPE)
  chatStore.setState({
    conversationEntities: new Map(), conversationMeta: new Map(), conversations: new Map(),
    messages: new Map(), activeConversationId: null, windowAtLiveEdge: new Map(),
    pendingRetractions: new Map(), conversationCoverage: new Map(), conversationGaps: new Map(),
    mamQueryStates: new Map(),
  })
  await cache.saveMessages([first(), second()])
})
afterEach(() => cache._resetDBForTesting())

describe('cached chat rows sharing a client id', () => {
  it('prefers the supplied stanza over an earlier origin-only twin', async () => {
    await cache.clearAllMessages()
    const originOnly = chat({ originId: 'oB', body: 'origin-only apple' })
    const archived = chat({ stanzaId: 's2', originId: 'oA', body: 'archived banana', timestamp: new Date(T + 1000) })
    await cache.saveMessages([originOnly, archived])
    const held = { ...archived, originId: 'oB' }

    expect(await cache.getMessage(CONV, 'X', held)).toMatchObject(archived)
    expect(await cache.getMessagesAround(CONV, held, { before: 0, after: 0 })).toMatchObject([archived])
    await cache.updateMessage(CONV, 'X', { body: 'updated banana' }, CONV, SCOPE, held)

    expect(await stored()).toMatchObject([originOnly, { ...archived, body: 'updated banana' }])
  })

  it.each(['single', 'batch', 'identity-update'] as const)('preserves search documents of skipped merge candidates on %s', async path => {
    await searchIndex.indexMessages([first(), second()])
    const incoming = chat({ body: 'first apple' })
    if (path === 'single') await cache.saveMessage(incoming)
    else if (path === 'batch') await cache.saveMessages([incoming])
    else {
      await cache.saveMessage({ ...incoming, id: 'Y' })
      await searchIndex.indexMessage({ ...incoming, id: 'Y' })
      await cache.updateMessage(CONV, 'Y', { id: 'X' }, CONV)
    }
    expect((await stored()).map(row => row.stanzaId)).toEqual(['s1', 's2'])
    expect(await searchIndex.search('apple')).toMatchObject([{ stanzaId: 's1', body: 'first apple' }])
    expect(await searchIndex.search('banana')).toMatchObject([{ stanzaId: 's2', body: 'second banana' }])
  })

  it('selects the shared stanza despite a different held origin across cache operations', async () => {
    await cache.updateMessage(CONV, 'X', { originId: 'oA' }, CONV, undefined, second())
    const selected = { ...second(), originId: 'oB' }
    expect(await cache.getMessage(CONV, 'X', selected)).toMatchObject({ stanzaId: 's2', originId: 'oA' })
    expect(await cache.updateMessageReactions(CONV, 's2', SCOPE, ['🍌'], selected)).toBe(true)
    await cache.updateMessage(CONV, 'X', { linkPreview: { url: 'https://example.test/second' } }, CONV, undefined, selected)
    expect(await cache.applyChatCorrection(CONV, 's2', { body: 'edited banana', isEdited: true }, { actorJid: CONV }, SCOPE, selected))
      .toMatchObject({ stanzaId: 's2', body: 'edited banana' })
    expect(await cache.getMessage(CONV, 'X', selected)).toMatchObject({
      body: 'edited banana', reactions: { '🍌': [SCOPE] }, linkPreview: { url: 'https://example.test/second' },
    })
    expect(await cache.getMessage(CONV, 'X', first())).toMatchObject(first())
    await cache.deleteMessage(CONV, 'X', CONV, SCOPE, selected)
    expect(await stored()).toMatchObject([first()])
  })

  it('anchors each origin-only twin without falling back to the other twin', async () => {
    await cache.clearAllMessages()
    const twins = ['o1', 'o2'].map((originId, index) => chat({ originId, body: `twin ${index}`, timestamp: new Date(T + index) }))
    await cache.saveMessages(twins)
    for (const twin of twins) {
      expect(await cache.getMessagesAround(CONV, twin, { before: 0, after: 0 })).toMatchObject([twin])
    }
    expect(await cache.getMessagesAround(CONV, { id: 'X', originId: 'missing' })).toEqual([])
  })
  it('holds both rows and windows around either one', async () => {
    expect((await stored()).map(m => [m.stanzaId, m.body])).toEqual([['s1', 'first apple'], ['s2', 'second banana']])
    expect((await cache.getMessagesAround(CONV, { id: 'X' }, { before: 10 })).map(m => m.stanzaId)).toEqual(['s1', 's2'])
    expect((await cache.getMessagesAround(CONV, { id: 'X', stanzaId: 's2' }, { before: 0 })).map(m => m.stanzaId)).toEqual(['s2'])
    expect((await cache.getMessagesAround(CONV, { id: 's2' }, { before: 0 })).map(m => m.stanzaId)).toEqual(['s2'])
  })

  it('reacts, previews and updates the twin its identity names', async () => {
    expect(await cache.updateMessageReactions(CONV, 's2', 'bob@example.test', ['👍'])).toBe(true)
    await cache.updateMessage(CONV, 'X', { linkPreview: { url: 'https://x' } as never }, CONV, undefined, { stanzaId: 's2' })
    const rows = await stored()
    expect(rows.filter(r => r.reactions && Object.keys(r.reactions).length).map(r => r.stanzaId)).toEqual(['s2'])
    expect(rows.filter(r => r.linkPreview).map(r => r.stanzaId)).toEqual(['s2'])
  })

  it('deletes the twin its identity names', async () => {
    await cache.deleteMessage(CONV, 'X', CONV, undefined, { stanzaId: 's2' })
    expect((await stored()).map(r => r.stanzaId)).toEqual(['s1'])
  })

  it('writes nothing when the held identity contradicts every row', async () => {
    await cache.updateMessage(CONV, 'X', { body: 'stray' }, CONV, undefined, { stanzaId: 's3' })
    await cache.deleteMessage(CONV, 'X', CONV, undefined, { stanzaId: 's3' })
    expect((await stored()).map(r => [r.stanzaId, r.body])).toEqual([['s1', 'first apple'], ['s2', 'second banana']])
    expect(await cache.getMessage(CONV, 'X', { stanzaId: 's3' })).toBeNull()
  })

  it('still updates a row the held copy has no archive id for yet', async () => {
    await cache.saveMessage(chat({ id: 'Y', body: 'local echo', timestamp: new Date(T + 2000) }))
    await cache.updateMessage(CONV, 'Y', { stanzaId: 's9' }, CONV, undefined, { stanzaId: 's9' })
    expect((await stored()).map(r => [r.id, r.stanzaId])).toEqual([['X', 's1'], ['X', 's2'], ['Y', 's9']])
  })
})

describe('chat store mutators against the real cache', () => {
  beforeEach(async () => {
    chatStore.setState({ messages: new Map(), activeConversationId: CONV, windowAtLiveEdge: new Map(), pendingRetractions: new Map() })
    await chatStore.getState().loadMessagesFromCache(CONV, { limit: 100 })
    expect(chatStore.getState().messages.get(CONV)?.map(m => m.stanzaId)).toEqual(['s1', 's2'])
  })

  it('removes the second twin from memory and from the cache', async () => {
    chatStore.getState().removeMessage(CONV, 's2')
    await settle()
    expect(chatStore.getState().messages.get(CONV)?.map(m => m.stanzaId)).toEqual(['s1'])
    expect((await stored()).map(r => r.stanzaId)).toEqual(['s1'])
  })

  it('uses shared stanza identity for resident actions and preview updates despite different origins', async () => {
    const cached = { ...second(), originId: 'oA' }
    const held = { ...second(), originId: 'oB' }
    await cache.saveMessage(cached)
    chatStore.setState({ messages: new Map([[CONV, [first(), cached]]]) })
    chatStore.getState().addConversation({ id: CONV, name: 'Alice', type: 'chat', unreadCount: 0, lastMessage: held })
    expect(chatStore.getState().getMessage(CONV, held)).toBe(cached)
    chatStore.getState().updateReactions(CONV, held, SCOPE, ['🍌'])
    chatStore.getState().updateMessage(CONV, held, { body: 'edited banana', isEdited: true }, undefined, { actorJid: CONV })
    await settle()
    expect(chatStore.getState().getMessage(CONV, held)).toMatchObject({ body: 'edited banana', reactions: { '🍌': [SCOPE] } })
    expect(await cache.getMessage(CONV, 'X', held)).toMatchObject({ body: 'edited banana', reactions: { '🍌': [SCOPE] } })
    expect(chatStore.getState().conversationMeta.get(CONV)?.lastMessage).toMatchObject({ body: 'edited banana', originId: 'oB' })
    chatStore.getState().refreshLastMessageContent(CONV, cached, { encryptedPayload: undefined, securityContext: { protocolId: 'dummy', trust: 'verified' } })
    expect(chatStore.getState().conversationMeta.get(CONV)?.lastMessage?.securityContext?.trust).toBe('verified')
    chatStore.getState().removeMessage(CONV, held)
    await settle()
    expect(chatStore.getState().messages.get(CONV)).toEqual([first()])
    expect(await stored()).toMatchObject([first()])
    expect(chatStore.getState().conversationMeta.get(CONV)?.lastMessage).toEqual(first())
  })

  it('hands cached content to a resident copy and preview with a different origin on the same stanza', async () => {
    const cached = { ...second(), originId: 'oA' }
    const held = { ...second(), originId: 'oB' }
    await cache.saveMessage(cached)
    chatStore.setState({ messages: new Map([[CONV, [first()]]]) })
    chatStore.getState().addConversation({ id: CONV, name: 'Alice', type: 'chat', unreadCount: 0, lastMessage: first() })
    chatStore.getState().updateMessage(CONV, held, { body: 'edited banana', isEdited: true }, undefined, { actorJid: CONV })
    chatStore.setState({ messages: new Map([[CONV, [first(), held]]]) })
    chatStore.getState().addConversation({ id: CONV, name: 'Alice', type: 'chat', unreadCount: 0, lastMessage: held })
    await settle()
    expect(chatStore.getState().getMessage(CONV, held)).toMatchObject({ body: 'edited banana', originId: 'oB' })
    expect(chatStore.getState().conversationMeta.get(CONV)?.lastMessage).toMatchObject({ body: 'edited banana', originId: 'oB' })
    expect(await cache.getMessage(CONV, 'X', held)).toMatchObject({ body: 'edited banana', originId: 'oA' })
  })

  it('persists an update and a reaction onto the second twin only', async () => {
    chatStore.getState().updateMessage(CONV, 's2', { body: 'recovered banana' })
    chatStore.getState().updateReactions(CONV, 's2', 'bob@example.test', ['🍌'])
    await settle()
    const rows = await stored()
    expect(rows.map(r => [r.stanzaId, r.body, Object.keys(r.reactions ?? {})])).toEqual([
      ['s1', 'first apple', []],
      ['s2', 'recovered banana', ['🍌']],
    ])
  })

  it('persists a live twin that arrives while the conversation is open', async () => {
    await cache.clearAllMessages()
    await cache.saveMessage(first())
    chatStore.setState({ messages: new Map() })
    await chatStore.getState().loadMessagesFromCache(CONV, { limit: 100 })
    chatStore.getState().addMessage(second())
    await settle()
    expect(chatStore.getState().messages.get(CONV)?.map(m => m.stanzaId)).toEqual(['s1', 's2'])
    expect((await stored()).map(r => r.stanzaId)).toEqual(['s1', 's2'])
  })
})

describe.each(['stanza', 'origin'] as const)('chat preview ownership for %s twins', identity => {
  describe.each([false, true])('selected row resident: %s', resident => {
    it.each([
      { action: 'retraction', previewIndex: 1 },
      { action: 'retraction', previewIndex: 0 },
      { action: 'correction', previewIndex: 1 },
      { action: 'correction', previewIndex: 0 },
      { action: 'actor-correction', previewIndex: 1 },
      { action: 'actor-correction', previewIndex: 0 },
    ])('$action updates only its preview (preview twin $previewIndex)', async ({ action, previewIndex }) => {
      await cache.clearAllMessages()
      const twins = [0, 1].map(index => chat({
        from: SCOPE, isOutgoing: true, body: index === 0 ? 'first' : 'second',
        timestamp: new Date(T + index * 1000),
        ...(identity === 'stanza' ? { stanzaId: `s${index + 1}`, originId: 'X' } : { originId: `o${index + 1}` }),
      }))
      await cache.saveMessages(twins)
      const held = resident ? twins : [twins[0]]
      chatStore.setState({ messages: new Map([[CONV, held]]), pendingRetractions: new Map() })
      chatStore.getState().addConversation({ id: CONV, name: 'Alice', type: 'chat', unreadCount: 0, lastMessage: twins[previewIndex] })
      const updates = action === 'retraction'
        ? { isRetracted: true, retractedAt: new Date(T + 2000) }
        : { body: 'edited second', isEdited: true }
      chatStore.getState().updateMessage(CONV, twins[1], updates, undefined, action === 'actor-correction' ? { actorJid: SCOPE } : undefined)
      await settle()

      const cached = await stored()
      expect(cached[0]).toMatchObject({ body: 'first' })
      expect(cached[0].isRetracted).toBeFalsy()
      expect(cached[1]).toMatchObject(action === 'retraction'
        ? { isRetracted: true, body: '' }
        : { body: 'edited second', isEdited: true })
      const preview = chatStore.getState().conversationMeta.get(CONV)?.lastMessage
      const expected = previewIndex === 0 ? { body: 'first' }
        : action === 'retraction' ? { body: '', isRetracted: true }
          : { body: 'edited second', originalBody: 'second', isEdited: true }
      expect(preview).toMatchObject({ id: 'X', stanzaId: twins[previewIndex].stanzaId, originId: twins[previewIndex].originId, ...expected })
      if (previewIndex === 0) expect(preview).toBe(twins[0])
      expect(chatStore.getState().conversations.get(CONV)?.lastMessage).toBe(preview)
      if (!resident) expect(chatStore.getState().messages.get(CONV)).toBe(held)
      else expect(chatStore.getState().messages.get(CONV)?.[1]).toMatchObject(updates)

      flushThrottledStorage()
      const persisted = JSON.parse(localStorageMock.getItem(buildScopedStorageKey('xmpp-chat-storage', SCOPE))!) as {
        state: { conversationMeta: Array<[string, { lastMessage: Message }]> }
      }
      const persistedPreview = persisted.state.conversationMeta.find(([id]) => id === CONV)?.[1].lastMessage
      expect(persistedPreview).toEqual(JSON.parse(JSON.stringify(preview)))
    })
  })
})

describe('chat preview archive backfill and cache handoff', () => {
  const twins = () => [
    chat({ from: SCOPE, isOutgoing: true, originId: 'o1', stanzaId: 's1', body: 'first' }),
    chat({ from: SCOPE, isOutgoing: true, originId: 'o2', stanzaId: 's2', body: 'second', timestamp: new Date(T + 1000) }),
  ]
  const preview = () => chatStore.getState().conversationMeta.get(CONV)?.lastMessage
  const assertPersistedPreview = () => {
    expect(chatStore.getState().conversations.get(CONV)?.lastMessage).toBe(preview())
    flushThrottledStorage()
    const persisted = JSON.parse(localStorageMock.getItem(buildScopedStorageKey('xmpp-chat-storage'))!) as {
      state: { conversationMeta: Array<[string, { lastMessage: Message }]> }
    }
    expect(persisted.state.conversationMeta.find(([id]) => id === CONV)?.[1].lastMessage)
      .toEqual(JSON.parse(JSON.stringify(preview())))
  }

  beforeEach(async () => {
    await cache.clearAllMessages()
    chatStore.setState({ messages: new Map(), activeConversationId: CONV, windowAtLiveEdge: new Map(), pendingRetractions: new Map() })
    chatStore.getState().addConversation({ id: CONV, name: 'Alice', type: 'chat', unreadCount: 0 })
  })

  it.each(['live', 'mam-backward', 'mam-forward', 'mam-backward-mixed', 'mam-forward-mixed', 'cache-latest', 'cache-around'])(
    'backfills through %s, then deletes the selected evicted twin and its persisted preview', async path => {
      const [first, second] = twins()
      chatStore.getState().addMessage(first)
      chatStore.getState().addMessage({ ...second, stanzaId: undefined })
      await settle()
      expect(preview()).toMatchObject({ originId: 'o2', stanzaId: undefined, body: 'second' })
      if (path === 'live') chatStore.getState().addMessage(second)
      else if (path.startsWith('mam')) {
        const page = path.endsWith('mixed')
          ? [chat({ id: 'older', body: 'older', timestamp: new Date(T - 1000) }), second]
          : [second]
        chatStore.getState().mergeMAMMessages(CONV, page, { first: 's2', last: 's2' }, true, path.includes('backward') ? 'backward' : 'forward')
      } else {
        await cache.saveMessage(second)
        if (path === 'cache-latest') await chatStore.getState().loadMessagesFromCache(CONV)
        else await chatStore.getState().loadMessagesAroundFromCache(CONV, { id: 'X', stanzaId: 's2' })
      }
      await settle()
      expect(preview()).toMatchObject({ originId: 'o2', stanzaId: 's2', body: 'second' })
      assertPersistedPreview()
      const selected = chatStore.getState().getMessage(CONV, second)!
      expect(selected).toMatchObject({ stanzaId: 's2' })
      chatStore.setState({ messages: new Map() })
      chatStore.getState().updateMessage(CONV, selected, { isRetracted: true, retractedAt: new Date(T + 2000) })
      await settle()
      expect(preview()).toMatchObject({ stanzaId: 's2', isRetracted: true, body: '' })
      expect(chatStore.getState().messages.has(CONV)).toBe(false)
      expect(await cache.getMessage(CONV, 'X', first)).toMatchObject({ body: 'first' })
      expect(await cache.getMessage(CONV, 'X', second)).toMatchObject({ isRetracted: true, body: '' })
      assertPersistedPreview()
    },
  )

  it.each(['live', 'mam-backward', 'mam-forward', 'cache-latest', 'cache-around'])('keeps the other twin preview intact during %s backfill', async path => {
    const [first, second] = twins()
    chatStore.getState().addMessage({ ...second, stanzaId: undefined })
    chatStore.getState().addMessage({ ...first, timestamp: new Date(T + 2000) })
    const held = preview()
    if (path === 'live') chatStore.getState().addMessage(second)
    else if (path.startsWith('cache')) {
      await settle()
      await cache.saveMessage(second)
      if (path === 'cache-latest') await chatStore.getState().loadMessagesFromCache(CONV)
      else await chatStore.getState().loadMessagesAroundFromCache(CONV, { id: 'X', stanzaId: 's2' })
    }
    else chatStore.getState().mergeMAMMessages(CONV, [second], { first: 's2', last: 's2' }, true, path === 'mam-backward' ? 'backward' : 'forward')
    await settle()
    expect(chatStore.getState().getMessage(CONV, second)).toMatchObject({ stanzaId: 's2' })
    expect(preview()).toBe(held)
    assertPersistedPreview()
  })

  describe.each([false, true])('stale preview belongs to another twin: %s', otherTwin => {
    it.each(['retraction', 'correction', 'actor-correction', 'body-update'])('reconciles a cached %s into only its matching preview', async action => {
      const rows = twins()
      await cache.saveMessages(rows)
      const held = { ...rows[otherTwin ? 0 : 1], stanzaId: undefined }
      chatStore.getState().addConversation({ id: CONV, name: 'Alice', type: 'chat', unreadCount: 0, lastMessage: held })
      const updates = action === 'retraction'
        ? { isRetracted: true, retractedAt: new Date(T + 2000) }
        : { body: 'updated second', ...(action !== 'body-update' && { isEdited: true }) }
      chatStore.getState().updateMessage(CONV, rows[1], updates, undefined, action === 'actor-correction' ? { actorJid: SCOPE } : undefined)
      await vi.waitFor(async () => expect(await cache.getMessage(CONV, 'X', rows[1])).toMatchObject(updates))
      await settle()
      if (otherTwin) expect(preview()).toBe(held)
      else expect(preview()).toMatchObject({ stanzaId: 's2', originId: 'o2', ...(action === 'retraction' ? { isRetracted: true, body: '' } : { body: 'updated second' }) })
      expect(chatStore.getState().messages.has(CONV)).toBe(false)
      expect(await cache.getMessage(CONV, 'X', rows[0])).toMatchObject({ body: 'first' })
      assertPersistedPreview()
    })
  })

  it.each(['retraction', 'actor-correction', 'body-update'])('discards a %s cache handoff after an account switch', async action => {
    const rows = twins()
    await cache.saveMessages(rows)
    chatStore.getState().addConversation({ id: CONV, name: 'Alice', type: 'chat', unreadCount: 0, lastMessage: { ...rows[1], stanzaId: undefined } })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let ready!: () => void
    const read = new Promise<void>(resolve => { ready = resolve })
    const getMessage = cache.getMessage
    const applyCorrection = cache.applyChatCorrection
    const spy = action !== 'actor-correction'
      ? vi.spyOn(cache, 'getMessage').mockImplementationOnce(async (...args) => { const result = await getMessage(...args); ready(); await gate; return result })
      : vi.spyOn(cache, 'applyChatCorrection').mockImplementationOnce(async (...args) => { const result = await applyCorrection(...args); ready(); await gate; return result })
    try {
      chatStore.getState().updateMessage(CONV, rows[1], action === 'retraction' ? { isRetracted: true } : { body: 'updated second', ...(action === 'actor-correction' && { isEdited: true }) }, undefined, action === 'actor-correction' ? { actorJid: SCOPE } : undefined)
      await read
      setStorageScopeJid('other@example.test')
      const otherAccountPreview = { ...rows[1], body: 'other account' }
      chatStore.getState().addConversation({ id: CONV, name: 'Alice', type: 'chat', unreadCount: 0, lastMessage: otherAccountPreview })
      release()
      await settle()
      expect(preview()).toBe(otherAccountPreview)
      expect(await searchIndex.search('updated')).toEqual([])
      assertPersistedPreview()
    } finally {
      release()
      spy.mockRestore()
    }
  })
})

describe('room witness: a reused nick and client id', () => {
  it('a ref with an occupant picks its row, a bare ref resolves to nothing', async () => {
    await cache.saveRoomMessages([room({ occupantId: 'o1', body: 'first', receivedAt: new Date(T) })])
    await cache.saveRoomMessages([room({ occupantId: 'o2', body: 'second', receivedAt: new Date(T + 1000), timestamp: new Date(T + 1000) })])
    expect((await cache.getRoomMessages(ROOM, {})).map(m => m.body)).toEqual(['first', 'second'])
    expect((await cache.getRoomMessagesAround(ROOM, { id: 'X', occupantId: 'o2' }, { before: 0, after: 0 })).map(m => m.body)).toEqual(['second'])
    expect(await cache.getRoomMessagesAround(ROOM, { id: 'X' }, { before: 0, after: 0 })).toEqual([])
  })

  it('a ref naming the second archive id lands on the second row', async () => {
    await cache.saveRoomMessages([room({ occupantId: 'o1', stanzaId: 'sa', body: 'first' })])
    await cache.saveRoomMessages([room({ occupantId: 'o2', stanzaId: 'sb', body: 'second', timestamp: new Date(T + 1000) })])
    expect((await cache.getRoomMessagesAround(ROOM, { id: 'X', stanzaId: 'sb' }, { before: 0, after: 0 })).map(m => m.body)).toEqual(['second'])
    expect((await cache.getRoomMessagesAround(ROOM, { id: 'sb' }, { before: 0, after: 0 })).map(m => m.body)).toEqual(['second'])
  })
})


describe('archive conflict separation at every durable write boundary', () => {
  it.each(['single', 'batch'] as const)('keeps reused origin IDs separate on %s saves', async mode => {
    await cache.clearAllMessages()
    const twins = [chat({ stanzaId: 's1', originId: 'X', body: 'first' }), chat({ stanzaId: 's2', originId: 'X', body: 'second' })]
    if (mode === 'single') {
      for (const twin of twins) await cache.saveMessage(twin)
    } else await cache.saveMessages(twins)
    expect((await stored()).map(row => [row.stanzaId, row.body])).toEqual([['s1', 'first'], ['s2', 'second']])
    expect((await cache.findChatMessageCopies(CONV, twins[1])).map(copy => copy.message.stanzaId)).toEqual(['s2'])
  })

  it('keeps twins separate while adding a shared origin ID through updateMessage', async () => {
    await cache.updateMessage(CONV, 'X', { originId: 'X' }, CONV, undefined, { stanzaId: 's1' })
    await cache.updateMessage(CONV, 'X', { originId: 'X' }, CONV, undefined, { stanzaId: 's2' })
    expect((await stored()).map(row => [row.stanzaId, row.originId])).toEqual([['s1', 'X'], ['s2', 'X']])
  })

  it('does not use an unqualified copy to merge two archive-distinct rows', async () => {
    await cache.saveMessage(chat({ id: 'X', body: 'unqualified copy' }))
    expect((await stored()).map(row => row.stanzaId)).toEqual(['s1', 's2'])
  })

  it.each(['single', 'batch'] as const)('merges copies sharing a stanza-id despite disagreeing origin IDs on %s saves', async mode => {
    await cache.clearAllMessages()
    const copies = [chat({ id: 'A', stanzaId: 's9', originId: 'oA' }), chat({ id: 'B', stanzaId: 's9', originId: 'oB' })]
    if (mode === 'single') {
      for (const copy of copies) await cache.saveMessage(copy)
    } else await cache.saveMessages(copies)
    expect((await stored()).map(row => row.stanzaId)).toEqual(['s9'])
    expect((await cache.getMessage(CONV, 'A'))?.stanzaId).toBe('s9')
    expect((await cache.getMessage(CONV, 'B'))?.stanzaId).toBe('s9')
  })
})

describe('chat cache windows with tied timestamps', () => {
  it('keeps either twin as a zero-context anchor', async () => {
    await cache.updateMessage(CONV, 'X', { timestamp: new Date(T) }, CONV, undefined, { stanzaId: 's2' })
    for (const stanzaId of ['s1', 's2']) {
      expect((await cache.getMessagesAround(CONV, { id: 'X', stanzaId }, { before: 0, after: 0 })).map(row => row.stanzaId)).toEqual([stanzaId])
    }
    expect((await cache.getMessagesAround(CONV, { id: 'X', stanzaId: 's1' }, { before: 0 })).map(row => row.stanzaId)).toEqual(['s1', 's2'])
    expect((await cache.getMessagesAround(CONV, { id: 'X', stanzaId: 's2' }, { before: 1, after: 0 })).map(row => row.stanzaId)).toEqual(['s1', 's2'])
  })

  it('applies the default context limit after locating the anchor within a large timestamp bucket', async () => {
    await cache.clearAllMessages()
    const twins = Array.from({ length: 80 }, (_, index) => chat({ stanzaId: `s${String(index).padStart(2, '0')}` }))
    await cache.saveMessages(twins)
    expect((await cache.getMessagesAround(CONV, { id: 'X', stanzaId: 's00' })).map(row => row.stanzaId)).toEqual(twins.map(row => row.stanzaId))
    expect((await cache.getMessagesAround(CONV, { id: 'X', stanzaId: 's60' }, { after: 1 })).map(row => row.stanzaId)).toEqual(twins.slice(10, 62).map(row => row.stanzaId))
  })
})

function localChatHarness(evictOnSend = false) {
  const handlers = new Map<keyof SDKEvents, (payload: never) => void>()
  const source: SDKEventSource = {
    subscribe(event, handler) {
      handlers.set(event, handler as (payload: never) => void)
      return () => { handlers.delete(event) }
    },
  }
  createStoreBindings(source, () => ({ chat: chatStore.getState() }) as StoreRefs)
  const sent: Element[] = []
  const deps: ModuleDependencies = {
    stores: { chat: chatStore.getState(), room: { getRoom: () => undefined } } as unknown as StoreBindings,
    presence: createPresenceReader(),
    sendStanza: async stanza => {
      sent.push(stanza)
      if (evictOnSend) chatStore.setState({ messages: new Map() })
    },
    sendIQ: async () => xml('iq'),
    getCurrentJid: () => SCOPE,
    getXmpp: () => null,
    emit: () => {},
    emitSDK: (event, payload) => { handlers.get(event)?.(payload as never) },
  }
  const module = new Chat(deps, new MAM(deps))
  return { module, sent }
}

describe('selected local actions through protocol, bindings, store and cache', () => {
  it.each(['stanza', 'origin'] as const)('retains the selected %s identity without changing wire references', async identity => {
    await cache.clearAllMessages()
    const twins = identity === 'stanza'
      ? [chat({ stanzaId: 's1', originId: 'X', body: 'first' }), chat({ stanzaId: 's2', originId: 'X', body: 'second' })]
      : [chat({ originId: 'o1', body: 'first' }), chat({ originId: 'o2', body: 'second' })]
    await cache.saveMessages(twins)
    chatStore.setState({ messages: new Map(), activeConversationId: CONV, pendingRetractions: new Map() })
    await chatStore.getState().loadMessagesFromCache(CONV)
    const { module, sent } = localChatHarness()
    await module.sendReaction(CONV, twins[1], ['🍌'])
    await module.sendLinkPreview(CONV, twins[1], { url: 'https://example.test/second' })
    await module.sendCorrection(CONV, twins[1], 'edited second')
    await settle()
    const project = (rows: Message[]) => rows.map(row => [row.body, Object.keys(row.reactions ?? {}), row.linkPreview?.url])
    const expected = [['first', [], undefined], ['edited second', ['🍌'], 'https://example.test/second']]
    expect(project(chatStore.getState().messages.get(CONV) ?? [])).toEqual(expected)
    expect(project(await stored())).toEqual(expected)
    expect(sent[0].getChild('reactions')?.attrs.id).toBe('X')
    expect(sent[1].getChild('apply-to')?.attrs.id).toBe('X')
    expect(sent[2].getChild('replace')?.attrs.id).toBe(twins[1].originId)
    await module.sendRetraction(CONV, twins[1])
    await settle()
    expect(sent[3].getChild('retract')?.attrs.id).toBe('X')
    expect((chatStore.getState().messages.get(CONV) ?? []).map(row => !!row.isRetracted)).toEqual([false, true])
    expect((await stored()).map(row => !!row.isRetracted)).toEqual([false, true])
  })

  it.each(['reaction', 'preview', 'correction', 'retraction'] as const)('retains a %s target evicted during sending', async action => {
    chatStore.setState({ messages: new Map(), activeConversationId: CONV, pendingRetractions: new Map() })
    await chatStore.getState().loadMessagesFromCache(CONV)
    const { module } = localChatHarness(true)
    if (action === 'reaction') await module.sendReaction(CONV, second(), ['🍌'])
    if (action === 'preview') await module.sendLinkPreview(CONV, second(), { url: 'https://example.test/second' })
    if (action === 'correction') await module.sendCorrection(CONV, second(), 'edited second')
    if (action === 'retraction') await module.sendRetraction(CONV, second())
    await settle()
    const rows = await stored()
    expect(rows[0]).toMatchObject({ body: 'first apple' })
    expect(rows[0].reactions).toBeUndefined()
    expect(rows[0].linkPreview).toBeUndefined()
    expect(rows[0].isRetracted).toBeFalsy()
    if (action === 'reaction') expect(rows[1].reactions).toEqual({ '🍌': [SCOPE] })
    if (action === 'preview') expect(rows[1].linkPreview?.url).toBe('https://example.test/second')
    if (action === 'correction') expect(rows[1].body).toBe('edited second')
    if (action === 'retraction') expect(rows[1].isRetracted).toBe(true)
  })

  it.each(['correction', 'retraction'] as const)('applies a selected %s evicted before sending without changing its wire ID', async action => {
    await cache.clearAllMessages()
    const twins = [
      chat({ from: SCOPE, isOutgoing: true, stanzaId: 's1', originId: 'o1', body: 'first' }),
      chat({ from: SCOPE, isOutgoing: true, stanzaId: 's2', originId: 'o2', body: 'second' }),
    ]
    await cache.saveMessages(twins)
    chatStore.setState({ messages: new Map(), activeConversationId: CONV, pendingRetractions: new Map() })
    await chatStore.getState().loadMessagesFromCache(CONV)
    const selected = chatStore.getState().getMessage(CONV, twins[1])!
    chatStore.setState({ messages: new Map() })
    const { module, sent } = localChatHarness()
    if (action === 'correction') await module.sendCorrection(CONV, selected, 'edited second')
    else await module.sendRetraction(CONV, selected)
    await settle()
    const rows = await stored()
    expect(rows[0].body).toBe('first')
    expect(rows[0].isRetracted).toBeFalsy()
    if (action === 'correction') {
      expect(rows[1]).toMatchObject({ body: 'edited second', originalBody: 'second' })
      expect(sent[0].getChild('replace')?.attrs.id).toBe('X')
    } else {
      expect(rows[1].isRetracted).toBe(true)
      expect(sent[0].getChild('retract')?.attrs.id).toBe('X')
    }
    expect(chatStore.getState().messages.has(CONV)).toBe(false)
  })

  it('preserves the row resolved by an unambiguous pending retraction', async () => {
    chatStore.setState({ messages: new Map(), activeConversationId: CONV, pendingRetractions: new Map() })
    await chatStore.getState().loadMessagesFromCache(CONV)
    chatStore.getState().recordPendingRetraction(CONV, 's2', CONV)
    await settle()
    expect((chatStore.getState().messages.get(CONV) ?? []).map(row => !!row.isRetracted)).toEqual([false, true])
    expect((await stored()).map(row => !!row.isRetracted)).toEqual([false, true])
  })
})
