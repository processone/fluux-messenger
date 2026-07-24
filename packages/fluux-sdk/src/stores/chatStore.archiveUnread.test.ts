/**
 * Task 7 (PR B) — chatStore.recomputeUnreadForConversation: archive-derived
 * unread, coverage-gated, latest-wins, mentionsCount-preserving, divider-
 * rederiving.
 *
 * Unlike chatStore.test.ts / chatStore.mds.test.ts, this file does NOT fully
 * mock `../utils/messageCache` — `countUnreadInArchive` and
 * `resolveArchivePosition` run for REAL against fake-indexeddb (wrapped in
 * `vi.fn(actual)` only so the latest-wins test can control resolution order
 * for one call). Everything else in messageCache is the real implementation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { chatStore } from './chatStore'
import { noteTransient, removeTransient, transientIdentity, transientAliases, clearTransientScope, type ScopeKey } from './shared/transientUnread'
import { _resetStorageScopeForTesting, getStorageScopeJid } from '../utils/storageScope'
import type { Message, Conversation } from '../core/types'

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    // Real by default; wrapped so individual tests can control resolution
    // order (vi.fn.mockImplementationOnce) without disabling the real cursor.
    countUnreadInArchive: vi.fn(actual.countUnreadInArchive),
  }
})
import * as messageCache from '../utils/messageCache'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

const CID = 'carol@example.com'

function createConversation(id: string): Conversation {
  return { id, name: id, type: 'chat', unreadCount: 0 }
}

function archiveMsg(id: string, ts: number, overrides: Partial<Message> = {}): Message {
  return {
    type: 'chat',
    id,
    conversationId: CID,
    from: CID,
    body: 'hi',
    timestamp: new Date(ts),
    isOutgoing: false,
    ...overrides,
  }
}

/** Mark the conversation caught-up-to-live with a coverage record whose bottom
 *  resolves to a REAL archived row at `bottomTs` (must be saved separately). */
function seedCoverage(bottomId: string): void {
  chatStore.setState((state) => {
    const mamQueryStates = new Map(state.mamQueryStates)
    mamQueryStates.set(CID, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true })
    const conversationCoverage = new Map(state.conversationCoverage)
    conversationCoverage.set(CID, { bottomId })
    return { mamQueryStates, conversationCoverage }
  })
}

function setMeta(patch: Record<string, unknown>): void {
  chatStore.setState((state) => {
    const meta = new Map(state.conversationMeta)
    meta.set(CID, { ...(meta.get(CID) ?? { unreadCount: 0 }), ...patch } as never)
    return { conversationMeta: meta }
  })
}

function scopeKey(): ScopeKey {
  return { accountScope: getStorageScopeJid() ?? '', kind: 'chat', entityId: CID }
}

