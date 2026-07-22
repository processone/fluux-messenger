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
  //
  // CONV is the subject but cannot be the barrier: when the guard works nothing
  // about it ever changes, so there is no transition to wait on. A bare timer is
  // not a barrier either — the offending write needs a `getMessage` round trip,
  // which fake-indexeddb resolves from the event loop's CHECK phase, after a
  // `setTimeout(0)` has already fired in the TIMERS phase of the same iteration.
  // The assertion would read the untouched pointer and pass either way.
  //
  // OTHER is the barrier: it genuinely migrates, `pending` keeps Map insertion
  // order, and the pass awaits one conversation before starting the next. So by
  // the time OTHER's pointer lands, CONV's write — correct (none) or wrong — has
  // already flushed.
  it('leaves an existing pointer alone even when the legacy fields point further ahead', async () => {
    await messageCache.saveMessages([
      { type: 'chat', id: 'o1', conversationId: OTHER, from: OTHER, body: 'x', timestamp: at(1500), isOutgoing: false },
    ] as never)
    persistConversations([
      [CONV, { lastSeenMessageId: 'm3', readPointer: { messageId: 'm1', timestamp: 1000 } }],
      [OTHER, { lastSeenMessageId: 'o1' }],
    ])

    await chatStore.persist.rehydrate()
    await vi.waitFor(() => expect(pointerOf(OTHER)).toEqual({ messageId: 'o1', timestamp: at(1500) }))

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

// ---------------------------------------------------------------------------
// The migration has to be RETRYABLE, not one-shot.
//
// `serializeState` emits the live shape, and `switchAccount` persists in the
// same synchronous call that schedules the backfill — so without a re-emit the
// legacy pair is erased from disk BEFORE the first migration attempt ever runs,
// on every cold start. `migrateReadPointer` legitimately resolves nothing in
// several cases (an id the cache never stored, a timestamp older than every
// cached message, a single failed IndexedDB open, which returns null for every
// conversation in flight), and a conversation left with neither a pointer nor
// the values to rebuild one hits the fresh-entity branch of
// `recomputeCountsFromPointer`: pointer snapped to newest, counts zeroed, unread
// history silently marked read. The pointer is forward-only, so that is
// permanent.
// ---------------------------------------------------------------------------
const LATE = 'late@example.com'

/** One conversation's entry in one persisted map, as it actually sits on disk. */
function diskEntry(map: 'conversationMeta' | 'conversations', id: string): Record<string, unknown> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) throw new Error(`diskEntry: nothing persisted under ${STORAGE_KEY}`)
  const entries = JSON.parse(raw).state[map] as Array<[string, Record<string, unknown>]>
  const found = entries.find(([key]) => key === id)
  if (!found) throw new Error(`diskEntry: no ${map} entry for ${id}`)
  return found[1]
}

/**
 * The legacy pair on disk. Both persisted maps are read: `serializeState` writes
 * them separately, and either one going missing is the same loss.
 */
function legacyOnDisk(id: string): { lastSeenMessageId?: unknown; lastReadAt?: unknown } {
  const meta = diskEntry('conversationMeta', id)
  const conv = diskEntry('conversations', id)
  expect([conv.lastSeenMessageId, conv.lastReadAt]).toEqual([meta.lastSeenMessageId, meta.lastReadAt])
  return { lastSeenMessageId: meta.lastSeenMessageId, lastReadAt: meta.lastReadAt }
}

/**
 * A cold start. `XMPPClient.connect` sets the storage scope and calls
 * `switchAccount`, which reloads the account's whole state from disk into a
 * fresh empty base — dropping everything in memory, as a real relaunch does —
 * and persists it, synchronously, in the same call.
 */
function relaunch(): void {
  chatStore.getState().switchAccount(JID)
}

/** Let the backfill's macrotask yield and its cache probes resolve. */
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('unmigrated legacy read state survives the persist', () => {
  afterEach(() => {
    getMessageGate = null
    localStorage.clear()
  })

  // The `lastReadAt`-only shape: the most common pre-#1081 state, since the old
  // onActivate stamped it while leaving lastSeenMessageId undefined.
  it('keeps an unresolved lastReadAt on disk and migrates it on a later launch', async () => {
    // Nothing is cached for LATE, so this launch's probe resolves nothing.
    persistConversations([[LATE, { lastReadAt: at(1800).toISOString() }]])

    relaunch()
    await settle()

    expect(pointerOf(LATE)).toBeUndefined()
    expect(legacyOnDisk(LATE).lastReadAt).toBe(at(1800).toISOString())

    // Next launch, with a cache that can answer.
    await messageCache.saveMessages([
      { type: 'chat', id: 'late1', conversationId: LATE, from: LATE, body: 'y', timestamp: at(1500), isOutgoing: false },
    ] as never)

    relaunch()
    await vi.waitFor(() => expect(pointerOf(LATE)).toEqual({ messageId: 'late1', timestamp: at(1500) }))
  })

  // The other half of the same guarantee, for the id-only shape.
  it('keeps an unresolved lastSeenMessageId on disk', async () => {
    persistConversations([[CONV, { lastSeenMessageId: 'not-in-cache' }]])

    relaunch()
    await settle()

    expect(pointerOf(CONV)).toBeUndefined()
    expect(legacyOnDisk(CONV).lastSeenMessageId).toBe('not-in-cache')
  })

  // The counterpart: once a pointer exists the legacy pair is a stale second
  // opinion, and leaving it on disk would rebuild the two-fields shape #1081
  // removed. `in` rather than `toBeUndefined`, so an entry read from the wrong
  // conversation cannot pass by being absent.
  it('drops the legacy pair from disk once a pointer lands', async () => {
    persistConversations([[CONV, { lastSeenMessageId: 'm2' }]])

    relaunch()
    await vi.waitFor(() => expect(pointerOf(CONV)).toEqual({ messageId: 'm2', timestamp: at(2000) }))

    expect(diskEntry('conversationMeta', CONV).readPointer).toEqual({
      messageId: 'm2',
      timestamp: at(2000).toISOString(),
    })
    expect('lastSeenMessageId' in diskEntry('conversationMeta', CONV)).toBe(false)
    expect('lastSeenMessageId' in diskEntry('conversations', CONV)).toBe(false)
  })

  // A conversation the user reads normally gets its pointer from the store, not
  // from the migration — the legacy pair has to retire on that path too.
  it('drops the legacy pair once the user reads the conversation', async () => {
    persistConversations([[LATE, { lastReadAt: at(1800).toISOString() }]])

    relaunch()
    await settle()
    expect(legacyOnDisk(LATE).lastReadAt).toBe(at(1800).toISOString())

    const live = { messageId: 'live1', timestamp: at(9000) }
    chatStore.setState((state) => {
      const meta = new Map(state.conversationMeta)
      meta.set(LATE, { ...meta.get(LATE)!, readPointer: live })
      const conversations = new Map(state.conversations)
      conversations.set(LATE, { ...conversations.get(LATE)!, readPointer: live })
      return { conversationMeta: meta, conversations }
    })

    expect(diskEntry('conversationMeta', LATE).readPointer).toEqual({
      messageId: 'live1',
      timestamp: at(9000).toISOString(),
    })
    expect('lastReadAt' in diskEntry('conversationMeta', LATE)).toBe(false)
  })
})
