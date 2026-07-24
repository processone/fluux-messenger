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
        // New-format blob: entities + meta only. The compat map is rebuilt from
        // these on load and is no longer persisted, so writing one here would
        // describe a shape the app never produces.
        conversationEntities: entries.map(([id]) => [id, { id, name: id, type: 'chat' }]),
        conversationMeta: entries.map(([id, m]) => [id, { unreadCount: 0, ...m }]),
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
function diskEntry(map: 'conversationMeta' | 'conversationEntities', id: string): Record<string, unknown> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) throw new Error(`diskEntry: nothing persisted under ${STORAGE_KEY}`)
  const entries = JSON.parse(raw).state[map] as Array<[string, Record<string, unknown>]>
  const found = entries.find(([key]) => key === id)
  if (!found) throw new Error(`diskEntry: no ${map} entry for ${id}`)
  return found[1]
}

/**
 * The legacy pair on disk. `conversationMeta` is the only persisted carrier: the
 * `conversations` compat map is no longer written at all (it is rebuilt from
 * entities + meta on load), so there is one place left for this to go missing.
 */
function legacyOnDisk(id: string): { lastSeenMessageId?: unknown; lastReadAt?: unknown } {
  const meta = diskEntry('conversationMeta', id)
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
    // The compat map is not on disk to check any more — nothing writes it.
    expect('conversations' in JSON.parse(localStorage.getItem(STORAGE_KEY)!).state).toBe(false)
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

// ---------------------------------------------------------------------------
// Protecting the disk is not enough — the SESSION can fabricate a pointer too.
//
// A failed probe leaves the conversation pointerless in memory. Reconnect
// catch-up then reaches mergeMAMMessages' background hydration, which hands
// `readPointer: undefined` to recomputeCountsFromPointer — and the fresh-entity
// guard reads that as "brand new, caught up": pointer snapped to the newest
// message, counts zeroed. The caller writes it into both maps, the persist that
// follows sees a truthy readPointer and stops re-emitting the legacy pair, and
// forward-only means the correct older pointer could never win afterwards.
//
// This is the EXPECTED sequel to a failed probe, not a corner case: the probe
// fails because the cache cannot resolve the position yet, and MAM catch-up is
// precisely what fills the cache. So the guard stands down for a conversation
// the migration still owes a pointer to — the same treatment
// `hasPendingRemoteMarker` gets (#1076).
// ---------------------------------------------------------------------------
const FRESH = 'fresh@example.com'

/** An archive page as catch-up delivers it, oldest → newest. */
function archivePage(conversationId: string, prefix: string, stamps: number[]): Message[] {
  return stamps.map((ms, i) => ({
    type: 'chat',
    id: `${prefix}${i + 1}`,
    stanzaId: `s-${prefix}${i + 1}`,
    conversationId,
    from: conversationId,
    body: `${prefix}${i + 1}`,
    timestamp: at(ms),
    isOutgoing: false,
  })) as Message[]
}

describe('catch-up hydration does not fabricate a pointer over un-migrated read state', () => {
  afterEach(() => {
    getMessageGate = null
    localStorage.clear()
  })

  // The whole path, end to end: failed probe → catch-up merge → next launch.
  // The archive here straddles the legacy read position (1500 is before it, 2500
  // and 3500 after), so a fabricated pointer lands on l3 and marks two unread
  // messages read; the correct migration lands on l1.
  it('leaves the conversation pointerless, and the next launch migrates it correctly', async () => {
    persistConversations([[LATE, { lastReadAt: at(1800).toISOString() }]])

    // Launch 1: nothing is cached for LATE, so the probe resolves nothing.
    relaunch()
    await settle()
    expect(pointerOf(LATE)).toBeUndefined()

    // Reconnect catch-up delivers the archive. This is the call that used to
    // snap the pointer to l3 — and it is also what fills the cache the next
    // migration attempt needs.
    chatStore.getState().mergeMAMMessages(LATE, archivePage(LATE, 'l', [1500, 2500, 3500]), {}, true, 'forward')

    expect(pointerOf(LATE)).toBeUndefined()
    expect(chatStore.getState().conversations.get(LATE)?.readPointer).toBeUndefined()
    // …and the values the retry needs are still on disk, in both maps.
    expect(legacyOnDisk(LATE).lastReadAt).toBe(at(1800).toISOString())

    // Launch 2: the cache can answer now. The pointer lands where the user
    // actually was — BEHIND the two messages a snap would have marked read.
    relaunch()
    await vi.waitFor(() => expect(pointerOf(LATE)).toEqual({ messageId: 'l1', timestamp: at(1500) }))
  })

  // Control: the stand-down is per-conversation, not a blanket disable. FRESH is
  // restored from the same blob, in the same session, with no legacy read state
  // — it must still be caught up, or every never-read conversation would report
  // its whole archive as unread.
  it('still snaps a genuinely fresh conversation and reports zero unread', async () => {
    persistConversations([
      [LATE, { lastReadAt: at(1800).toISOString() }],
      [FRESH, {}],
    ])

    relaunch()
    await settle()
    expect(pointerOf(FRESH)).toBeUndefined()

    chatStore.getState().mergeMAMMessages(FRESH, archivePage(FRESH, 'f', [1500, 2500, 3500]), {}, true, 'forward')

    expect(pointerOf(FRESH)).toEqual({ messageId: 'f3', timestamp: at(3500) })
    expect(chatStore.getState().conversationMeta.get(FRESH)?.unreadCount).toBe(0)
    // The other conversation in the same blob is untouched, which is what makes
    // this a control rather than two independent runs.
    expect(pointerOf(LATE)).toBeUndefined()
  })

  // The recount that follows a background hydration reads the cache directly and
  // is a second way into the same guard.
  it('does not fabricate a pointer through recomputeUnreadForConversation either', async () => {
    persistConversations([[LATE, { lastReadAt: at(1800).toISOString() }]])
    relaunch()
    await settle()
    expect(pointerOf(LATE)).toBeUndefined()

    await messageCache.saveMessages(archivePage(LATE, 'l', [1500, 2500, 3500]) as never)
    await chatStore.getState().recomputeUnreadForConversation(LATE)

    expect(pointerOf(LATE)).toBeUndefined()
    expect(legacyOnDisk(LATE).lastReadAt).toBe(at(1800).toISOString())
  })
})