describe('chatStore.recomputeUnreadForConversation — archive-derived unread (PR B)', () => {
  beforeEach(async () => {
    _resetStorageScopeForTesting()
    globalThis.indexedDB = new IDBFactory()
    ;(messageCache as unknown as { _resetDBForTesting?: () => void })._resetDBForTesting?.()
    localStorageMock.clear()
    chatStore.getState().reset()
    chatStore.getState().addConversation(createConversation(CID))
    // mockClear() only resets call history, never the base implementation set
    // by vi.fn(actual.countUnreadInArchive) above, so it stays real by default.
    vi.mocked(messageCache.countUnreadInArchive).mockClear()
    // The transient overlay is a module-level singleton (never cleared on
    // deactivation by design) — reset it between tests explicitly.
    clearTransientScope(getStorageScopeJid() ?? '')
  })

  // ---------------------------------------------------------------------
  // exact
  // ---------------------------------------------------------------------

  it('backgrounded deep pointer with proven coverage derives an exact count from the archive', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
      archiveMsg('u2', 1002),
      archiveMsg('u3', 1003),
    ])
    setMeta({
      unreadCount: 99, // stale — must be overwritten by the exact derivation
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
    expect(chatStore.getState().conversations.get(CID)?.unreadCount).toBe(3)
  })

  it('a migrated pointer with no archiveOrderKey over-counts same-millisecond rows rather than reporting zero', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      // Same millisecond as the pointer's own message — an unresolved pointer
      // key must NOT exclude this (over-count is the safe direction).
      archiveMsg('sibling', 1000),
    ])
    setMeta({
      unreadCount: 0,
      // Legacy/migrated shape: no archiveOrderKey at all.
      readPointer: { messageId: 'p0', timestamp: new Date(1000) },
    })
    seedCoverage('anchor-stanza')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // At-or-after-TIMESTAMP semantics: with the pointer's key unresolved,
    // EVERY row at its exact millisecond counts as "after" it — including the
    // pointer's own message ('p0') — not just the genuinely-new 'sibling'.
    // Over-counting by the same-ms set is the documented safe direction
    // (messageCache.ts's countUnreadInArchive); asserting the naive "just the
    // sibling" value of 1 here would be the wrong, under-counting reading.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
  })

  // ---------------------------------------------------------------------
  // trigger: cold-start rehydrate
  // ---------------------------------------------------------------------

  it('cold-start rehydrate schedules a recount for every restored conversation', async () => {
    localStorage.setItem(
      'xmpp-chat-storage',
      JSON.stringify({
        state: {
          conversationEntities: [[CID, { id: CID, name: CID, type: 'chat' }]],
          conversationMeta: [[CID, { unreadCount: 3, readPointer: { messageId: 'p0', timestamp: 1000, archiveOrderKey: { kind: 'chat', id: 'p0' } } }]],
          conversations: [[CID, { id: CID, name: CID, type: 'chat', unreadCount: 3 }]],
          archivedConversations: [],
        },
      })
    )
    const original = chatStore.getState().recomputeUnreadForConversation
    const spy = vi.fn(original)
    chatStore.setState({ recomputeUnreadForConversation: spy })

    await chatStore.persist.rehydrate()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(spy).toHaveBeenCalledWith(CID)
    // Restore the un-wrapped action so later tests aren't left with a spy.
    chatStore.setState({ recomputeUnreadForConversation: original })
  })

  // ---------------------------------------------------------------------
  // trigger: forward MAM merge past the floor
  // ---------------------------------------------------------------------

  it('a forward MAM merge into a non-active conversation with new messages triggers a recount', () => {
    setMeta({ unreadCount: 0, readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } } })
    chatStore.setState({ activeConversationId: 'someone-else@example.com' })
    const original = chatStore.getState().recomputeUnreadForConversation
    const spy = vi.fn(original)
    chatStore.setState({ recomputeUnreadForConversation: spy })

    chatStore.getState().mergeMAMMessages(
      CID,
      [archiveMsg('u1', 1001)],
      { first: 'u1' },
      true,
      'forward'
    )

    expect(spy).toHaveBeenCalledWith(CID)
    chatStore.setState({ recomputeUnreadForConversation: original })
  })

  // ---------------------------------------------------------------------
  // trigger: pointer advance / inbound remote marker
  // ---------------------------------------------------------------------

  it('a remote marker advancing a non-active conversation triggers a recount', () => {
    setMeta({ unreadCount: 0, readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } } })
    chatStore.setState({ activeConversationId: 'someone-else@example.com' })
    const original = chatStore.getState().recomputeUnreadForConversation
    const spy = vi.fn(original)
    chatStore.setState({ recomputeUnreadForConversation: spy })

    chatStore.getState().applyRemoteDisplayed(CID, 's-u1', [
      archiveMsg('p0', 1000, { stanzaId: 's-p0' }),
      archiveMsg('u1', 1001, { stanzaId: 's-u1' }),
    ])

    expect(spy).toHaveBeenCalledWith(CID)
    chatStore.setState({ recomputeUnreadForConversation: original })
  })

  // ---------------------------------------------------------------------
  // deferred
  // ---------------------------------------------------------------------

  it('un-migrated legacy read state defers even when the archive is fully caught up and covered', async () => {
    // Drive the real #1081 migration path: persist a legacy lastSeenMessageId
    // that the cache does NOT hold, so migrateReadPointer resolves to
    // undefined and the conversation stays registered as un-migrated.
    localStorage.setItem(
      'xmpp-chat-storage',
      JSON.stringify({
        state: {
          conversationEntities: [[CID, { id: CID, name: CID, type: 'chat' }]],
          conversationMeta: [[CID, { unreadCount: 0, lastSeenMessageId: 'ghost-not-in-cache' }]],
          conversations: [[CID, { id: CID, name: CID, type: 'chat', unreadCount: 0, lastSeenMessageId: 'ghost-not-in-cache' }]],
          archivedConversations: [],
        },
      })
    )
    await chatStore.persist.rehydrate()
    // Let the fire-and-forget migration attempt (and the cold-start recount
    // trigger) run to completion; migration cannot resolve 'ghost-not-in-cache'.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBeUndefined()

    // Overwrite to a known sentinel right before the controlled call under
    // test, so any earlier background churn can't be mistaken for THIS
    // assertion. A readPointer AND a genuinely resolvable, caught-up coverage
    // record are ALSO seeded (the activation-races-the-backfill case: the
    // entry can still be registered in unmigratedLegacyReadState after a
    // readPointer already exists from other activity) so this test is
    // specific to hasUnmigratedLegacyReadState — without a real pointer +
    // proven coverage, pointerlessDefers or the coverage gate would
    // independently defer too, and a broken hasUnmigratedLegacyReadState
    // check would go undetected.
    await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
    seedCoverage('anchor-stanza')
    setMeta({ unreadCount: 9, readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } } })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(9)
  })

  it('a pointerless entity with a nonzero persisted count defers rather than trusting a zero derivation', async () => {
    await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })])
    setMeta({
      unreadCount: 4,
      readPointer: undefined,
      historyFloor: new Date(0), // ensure a floor exists so !floor isn't what defers this
    })
    seedCoverage('anchor-stanza')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(4)
  })

  // The reviewer's control (requirement 1): the legacy pass runs — and its
  // OWN pointer-advance guard fires (an outgoing message moves the pointer,
  // exactly the effect Task 7 must keep) — and its would-be COUNT differs
  // sharply from the persisted one (2 vs 5). The persisted value must survive
  // untouched because coverage is not proven. This is the strong form of the
  // control: it is not enough for legacy.readPointer to stay unchanged (which
  // would make "discard the count" trivially true by construction); the
  // pointer must actually move while the count still does not commit.
  it('CRITICAL: not caught up defers, and the persisted count survives even though recomputeCountsFromPointer ran and moved the pointer', async () => {
    await messageCache.saveMessages([
      archiveMsg('p0', 1000),
      archiveMsg('out1', 1001, { isOutgoing: true }), // the user replied — advances the pointer
      archiveMsg('u1', 1002),
      archiveMsg('u2', 1003),
    ])
    setMeta({
      unreadCount: 5, // the persisted/trusted value
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    // Deliberately NOT caught up (default mamQueryStates), and no coverage record.

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // The legacy guard pass DID run and DID advance the pointer to 'out1'
    // (the reply) — that pointer-advance guard behavior is kept. Its own
    // count over the post-out1 slice (u1, u2) would be 2, not 5 — that
    // would-be count is discarded; the persisted 5 survives.
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.messageId).toBe('out1')
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(5)
  })

  it('a missing coverage record defers (not-yet-covered is not the same as nothing to worry about)', async () => {
    await messageCache.saveMessages([archiveMsg('p0', 1000), archiveMsg('u1', 1001)])
    setMeta({
      unreadCount: 7,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    chatStore.setState((state) => {
      const mamQueryStates = new Map(state.mamQueryStates)
      mamQueryStates.set(CID, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true })
      // No conversationCoverage record at all.
      return { mamQueryStates }
    })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(7)
  })

  it('an unresolvable coverage bottom defers AND invalidates the stale record', async () => {
    await messageCache.saveMessages([archiveMsg('p0', 1000), archiveMsg('u1', 1001)])
    setMeta({
      unreadCount: 6,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    // bottomId names an archive stanza-id that was never saved — unresolvable.
    seedCoverage('nonexistent-stanza-id')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(6)
    expect(chatStore.getState().getConversationCoverage(CID)).toBeUndefined()
  })

  // ---------------------------------------------------------------------
  // latest-wins
  // ---------------------------------------------------------------------

  it('latest-wins: a slow recount started before a fast one must not overwrite the fast one', async () => {
    await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
    setMeta({
      unreadCount: 0,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    let releaseSlow!: (v: { unread: number }) => void
    vi.mocked(messageCache.countUnreadInArchive)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSlow = resolve }))
      .mockImplementationOnce(async () => ({ unread: 2 }))

    const slow = chatStore.getState().recomputeUnreadForConversation(CID) // A
    await vi.waitFor(() => expect(releaseSlow).toBeDefined())
    const fast = chatStore.getState().recomputeUnreadForConversation(CID) // B
    await fast

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)

    releaseSlow({ unread: 55 })
    await slow

    // A (slow) resolved LAST but must be discarded — B's result stands.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
  })

  // ---------------------------------------------------------------------
  // divider rederivation
  // ---------------------------------------------------------------------

  it('a remote advance rederives the divider to the new boundary', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
    ])
    setMeta({
      unreadCount: 99,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    // A stale marker left over from a previous activation.
    chatStore.setState((state) => {
      const markers = new Map(state.firstNewMessageMarkers)
      markers.set(CID, 'stale-marker-id')
      return { firstNewMessageMarkers: markers }
    })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('u1')
  })

  it('deletes the divider marker when the derived count is zero', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
    ])
    setMeta({
      unreadCount: 99,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    chatStore.setState((state) => {
      const markers = new Map(state.firstNewMessageMarkers)
      markers.set(CID, 'stale-marker-id')
      return { firstNewMessageMarkers: markers }
    })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    expect(chatStore.getState().firstNewMessageMarkers.has(CID)).toBe(false)
  })

  // ---------------------------------------------------------------------
  // mentionsCount is NEVER written (three outcomes)
  // ---------------------------------------------------------------------

  describe('mentionsCount is left unchanged by every outcome', () => {
    // ConversationMetadata has no real mentionsCount field (conversations
    // don't track mentions) — seed one anyway to prove the derivation always
    // spreads the existing meta rather than reconstructing it, so ANY field
    // it doesn't explicitly own (mentionsCount included) survives verbatim.
    const SEEDED_MENTIONS = 7

    it('exact outcome', async () => {
      await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
      // Seeded unreadCount (5) deliberately differs from the true exact
      // derivation (0, since nothing is archived after the pointer) — this
      // forces the commit path to actually run (a no-op "nothing changed"
      // skip would let a broken mentionsCount-dropping write hide undetected).
      setMeta({
        unreadCount: 5,
        mentionsCount: SEEDED_MENTIONS,
        readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
      })
      seedCoverage('anchor-stanza')

      await chatStore.getState().recomputeUnreadForConversation(CID)

      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
      expect((chatStore.getState().conversationMeta.get(CID) as unknown as { mentionsCount: number }).mentionsCount).toBe(SEEDED_MENTIONS)
    })

    it('deferred outcome', async () => {
      setMeta({ unreadCount: 3, mentionsCount: SEEDED_MENTIONS, readPointer: { messageId: 'p0', timestamp: new Date(1000) } })
      // Not caught up — defers.

      await chatStore.getState().recomputeUnreadForConversation(CID)

      expect((chatStore.getState().conversationMeta.get(CID) as unknown as { mentionsCount: number }).mentionsCount).toBe(SEEDED_MENTIONS)
    })

    it('unavailable outcome', async () => {
      await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
      setMeta({
        unreadCount: 3,
        mentionsCount: SEEDED_MENTIONS,
        readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
      })
      seedCoverage('anchor-stanza')
      vi.mocked(messageCache.countUnreadInArchive).mockResolvedValueOnce(null)

      await chatStore.getState().recomputeUnreadForConversation(CID)

      expect((chatStore.getState().conversationMeta.get(CID) as unknown as { mentionsCount: number }).mentionsCount).toBe(SEEDED_MENTIONS)
      // unavailable also leaves unreadCount untouched.
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
    })
  })

  // ---------------------------------------------------------------------
  // transient overlay
  // ---------------------------------------------------------------------

  it('the transient overlay is summed into the committed unread count', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
      archiveMsg('u2', 1002),
    ])
    setMeta({
      unreadCount: 0,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    // One never-archived (noLocalStore) message, after the pointer.
    const key = scopeKey()
    noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity({ id: 'ephemeral-1' }, 'chat'), transientAliases({ id: 'ephemeral-1' }, 'chat'))

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // 2 archived (u1, u2) + 1 transient = 3.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
  })

  // ---------------------------------------------------------------------
  // Store-level projection tests (overlay mutation -> recompute -> projection)
  // ---------------------------------------------------------------------

  describe('store-level projection: overlay mutations correctly move the committed count', () => {
    // No archived unread in any of these — the committed count is driven
    // purely by the transient overlay, so the assertions are unambiguous.
    beforeEach(async () => {
      await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
      setMeta({
        unreadCount: 0,
        readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
      })
      seedCoverage('anchor-stanza')
    })

    it('re-noting the same logical message through a new alias does not increment the visible count twice', async () => {
      const key = scopeKey()
      const r1 = noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      expect(r1.added).toBe(true)
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)

      // Same logical message re-noted (plain alias registration, nothing new).
      const r2 = noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      expect(r2.added).toBe(false)
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1) // NOT 2
    })

    it('retracting the only transient unread moves the visible count 1 -> 0', async () => {
      const key = scopeKey()
      noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)

      const removed = removeTransient(key, transientIdentity({ id: 'm1' }, 'chat'))
      expect(removed.removed).toBe(true)
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    })

    it('removing one of two transient unread messages moves the visible count 2 -> 1', async () => {
      const key = scopeKey()
      noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      noteTransient(key, { position: { timestamp: 1600 } }, transientIdentity({ id: 'm2' }, 'chat'), transientAliases({ id: 'm2' }, 'chat'))
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)

      removeTransient(key, transientIdentity({ id: 'm1' }, 'chat'))
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)
    })

    it('a bridging alias that coalesces two separately-counted transient entries moves the visible count 2 -> 1', async () => {
      const key = scopeKey()
      noteTransient(key, { position: { timestamp: 1500 } }, 'origin-key-O', ['origin-key-O'])
      noteTransient(key, { position: { timestamp: 1500 } }, 'stanza-key-S', ['stanza-key-S'])
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)

      // A copy carrying BOTH tiers bridges them: added:false, requiresRecount:true.
      const r = noteTransient(key, { position: { timestamp: 1500 } }, 'stanza-key-S', ['stanza-key-S', 'origin-key-O'])
      expect(r).toEqual({ added: false, requiresRecount: true })
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)
    })

    it('an overlay change while not caught up stays conservative and does not clear the trusted count', async () => {
      const key = scopeKey()
      noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)

      // Coverage proof is lost (e.g. a fresh reconnect before this session's
      // catch-up has re-run) — subsequent recomputes must defer.
      chatStore.setState((state) => {
        const mamQueryStates = new Map(state.mamQueryStates)
        mamQueryStates.set(CID, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: false })
        return { mamQueryStates }
      })
      noteTransient(key, { position: { timestamp: 1600 } }, transientIdentity({ id: 'm2' }, 'chat'), transientAliases({ id: 'm2' }, 'chat'))

      await chatStore.getState().recomputeUnreadForConversation(CID)

      // Deferred: the trusted count (1) survives — NOT recomputed to 2, and
      // NOT cleared to 0 either.
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)
    })
  })
})
