import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { Message } from '../core/types'
import * as messageCache from '../utils/messageCache'
import { _resetStorageScopeForTesting, setStorageScopeJid, buildScopedStorageKey } from '../utils/storageScope'
import { localStorageMock } from '../core/sideEffects.testHelpers'
import { chatStore, migrateReadPointer } from './chatStore'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// The migration itself runs against the real (fake-indexeddb) cache. Only the
// in-flight race test installs a gate, so it can hold `getMessage` open while a
// concurrent read advances the pointer.
let getMessageGate: ((id: string) => Promise<Message | null>) | null = null
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    getMessage: (id: string) => (getMessageGate ? getMessageGate(id) : actual.getMessage(id)),
  }
})

const JID = 'me@example.com'
const CONV = 'peer@example.com'
const at = (ms: number) => new Date(ms)

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  messageCache._resetDBForTesting()
  _resetStorageScopeForTesting()
  setStorageScopeJid(JID)
  await messageCache.saveMessages([
    { type: 'chat', id: 'm1', conversationId: CONV, from: CONV, body: 'a', timestamp: at(1000), isOutgoing: false },
    { type: 'chat', id: 'm2', conversationId: CONV, from: CONV, body: 'b', timestamp: at(2000), isOutgoing: false },
    { type: 'chat', id: 'm3', conversationId: CONV, from: CONV, body: 'c', timestamp: at(3000), isOutgoing: false },
  ] as never)
})

