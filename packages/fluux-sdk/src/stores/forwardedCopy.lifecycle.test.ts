import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { xml, type Element } from '@xmpp/client'
import { chatStore } from './chatStore'
import { Chat } from '../core/modules/Chat'
import { MAM } from '../core/modules/MAM'
import type { ModuleDependencies } from '../core/modules/BaseModule'
import { createMockPresenceReader, createMockStores } from '../core/test-utils'
import type { Message } from '../core/types'
import * as messageCache from '../utils/messageCache'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { _resetForTesting } from './shared/throttledStorage'
import { _clearAllTransientForTesting } from './shared/transientUnread'
import { formatMessagePreview } from '../utils/messagePreview'

// Review: a forwarded copy followed from the wire through the resident store, the archive and the durable
// cache, and through deletion while the message is mounted, with disposable fixtures only.
const NSF = 'urn:xmpp:forward:0'
const peer = 'bob@example.org'
const room = 'team@conference.example.org'
const copy = () => xml('forwarded', { xmlns: NSF }, xml('message', { from: `${room}/Bob` }, xml('body', {}, 'Ship it')))

function chatModule() {
  const stores = createMockStores()
  const emitSDK = vi.fn()
  const deps = { stores, presence: createMockPresenceReader(), getCurrentJid: () => 'alice@example.org/web', getXmpp: () => null,
    sendStanza: vi.fn(), sendIQ: vi.fn(), emit: vi.fn(), emitSDK } as unknown as ModuleDependencies
  const mam = new MAM(deps)
  return { chat: new Chat(deps, mam), mam: mam as unknown as { parseArchiveMessage(f: Element, c: string, id?: string): Message | null }, emitSDK }
}
const delivered = (emitSDK: ReturnType<typeof vi.fn>) =>
  emitSDK.mock.calls.filter(([name]) => name === 'chat:message').map(([, payload]) => (payload as { message: Message }).message)
const resident = () => chatStore.getState().messages.get(peer) ?? []

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  _resetStorageScopeForTesting()
  messageCache._resetDBForTesting()
  setStorageScopeJid('alice@example.org')
  _resetForTesting()
  _clearAllTransientForTesting()
  localStorage.clear()
  chatStore.setState({
    conversationEntities: new Map(), conversationMeta: new Map(), conversations: new Map(), messages: new Map(),
    activeConversationId: peer, windowAtLiveEdge: new Map(), pendingRetractions: new Map(),
    conversationCoverage: new Map(), conversationGaps: new Map(), mamQueryStates: new Map(),
  })
  chatStore.getState().addConversation({ id: peer, type: 'chat', name: 'Bob', unreadCount: 0 })
})
afterEach(() => { _resetForTesting(); messageCache._resetDBForTesting() })

describe('forwarded copy receive lifecycle', () => {
  it('delivers a copy-only message once through live and carbon, merges its archive replay and hydrates it from the cache', async () => {
    const { chat, mam, emitSDK } = chatModule()
    const inner = () => xml('message', { type: 'chat', id: 'fwd-1', from: `${peer}/web`, to: 'alice@example.org' }, copy())
    chat.handle(inner())
    chat.handle(xml('message', { from: 'alice@example.org', to: 'alice@example.org/web' },
      xml('received', { xmlns: 'urn:xmpp:carbons:2' }, xml('forwarded', { xmlns: NSF }, inner()))))
    const events = delivered(emitSDK)
    expect(events.length).toBeGreaterThanOrEqual(1)
    for (const message of events) chatStore.getState().addMessage(message)
    expect(resident().filter(m => m.id === 'fwd-1')).toHaveLength(1)
    expect(resident()[0]).toMatchObject({ body: '', forwarded: { author: 'Bob', text: 'Ship it' } })

    const replay = mam.parseArchiveMessage(xml('forwarded', { xmlns: NSF }, xml('delay', { xmlns: 'urn:xmpp:delay', stamp: '2026-11-17T09:30:00Z' }), inner()), peer, 'arch-1')
    expect(replay).toMatchObject({ body: '', forwarded: { text: 'Ship it' } })
    chatStore.getState().mergeMAMMessages(peer, [replay!], {}, true, 'forward', { extras: { walkOriginTs: 0 } })
    expect(resident().filter(m => m.forwarded?.text === 'Ship it')).toHaveLength(1)

    await messageCache.saveMessages(resident())
    chatStore.setState({ messages: new Map() })
    await chatStore.getState().loadMessagesFromCache(peer, { limit: 50 })
    expect(resident()).toHaveLength(1)
    expect(resident()[0]).toMatchObject({ id: 'fwd-1', forwarded: { author: 'Bob', text: 'Ship it' } })
    // A conversation preview of a copy-only message shows the copied text, never an empty row.
    expect(formatMessagePreview(resident()[0])).toBe('Ship it')
  })

  it.each(['live', 'replayed'])('removes the copy from the open conversation and after a reload on a %s retraction', async mode => {
    const base: Message = { type: 'chat', id: 'gone', stanzaId: undefined, originId: undefined, conversationId: peer, from: peer, body: 'Look', timestamp: new Date(1_700_000_000_000),
      isOutgoing: false, forwarded: { author: 'Bob', text: 'Ship it' } }
    if (mode === 'replayed') chatStore.getState().recordPendingRetraction(peer, 'gone', peer)
    chatStore.getState().addMessage(base)
    await messageCache.saveMessages([base])
    if (mode !== 'replayed') chatStore.getState().updateMessage(peer, 'gone', { isRetracted: true, retractedAt: new Date(1_700_000_005_000) })
    expect(resident().find(m => m.id === 'gone')).toMatchObject({ isRetracted: true, forwarded: undefined })
    await messageCache.saveMessages(resident())
    await vi.waitFor(async () => {
      const row = (await messageCache.getMessages(peer, {})).find(m => m.id === 'gone')
      expect(row?.isRetracted).toBe(true)
      expect(row?.forwarded).toBeUndefined()
    })
    chatStore.setState({ messages: new Map() })
    await chatStore.getState().loadMessagesFromCache(peer, { limit: 50 })
    expect(resident().find(m => m.id === 'gone')?.forwarded).toBeUndefined()
  })
})
