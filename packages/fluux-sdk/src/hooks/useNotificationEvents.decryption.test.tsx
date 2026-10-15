/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import * as messageCache from '../utils/messageCache'
import { makeReadPointer } from '../stores/shared/readPointer'
import { ignoreStore } from '../stores/ignoreStore'
import { xml } from '@xmpp/client'
import { useNotificationEvents } from './useNotificationEvents'
import { chatStore } from '../stores/chatStore'
import { roomStore } from '../stores/roomStore'
import { connectionStore } from '../stores/connectionStore'
import { createRoom, createMessage } from '../stores/roomStore.testHelpers'
import { E2EEManager, InMemoryStorageBackend } from '../core/e2ee'
import { DummyPlaintextPlugin } from '../core/e2ee/DummyPlaintextPlugin'
import { E2EEPluginError } from '../core/e2ee/errors'
import { decryptStanzaInPlace, readStashedEncryptedPayload, readStashedSecurityContext, COULD_NOT_DECRYPT_BODY } from '../core/e2ee/stanzaDecrypt'
import { DeferredDecryptEngine } from '../core/e2ee/deferredDecrypt'
import { createMockStores } from '../core/test-utils'
import type { Message, StoreBindings } from '../core/types'
import { _clearAllTransientForTesting } from '../stores/shared/transientUnread'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
vi.mock('../utils/messageCache', async (original) => ({ ...await original<typeof import('../utils/messageCache')>(), isMessageCacheAvailable: vi.fn(() => false) }))
const PEER = 'alice@example.test', SELF = 'me@example.test', ROOM = 'room@conference.example.test'
let manager: E2EEManager
let sequence = 0
let messageId = ''
function incoming(body: string, encryptedPayload?: string): Message {
  return { type: 'chat', id: messageId, stanzaId: undefined, originId: undefined, conversationId: PEER, from: PEER, body, timestamp: new Date(), isOutgoing: false, encryptedPayload }
}
async function failed(withHint: boolean) {
  vi.spyOn(manager, 'decryptInbound').mockRejectedValueOnce(new E2EEPluginError('transient', 'key-locked', 'synthetic locked key'))
  const stanza = xml('message', { from: PEER, to: SELF, id: messageId }, ...(withHint ? [xml('body', {}, 'This message is encrypted')] : []), xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, 'aGVsbG8='))
  await decryptStanzaInPlace(stanza, manager, PEER)
  return { ...incoming(stanza.getChildText('body') ?? '', readStashedEncryptedPayload(stanza)), securityContext: readStashedSecurityContext(stanza) }
}
function engine() {
  const stores = createMockStores()
  stores.chat.getAllStoredMessages.mockImplementation(() => [{ id: PEER, messages: chatStore.getState().messages.get(PEER) ?? [] }])
  stores.room.getAllRoomMessages.mockReturnValue([])
  stores.chat.updateMessage.mockImplementation((...args) => chatStore.getState().updateMessage(...args))
  return new DeferredDecryptEngine({ getManager: () => manager, getStores: () => stores as unknown as StoreBindings, getOwnBareJid: () => SELF,
    cache: { getMessagesWithEncryptedPayload: async () => [], updateMessage: async () => {}, deleteMessage: async () => {} }, updateSearchIndex: async () => {} })
}
beforeEach(async () => {
  messageId = `message-${++sequence}`
  globalThis.indexedDB = new IDBFactory()
  messageCache._resetDBForTesting()
  vi.mocked(messageCache.isMessageCacheAvailable).mockReturnValue(false)
  ignoreStore.setState({ ignoredUsers: {} })
  _clearAllTransientForTesting(); _resetStorageScopeForTesting(); setStorageScopeJid(SELF)
  chatStore.setState({ conversations: new Map(), conversationEntities: new Map(), conversationMeta: new Map(), messages: new Map(), lastArrivedMessage: new Map(), activeConversationId: null })
  roomStore.setState({ rooms: new Map(), roomEntities: new Map(), roomMeta: new Map(), roomRuntime: new Map(), messages: new Map(), lastArrivedMessage: new Map(), activeRoomJid: null })
  connectionStore.setState({ windowVisible: false, jid: SELF })
  chatStore.getState().addConversation({ id: PEER, name: 'Synthetic Alice', type: 'chat', unreadCount: 0 })
  manager = new E2EEManager({ storage: new InMemoryStorageBackend(), account: { jid: SELF }, xmpp: {
    sendStanza: async () => {}, queryDisco: async () => ({ features: [], identities: [] }), publishPEP: async () => {}, retractPEP: async () => {}, deletePEP: async () => {}, queryPEP: async () => [], subscribePEP: () => ({ unsubscribe: () => {} }) } })
  await manager.register(new DummyPlaintextPlugin())
  vi.spyOn(manager, 'decryptArchive').mockResolvedValue({ plaintext: new TextEncoder().encode('hello'), senderDevice: { jid: PEER, deviceId: 'scout' }, securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
describe('notifications after deferred decryption', () => {
  it('successful first decrypt delivers readable text while hidden', async () => {
    const notify = vi.fn(); renderHook(() => useNotificationEvents({ onConversationMessage: notify }))
    vi.spyOn(manager, 'decryptInbound').mockResolvedValueOnce({ plaintext: new TextEncoder().encode('hello'), senderDevice: { jid: PEER, deviceId: 'scout' }, securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' } })
    const stanza = xml('message', { from: PEER, id: messageId }, xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, 'aGVsbG8='))
    await decryptStanzaInPlace(stanza, manager, PEER)
    act(() => chatStore.getState().addMessage(incoming(stanza.getChildText('body')!, readStashedEncryptedPayload(stanza)), { isLiveArrival: true }))
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][1]).toMatchObject({ body: 'hello', encryptedPayload: undefined })
  })
  it('waits for signature verification before notifying once', async () => {
    const notify = vi.fn(); renderHook(() => useNotificationEvents({ onConversationMessage: notify }))
    const stanza = xml('message', { from: PEER, id: messageId }, xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, 'aGVsbG8='))
    await decryptStanzaInPlace(stanza, manager, PEER)
    const message = { ...incoming(stanza.getChildText('body')!, readStashedEncryptedPayload(stanza)), securityContext: readStashedSecurityContext(stanza) }
    expect(message.body).toBe('hello'); expect(message.encryptedPayload).toBeTruthy(); expect(message.securityContext?.trust).toBe('untrusted')
    act(() => chatStore.getState().addMessage(message, { isLiveArrival: true }))
    expect(notify).not.toHaveBeenCalled()
    await act(async () => { expect(await engine().retryPending()).toBe(1) })
    expect(chatStore.getState().messages.get(PEER)?.[0]).toMatchObject({ body: 'hello', encryptedPayload: undefined })
    expect(notify).toHaveBeenCalledTimes(1)
  })
  it('holds a key-locked arrival and notifies once with its recovered content', async () => {
    const notify = vi.fn(); renderHook(() => useNotificationEvents({ onConversationMessage: notify }))
    const pending = await failed(true)
    act(() => chatStore.getState().addMessage(pending, { isLiveArrival: true }))
    expect(notify).not.toHaveBeenCalled()
    const arrived = chatStore.getState().lastArrivedMessage.get(PEER)
    let recovered = 0
    await act(async () => { recovered = await engine().retryPending() })
    expect(recovered).toBe(1)
    expect(chatStore.getState().messages.get(PEER)?.[0]).toMatchObject({ body: 'hello', encryptedPayload: undefined })
    expect(chatStore.getState().lastArrivedMessage.get(PEER)).toBe(arrived)
    expect(notify).toHaveBeenCalledTimes(1); expect(notify.mock.calls[0][1].body).toBe('hello')
    act(() => chatStore.getState().updateMessage(PEER, pending, { body: 'hello again' }))
    expect(notify).toHaveBeenCalledTimes(1)
  })
  it('does not notify for a synthetic decryption-failure body', async () => {
    const notify = vi.fn(); renderHook(() => useNotificationEvents({ onConversationMessage: notify }))
    const pending = await failed(false); expect(pending.body).toBe(COULD_NOT_DECRYPT_BODY)
    act(() => chatStore.getState().addMessage(pending, { isLiveArrival: true }))
    expect(notify).not.toHaveBeenCalled()
  })
  it('notifies when an empty pending arrival acquires readable content', async () => {
    const notify = vi.fn(); renderHook(() => useNotificationEvents({ onConversationMessage: notify }))
    const pending = incoming('', '<message from="alice@example.test" id="scout-1"><plain xmlns="urn:fluux:e2ee-dummy:0">aGVsbG8=</plain></message>')
    act(() => chatStore.getState().addMessage(pending, { isLiveArrival: true }))
    expect(notify).not.toHaveBeenCalled()
    let recovered = 0
    await act(async () => { recovered = await engine().retryPending() })
    expect(recovered).toBe(1); expect(chatStore.getState().messages.get(PEER)?.[0].body).toBe('hello')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][1].body).toBe('hello')
  })
  it('active visible conversation masks the failed-decrypt notification', () => {
    connectionStore.setState({ windowVisible: true }); chatStore.setState({ activeConversationId: PEER })
    const notify = vi.fn(); renderHook(() => useNotificationEvents({ onConversationMessage: notify }))
    act(() => chatStore.getState().addMessage(incoming('hint', '<plain/>'), { isLiveArrival: true }))
    expect(notify).not.toHaveBeenCalled()
  })
  it('holds notify-all room arrivals until their content is recovered', async () => {
    roomStore.getState().addRoom(createRoom(ROOM, { joined: true, notifyAll: true }))
    const notify = vi.fn(); renderHook(() => useNotificationEvents({ onRoomMessage: notify }))
    const pending = { ...createMessage('room-scout', ROOM, 'alice', 'encrypted hint'), encryptedPayload: '<plain/>' }
    await act(async () => { await roomStore.getState().addMessage(ROOM, pending, { isLiveArrival: true }) })
    expect(notify).not.toHaveBeenCalled()
    await act(async () => { await roomStore.getState().updateMessage(ROOM, pending.id, { body: 'hello', encryptedPayload: undefined }) })
    expect(roomStore.getState().messages.get(ROOM)?.[0].body).toBe('hello')
    expect(notify).toHaveBeenCalledTimes(1); expect(notify.mock.calls[0][1].body).toBe('hello')
  })
  it.each(['visible', 'read', 'retracted', 'account'] as const)('drops a held chat after it becomes %s', async (change) => {
    const notify = vi.fn()
    renderHook(() => useNotificationEvents({ onConversationMessage: notify }))
    const pending = await failed(true)
    act(() => chatStore.getState().addMessage(pending, { isLiveArrival: true }))
    act(() => {
      if (change === 'visible') {
        connectionStore.setState({ windowVisible: true })
        chatStore.setState({ activeConversationId: PEER })
      } else if (change === 'read') {
        chatStore.getState().addConversation({ id: PEER, type: 'chat', name: 'Alice', unreadCount: 1, readPointer: makeReadPointer({ ...pending, timestamp: new Date(pending.timestamp.getTime() + 1000) }, 'chat') })
      } else if (change === 'retracted') chatStore.getState().updateMessage(PEER, pending, { isRetracted: true })
      else connectionStore.setState({ jid: 'next@example.test' })
    })
    if (change === 'read') expect(chatStore.getState().conversations.get(PEER)?.readPointer?.order.timestamp).toBeGreaterThan(pending.timestamp.getTime())
    await act(async () => { await engine().retryPending() })
    expect(notify).not.toHaveBeenCalled()
  })

  it('preserves unread arrivals sharing a millisecond with a migrated read floor', async () => {
    const notify = vi.fn()
    renderHook(() => useNotificationEvents({ onConversationMessage: notify }))
    const pending = await failed(true)
    act(() => {
      chatStore.getState().addMessage(pending, { isLiveArrival: true })
      chatStore.getState().addConversation({ id: PEER, type: 'chat', name: 'Alice', unreadCount: 1,
        readPointer: { order: { role: 'floor', timestamp: pending.timestamp.getTime() }, identity: { state: 'local', messageId: 'previous-message' } } })
    })
    await act(async () => { await engine().retryPending() })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][1].body).toBe('hello')
  })

  it('recovers an older held arrival only in the cache, without replaying unrelated cache writes', async () => {
    vi.mocked(messageCache.isMessageCacheAvailable).mockReturnValue(true)
    const notify = vi.fn()
    renderHook(() => useNotificationEvents({ onConversationMessage: notify }))
    const first = incoming('hint', '<plain/>')
    const later = { ...incoming('later hint', '<plain/>'), id: 'later', timestamp: new Date(first.timestamp.getTime() + 1000) }
    await act(async () => {
      chatStore.getState().addMessage(first, { isLiveArrival: true })
      chatStore.getState().addMessage(later, { isLiveArrival: true })
      await messageCache.saveMessage(first)
      await messageCache.saveMessage(later)
      chatStore.setState({ messages: new Map() })
    })
    await act(async () => {
      await messageCache.updateMessage(PEER, first.id, { body: 'older recovered', encryptedPayload: undefined }, first.from)
      expect(await messageCache.getMessage(PEER, first.id, first)).toMatchObject({ body: 'older recovered', encryptedPayload: undefined })
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    })
    expect(notify.mock.calls[0][1].body).toBe('older recovered')
    await act(async () => {
      await messageCache.updateMessage(PEER, first.id, { body: 'another repair' }, first.from)
      await messageCache.saveMessage({ ...first, id: 'history-only', encryptedPayload: undefined })
    })
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('rechecks decrypted mentions (mentioned: %s)', async (mentioned) => {
    roomStore.getState().addRoom(createRoom(ROOM, { joined: true, nickname: 'testuser' }))
    const notify = vi.fn()
    renderHook(() => useNotificationEvents({ onRoomMessage: notify }))
    const pending = { ...createMessage('mention', ROOM, 'alice', 'encrypted hint'), encryptedPayload: '<plain/>' }
    await act(async () => { await roomStore.getState().addMessage(ROOM, pending, { isLiveArrival: true }) })
    await act(async () => { await roomStore.getState().updateMessage(ROOM, pending.id, { body: mentioned ? 'hello @testuser' : 'hello', encryptedPayload: undefined }) })
    expect(notify).toHaveBeenCalledTimes(mentioned ? 1 : 0)
  })

  it('preserves a structured mention-all and an imprecise room read floor after recovery', async () => {
    const pending = { ...createMessage('mention-all-floor', ROOM, 'alice', 'encrypted hint'), isMentionAll: true, encryptedPayload: '<plain/>' }
    roomStore.getState().addRoom(createRoom(ROOM, { joined: true, nickname: 'testuser',
      readPointer: { order: { role: 'floor', timestamp: pending.timestamp.getTime() }, identity: { state: 'local', messageId: 'previous-message' } } }))
    const notify = vi.fn()
    renderHook(() => useNotificationEvents({ onRoomMessage: notify }))
    await act(async () => { await roomStore.getState().addMessage(ROOM, pending, { isLiveArrival: true }) })
    expect(notify).not.toHaveBeenCalled()
    await act(async () => { await roomStore.getState().updateMessage(ROOM, pending.id, { body: 'hello everyone', encryptedPayload: undefined }) })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][2]).toBe(true)
  })

  it('keeps held room rows with reused client ids separate', async () => {
    roomStore.getState().addRoom(createRoom(ROOM, { joined: true, notifyAll: true }))
    const notify = vi.fn()
    renderHook(() => useNotificationEvents({ onRoomMessage: notify }))
    const first = { ...createMessage('shared', ROOM, 'alice', 'hint'), occupantId: 'occupant-a', encryptedPayload: '<plain/>' }
    const second = { ...createMessage('shared', ROOM, 'bob', 'hint'), occupantId: 'occupant-b', encryptedPayload: '<plain/>' }
    await act(async () => {
      await roomStore.getState().addMessage(ROOM, first, { isLiveArrival: true })
      await roomStore.getState().addMessage(ROOM, second, { isLiveArrival: true })
    })
    const resolvedFirst = { ...first, body: 'first clear', encryptedPayload: undefined }
    act(() => roomStore.setState({ messages: new Map([[ROOM, [resolvedFirst, second]]]) }))
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][1].occupantId).toBe('occupant-a')
    act(() => roomStore.setState({ messages: new Map([[ROOM, [resolvedFirst, { ...second, body: 'second clear', encryptedPayload: undefined }]]]) }))
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1][1].occupantId).toBe('occupant-b')
  })

})