describe('read pointer migration', () => {
  it('pairs an id with its persisted timestamp when both exist', async () => {
    const p = await migrateReadPointer(CONV, { lastSeenMessageId: 'm2', lastReadAt: at(2000) })
    expect(p).toEqual({ messageId: 'm2', timestamp: at(2000) })
  })

  it('resolves the timestamp from the cache when only the id survived', async () => {
    const p = await migrateReadPointer(CONV, { lastSeenMessageId: 'm2' })
    expect(p).toEqual({ messageId: 'm2', timestamp: at(2000) })
  })

  // Control: resolving to the OLDEST message AFTER lastReadAt would return m3
  // here. That is ahead of where the user was, and the pointer is forward-only,
  // so it would destroy the position unrecoverably.
  it('resolves lastReadAt-only to the newest message AT OR BEFORE it', async () => {
    const p = await migrateReadPointer(CONV, { lastReadAt: at(2500) })
    expect(p).toEqual({ messageId: 'm2', timestamp: at(2000) })
  })

  it('resolves exactly when lastReadAt lands on a message timestamp', async () => {
    const p = await migrateReadPointer(CONV, { lastReadAt: at(2000) })
    expect(p).toEqual({ messageId: 'm2', timestamp: at(2000) })
  })

  it('yields no pointer when lastReadAt predates every cached message', async () => {
    expect(await migrateReadPointer(CONV, { lastReadAt: at(500) })).toBeUndefined()
  })

  it('yields no pointer when there is nothing to migrate', async () => {
    expect(await migrateReadPointer(CONV, {})).toBeUndefined()
  })

  it('yields no pointer when the id is not in the cache and no timestamp survived', async () => {
    expect(await migrateReadPointer(CONV, { lastSeenMessageId: 'gone' })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The post-rehydrate pass. `deserializeState` is synchronous, so the backfill
// is fire-and-forget: Task 6b deletes the legacy fields, and a conversation the
// pass skipped would come back with no read position at all.
// ---------------------------------------------------------------------------
const OTHER = 'other@example.com'
const STORAGE_KEY = buildScopedStorageKey('xmpp-chat-storage', JID)

interface LegacyMeta {
  lastSeenMessageId?: string
  lastReadAt?: string
  readPointer?: { messageId: string; timestamp: number }
  unreadCount?: number
}

function persistConversations(entries: Array<[string, LegacyMeta]>): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      state: {
        conversationEntities: entries.map(([id]) => [id, { id, name: id, type: 'chat' }]),
        conversationMeta: entries.map(([id, m]) => [id, { unreadCount: 0, ...m }]),
        conversations: entries.map(([id, m]) => [id, { id, name: id, type: 'chat', unreadCount: 0, ...m }]),
        archivedConversations: [],
      },
    })
  )
}

const pointerOf = (id: string) => chatStore.getState().conversationMeta.get(id)?.readPointer

describe('post-rehydrate readPointer backfill', () => {
  afterEach(() => {
    getMessageGate = null
    localStorage.clear()
  })

  it('backfills every restored conversation, whichever legacy field survived', async () => {
    await messageCache.saveMessages([
      { type: 'chat', id: 'o1', conversationId: OTHER, from: OTHER, body: 'x', timestamp: at(1500), isOutgoing: false },
    ] as never)
    persistConversations([
      [CONV, { lastSeenMessageId: 'm2' }],
      [OTHER, { lastReadAt: at(1800).toISOString() }],
    ])

    await chatStore.persist.rehydrate()

    await vi.waitFor(() => {
      expect(pointerOf(CONV)).toEqual({ messageId: 'm2', timestamp: at(2000) })
      expect(pointerOf(OTHER)).toEqual({ messageId: 'o1', timestamp: at(1500) })
    })
  })

  // The both-fields branch resolves without touching the cache, so its
  // continuation is queued as a microtask from inside `getItem` — ahead of the
  // one the persist middleware uses to apply the restored state. A pass that
  // wrote before that set would be silently overwritten by it.
  it('backfills a conversation whose legacy pair needs no cache lookup', async () => {
    persistConversations([[CONV, { lastSeenMessageId: 'm2', lastReadAt: at(2000).toISOString() }]])

    await chatStore.persist.rehydrate()

    await vi.waitFor(() => expect(pointerOf(CONV)).toEqual({ messageId: 'm2', timestamp: at(2000) }))
  })

  // Both maps must move together: a pointer visible in conversationMeta but not
  // in the combined map is the half-state every `meta?.x ?? conv.x` fallback in
  // this store would read inconsistently.
  it('writes the pointer into conversationMeta and conversations together', async () => {
    persistConversations([[CONV, { lastSeenMessageId: 'm2' }]])

    await chatStore.persist.rehydrate()

    await vi.waitFor(() => expect(pointerOf(CONV)).toBeDefined())
    expect(chatStore.getState().conversations.get(CONV)?.readPointer).toEqual(pointerOf(CONV))
  })

  // Control: a blind `readPointer: migrated` write lands m1 here and drags the
  // user back two messages. The gate holds the migration open across the live
  // read, so the race is deterministic rather than timing-dependent.
  it('never drags the pointer back behind a read that happened while it was in flight', async () => {
    let release!: (m: Message | null) => void
    getMessageGate = () => new Promise<Message | null>((resolve) => { release = resolve })
    persistConversations([[CONV, { lastSeenMessageId: 'm1' }]])

    await chatStore.persist.rehydrate()
    await vi.waitFor(() => expect(release).toBeDefined())

    // The user opens the conversation and reads to the live edge.
    const live = { messageId: 'm3', timestamp: at(3000) }
    chatStore.setState((state) => {
      const meta = new Map(state.conversationMeta)
      meta.set(CONV, { ...meta.get(CONV)!, readPointer: live })
      const conversations = new Map(state.conversations)
      conversations.set(CONV, { ...conversations.get(CONV)!, readPointer: live })
      return { conversationMeta: meta, conversations }
    })

    release({ type: 'chat', id: 'm1', conversationId: CONV, from: CONV, body: 'a', timestamp: at(1000), isOutgoing: false } as never)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(pointerOf(CONV)).toEqual(live)
    expect(chatStore.getState().conversations.get(CONV)?.readPointer).toEqual(live)
  })

  // Control: the legacy fields here point two messages FURTHER ahead than the
  // restored pointer. A pass that migrated conversations which already have a
  // pointer would move it to m3 — advancing the read position past messages the
  // user never saw, which forward-only makes permanent.
  it('leaves an existing pointer alone even when the legacy fields point further ahead', async () => {
    persistConversations([[CONV, { lastSeenMessageId: 'm3', readPointer: { messageId: 'm1', timestamp: 1000 } }]])

    await chatStore.persist.rehydrate()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(pointerOf(CONV)).toEqual({ messageId: 'm1', timestamp: at(1000) })
  })

  // Cold start paints the persisted count instead of flashing an empty badge.
  it('restores the persisted unread count instead of zeroing it', async () => {
    persistConversations([[CONV, { lastSeenMessageId: 'm2', unreadCount: 4 }]])

    await chatStore.persist.rehydrate()

    expect(chatStore.getState().conversationMeta.get(CONV)?.unreadCount).toBe(4)
    expect(chatStore.getState().conversations.get(CONV)?.unreadCount).toBe(4)
  })
})
