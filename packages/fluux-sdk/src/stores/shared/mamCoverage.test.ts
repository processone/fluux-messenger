import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { Message, RoomMessage } from '../../core/types'
import { _resetStorageScopeForTesting } from '../../utils/storageScope'
// Must import after fake-indexeddb/auto
import * as messageCache from '../../utils/messageCache'
import {
  syncCoverageAfterArchiveMerge,
  serializeCoverage,
  deserializeCoverage,
  isCaughtUpForCounting,
  resolveCoverageBottom,
  walkExtentBottomId,
  type CoverageRecord,
  type ArchiveMergeCoverageInput,
} from './mamCoverage'

const base = (over: Partial<ArchiveMergeCoverageInput> = {}): ArchiveMergeCoverageInput => ({
  coverage: new Map<string, CoverageRecord>(),
  id: 'a@b',
  direction: 'backward',
  isFetchLatest: true,
  preserveGapMarker: false,
  sawCoverageTop: false,
  walkCarriedModifications: false,
  ...over,
})

describe('syncCoverageAfterArchiveMerge', () => {
  it('fetch-latest establishes the record from the walk extent', () => {
    const out = syncCoverageAfterArchiveMerge(base({ rsmFirst: 'deep', fetchLatestTopId: 'top' }))
    expect(out.coverage.get('a@b')).toEqual({ bottomId: 'deep', topId: 'top' })
  })

  it('signal-only give-up (zero messages, page.first set) still establishes the record', () => {
    // The walked window IS proven contiguous coverage even with
    // zero displayable messages — this is the durable resume for the cap.
    const out = syncCoverageAfterArchiveMerge(base({ rsmFirst: 'page5-first', fetchLatestTopId: 'page1-last' }))
    expect(out.coverage.get('a@b')).toEqual({ bottomId: 'page5-first', topId: 'page1-last' })
  })

  it('disjoint fetch-latest REPLACES a stale record', () => {
    const coverage = new Map([['a@b', { bottomId: 'old-deep', topId: 'old-top' }]])
    const out = syncCoverageAfterArchiveMerge(base({ coverage, rsmFirst: 'new-deep', fetchLatestTopId: 'new-top' }))
    expect(out.coverage.get('a@b')).toEqual({ bottomId: 'new-deep', topId: 'new-top' })
  })

  it('a walk that SAW the existing topId keeps the deeper bottom, refreshes topId', () => {
    // Only re-entering the covered region (the walk contained
    // the record's top entry) proves contiguity with the existing record.
    const coverage = new Map([['a@b', { bottomId: 'deep', topId: 'old-top' }]])
    const out = syncCoverageAfterArchiveMerge(
      base({ coverage, rsmFirst: 'shallow', fetchLatestTopId: 'new-top', sawCoverageTop: true })
    )
    expect(out.coverage.get('a@b')).toEqual({ bottomId: 'deep', topId: 'new-top' })
  })

  it('dedupe against arbitrary local data does NOT keep the old bottom (island overlap is no proof)', () => {
    // Scenario: coverage [100..200], fetchContext island
    // [280..320] resident, fetch-latest [301..400] dedupes against the
    // island. Keeping bottomId=100 would certify the hole [201..279].
    // Without sighting the record's topId, the record must be REPLACED by
    // the walked window.
    const coverage = new Map([['a@b', { bottomId: 'id-100', topId: 'id-200' }]])
    const out = syncCoverageAfterArchiveMerge(
      base({ coverage, rsmFirst: 'id-301', fetchLatestTopId: 'id-400', sawCoverageTop: false })
    )
    expect(out.coverage.get('a@b')).toEqual({ bottomId: 'id-301', topId: 'id-400' })
  })

  it('a walk that carried modifications never certifies coverage (their cache writes are fire-and-forget)', () => {
    // Corrections/retractions/reactions on walked pages are
    // applied via unawaited cache updates (and dropped entirely for
    // non-resident targets). Certifying the walk would let a later floor
    // jump skip them forever — so it must not form, extend, or refresh a
    // record.
    const empty = new Map<string, CoverageRecord>()
    expect(syncCoverageAfterArchiveMerge(
      base({ coverage: empty, rsmFirst: 'deep', fetchLatestTopId: 'top', walkCarriedModifications: true })
    ).coverage).toBe(empty)

    const existing = new Map([['a@b', { bottomId: 'deep', topId: 'top' }]])
    expect(syncCoverageAfterArchiveMerge(
      base({ coverage: existing, isFetchLatest: false, initialBefore: 'deep', rsmFirst: 'deeper', walkCarriedModifications: true })
    ).coverage).toBe(existing)
  })

  it('plain backward page extends the bottom only when resumed exactly from it', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep', topId: 'top' }]])
    const extended = syncCoverageAfterArchiveMerge(
      base({ coverage, isFetchLatest: false, initialBefore: 'deep', rsmFirst: 'deeper' })
    )
    expect(extended.coverage.get('a@b')).toEqual({ bottomId: 'deeper', topId: 'top' })
    const stray = syncCoverageAfterArchiveMerge(
      base({ coverage, isFetchLatest: false, initialBefore: 'elsewhere', rsmFirst: 'x' })
    )
    expect(stray.coverage).toBe(coverage) // copy-on-write no-op
  })

  it('never touches the record for preserveGapMarker (windowed) or forward merges', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep' }]])
    expect(syncCoverageAfterArchiveMerge(base({ coverage, preserveGapMarker: true, rsmFirst: 'x' })).coverage).toBe(coverage)
    expect(
      syncCoverageAfterArchiveMerge(base({ coverage, direction: 'forward', isFetchLatest: false, rsmFirst: 'x' })).coverage
    ).toBe(coverage)
  })

  describe('forward-catch-up bootstrap', () => {
    // Without this, a record can only be BORN by a `before:''` fetch-latest,
    // which selectCatchUpQuery only issues when the cache is EMPTY — an
    // entity's first-ever sync. Every entity cached before the record shipped
    // therefore never gets one, and Phase B permanently falls back to the
    // cache-bottom probe. A forward catch-up that reports complete proves
    // [resume cursor → live] is contiguous, which is exactly a coverage bottom.
    const fwd = (over: Partial<ArchiveMergeCoverageInput> = {}) =>
      base({ direction: 'forward', isFetchLatest: false, ...over })

    it('a completed forward catch-up seeds the record from its resume cursor', () => {
      const out = syncCoverageAfterArchiveMerge(fwd({ complete: true, initialAfter: 'local-edge' }))
      expect(out.coverage.get('a@b')).toEqual({ bottomId: 'local-edge' })
    })

    it('an INCOMPLETE forward catch-up seeds nothing (it never reached live)', () => {
      const coverage = new Map<string, CoverageRecord>()
      expect(
        syncCoverageAfterArchiveMerge(fwd({ coverage, complete: false, initialAfter: 'local-edge' })).coverage
      ).toBe(coverage)
    })

    it('a completed forward catch-up never shallows an existing, deeper record', () => {
      const coverage = new Map([['a@b', { bottomId: 'much-deeper', topId: 'top' }]])
      expect(
        syncCoverageAfterArchiveMerge(fwd({ coverage, complete: true, initialAfter: 'local-edge' })).coverage
      ).toBe(coverage)
    })

    it('a completed `start`-filtered catch-up seeds from its own walk extent', () => {
      // No resume cursor (the local edge was an own send with no archive id),
      // so the anchor is the oldest entry the completed walk carried itself.
      const out = syncCoverageAfterArchiveMerge(fwd({ complete: true, walkOldestId: 'walk-oldest' }))
      expect(out.coverage.get('a@b')).toEqual({ bottomId: 'walk-oldest' })
      expect(out.transition).toBe('created')
    })

    it('an INCOMPLETE catch-up seeds nothing from its walk extent either', () => {
      // Completion is the whole warrant for trusting the extent: without it
      // nothing connects the walk's oldest entry to the live edge.
      const coverage = new Map<string, CoverageRecord>()
      expect(
        syncCoverageAfterArchiveMerge(fwd({ coverage, complete: false, walkOldestId: 'walk-oldest' })).coverage
      ).toBe(coverage)
    })

    it('the resume cursor still wins over the walk extent when both are present', () => {
      const out = syncCoverageAfterArchiveMerge(
        fwd({ complete: true, initialAfter: 'local-edge', walkOldestId: 'walk-oldest' })
      )
      expect(out.coverage.get('a@b')).toEqual({ bottomId: 'local-edge' })
    })

    it('a completed forward catch-up with neither cursor nor extent seeds nothing', () => {
      // An empty `start`-filtered walk has no extent to claim.
      const coverage = new Map<string, CoverageRecord>()
      expect(syncCoverageAfterArchiveMerge(fwd({ coverage, complete: true })).coverage).toBe(coverage)
    })

    it('a walk extent never shallows an existing, deeper record', () => {
      const coverage = new Map([['a@b', { bottomId: 'much-deeper', topId: 'top' }]])
      expect(
        syncCoverageAfterArchiveMerge(fwd({ coverage, complete: true, walkOldestId: 'walk-oldest' })).coverage
      ).toBe(coverage)
    })

    it('a walk extent from a walk that carried modifications never seeds', () => {
      const coverage = new Map<string, CoverageRecord>()
      expect(
        syncCoverageAfterArchiveMerge(
          fwd({ coverage, complete: true, walkOldestId: 'walk-oldest', walkCarriedModifications: true })
        ).coverage
      ).toBe(coverage)
    })

    it('a bounded windowed query never seeds from its walk extent', () => {
      const coverage = new Map<string, CoverageRecord>()
      expect(
        syncCoverageAfterArchiveMerge(
          fwd({ coverage, complete: true, walkOldestId: 'walk-oldest', preserveGapMarker: true })
        ).coverage
      ).toBe(coverage)
    })

    it('a BACKWARD merge never seeds from a walk extent', () => {
      // The extent is a forward-catch-up claim only: a backward page proves
      // nothing about the live edge it never reached.
      const coverage = new Map<string, CoverageRecord>()
      expect(
        syncCoverageAfterArchiveMerge(
          base({ coverage, isFetchLatest: false, complete: true, walkOldestId: 'walk-oldest' })
        ).coverage
      ).toBe(coverage)
    })

    it('a completed forward catch-up that carried modifications never seeds', () => {
      // Same invariant the backward branch enforces: the walk's
      // modification cache-writes are fire-and-forget, so nothing it touched is
      // durably confirmed enough to certify coverage.
      const coverage = new Map<string, CoverageRecord>()
      expect(
        syncCoverageAfterArchiveMerge(
          fwd({ coverage, complete: true, initialAfter: 'local-edge', walkCarriedModifications: true })
        ).coverage
      ).toBe(coverage)
    })

    it('a bounded windowed forward query never seeds (proves nothing about live)', () => {
      const coverage = new Map<string, CoverageRecord>()
      expect(
        syncCoverageAfterArchiveMerge(
          fwd({ coverage, complete: true, initialAfter: 'local-edge', preserveGapMarker: true })
        ).coverage
      ).toBe(coverage)
    })
  })

  it('empty fetch-latest with no page.first (empty archive) is a no-op', () => {
    const coverage = new Map<string, CoverageRecord>()
    expect(syncCoverageAfterArchiveMerge(base({ coverage })).coverage).toBe(coverage)
  })

  it('returns the same reference when the computed record is unchanged', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep', topId: 'top' }]])
    expect(syncCoverageAfterArchiveMerge(base({ coverage, rsmFirst: 'deep', fetchLatestTopId: 'top' })).coverage).toBe(coverage)
  })
})

/**
 * The reported {@link CoverageTransition} is what the persistence layer keys its
 * hard-kill durability decision on (#1138), so every branch has to be pinned —
 * not just the one that force-flushes. A mutant that reported `'replaced'`
 * everywhere would be perfectly correct about the MAP and would silently undo
 * the whole optimization; a mutant that reported it nowhere would silently undo
 * #1133's durability. Both directions are asserted below.
 */
describe('syncCoverageAfterArchiveMerge — reported transition', () => {
  it('reports `replaced` ONLY when an existing record is overwritten with contiguity unproven', () => {
    const coverage = new Map([['a@b', { bottomId: 'old-deep', topId: 'old-top' }]])
    expect(
      syncCoverageAfterArchiveMerge(base({ coverage, rsmFirst: 'new-deep', fetchLatestTopId: 'new-top' })).transition
    ).toBe('replaced')
  })

  it('reports `created` for the first-ever fetch-latest — there is no assertion to overwrite', () => {
    expect(
      syncCoverageAfterArchiveMerge(base({ rsmFirst: 'deep', fetchLatestTopId: 'top' })).transition
    ).toBe('created')
  })

  it('reports `created` for the forward-catch-up bootstrap', () => {
    expect(
      syncCoverageAfterArchiveMerge(
        base({ direction: 'forward', isFetchLatest: false, complete: true, initialAfter: 'local-edge' })
      ).transition
    ).toBe('created')
  })

  it('reports `deepened` for a plain backward page resumed id-exactly from the bottom', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep', topId: 'top' }]])
    expect(
      syncCoverageAfterArchiveMerge(
        base({ coverage, isFetchLatest: false, initialBefore: 'deep', rsmFirst: 'deeper' })
      ).transition
    ).toBe('deepened')
  })

  it('reports `topRefreshed` when contiguity WAS proven and only the re-entry marker moves', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep', topId: 'old-top' }]])
    expect(
      syncCoverageAfterArchiveMerge(
        base({ coverage, rsmFirst: 'shallow', fetchLatestTopId: 'new-top', sawCoverageTop: true })
      ).transition
    ).toBe('topRefreshed')
  })

  it('reports `none` for every branch that leaves the map alone', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep', topId: 'top' }]])
    const none = (over: Partial<ArchiveMergeCoverageInput>) =>
      syncCoverageAfterArchiveMerge(base({ coverage, ...over })).transition
    expect(none({ preserveGapMarker: true, rsmFirst: 'x' })).toBe('none')
    expect(none({ walkCarriedModifications: true, rsmFirst: 'x' })).toBe('none')
    expect(none({ rsmFirst: undefined })).toBe('none')
    expect(none({ rsmFirst: 'deep', fetchLatestTopId: 'top' })).toBe('none') // identical record
    expect(none({ isFetchLatest: false, initialBefore: 'elsewhere', rsmFirst: 'x' })).toBe('none')
    expect(none({ direction: 'forward', isFetchLatest: false, complete: true, initialAfter: 'edge' })).toBe('none')
  })
})

describe('walkExtentBottomId', () => {
  const msg = (over: Record<string, unknown>) => ({ id: 'x', ...over }) as unknown as Message

  it('returns the oldest archived entry the walk carried', () => {
    expect(walkExtentBottomId([
      msg({ stanzaId: 'mid', timestamp: new Date(2000) }),
      msg({ stanzaId: 'oldest', timestamp: new Date(1000) }),
      msg({ stanzaId: 'newest', timestamp: new Date(3000) }),
    ])).toBe('oldest')
  })

  it('skips id-less entries rather than giving up on the whole anchor', () => {
    // An own send still awaiting its archive id cannot name a bottom; the
    // next-oldest archived entry is a shallower but equally true one.
    expect(walkExtentBottomId([
      msg({ originId: 'own', timestamp: new Date(1000) }),
      msg({ stanzaId: 'archived', timestamp: new Date(2000) }),
    ])).toBe('archived')
  })

  it('skips `noLocalStore` entries — they never reach the cache the record resolves against', () => {
    expect(walkExtentBottomId([
      msg({ stanzaId: 'transient', timestamp: new Date(1000), noLocalStore: true }),
      msg({ stanzaId: 'stored', timestamp: new Date(2000) }),
    ])).toBe('stored')
  })

  it('has no extent for an empty walk, or one with nothing anchorable', () => {
    expect(walkExtentBottomId([])).toBeUndefined()
    expect(walkExtentBottomId([msg({ stanzaId: 'no-timestamp' })])).toBeUndefined()
    expect(walkExtentBottomId([msg({ originId: 'own', timestamp: new Date(1000) })])).toBeUndefined()
  })
})

describe('coverage (de)serialization', () => {
  it('round-trips', () => {
    const m = new Map([['a@b', { bottomId: 'x', topId: 'y' }]])
    expect(deserializeCoverage(serializeCoverage(m))).toEqual(m)
  })

  it('returns empty map on garbage', () => {
    expect(deserializeCoverage('nope').size).toBe(0)
  })

  it('drops malformed entries missing bottomId', () => {
    const json = JSON.stringify([['a@b', { topId: 'only-top' }], ['c@d', { bottomId: 'ok' }]])
    const out = deserializeCoverage(json)
    expect(out.has('a@b')).toBe(false)
    expect(out.get('c@d')).toEqual({ bottomId: 'ok' })
  })
})

describe('isCaughtUpForCounting', () => {
  // The gate's whole point: this gate is STRICTER than the publisher's
  // `archiveIsTrustworthy` (mdsSideEffects.ts:200), which treats "never
  // queried and not loading" as trustworthy. That shortcut is correct for a
  // freshly-created entity (nothing to misreport) but unsafe here: a
  // RESTORED entity carries durable coverage from a prior session, so at
  // cold start `hasQueried` is false (session state) while the archive is
  // genuinely stale until this session's catch-up runs. Counting from it
  // would under-count and overwrite a correct persisted value — the unsafe
  // direction. So this gate never looks at `hasQueried` at all.
  it('restored entity — never queried this session, idle, archive stale ⇒ false (the naive gate would say true)', () => {
    expect(isCaughtUpForCounting({ hasQueried: false, isLoading: false, isCaughtUpToLive: false })).toBe(false)
  })

  it('loading ⇒ false', () => {
    expect(isCaughtUpForCounting({ hasQueried: true, isLoading: true, isCaughtUpToLive: true })).toBe(false)
  })

  it('caught up, idle ⇒ true', () => {
    expect(isCaughtUpForCounting({ hasQueried: true, isLoading: false, isCaughtUpToLive: true })).toBe(true)
  })

  it('not caught up, idle ⇒ false', () => {
    expect(isCaughtUpForCounting({ hasQueried: true, isLoading: false, isCaughtUpToLive: false })).toBe(false)
  })
})

describe('resolveCoverageBottom', () => {
  const CONV = 'alice@example.com'
  const ROOM = 'room@conference.example.com'

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    ;(messageCache as { _resetDBForTesting?: () => void })._resetDBForTesting?.()
    _resetStorageScopeForTesting()
  })

  const mockMessage = (overrides: Partial<Message> = {}): Message => ({
    type: 'chat',
    id: 'client-id-1',
    conversationId: CONV,
    from: CONV,
    body: 'hi',
    timestamp: new Date(1000),
    isOutgoing: false,
    ...overrides,
  })

  const mockRoomMessage = (overrides: Partial<RoomMessage> = {}): RoomMessage => ({
    type: 'groupchat',
    id: 'client-id-1',
    roomJid: ROOM,
    from: `${ROOM}/alice`,
    body: 'hi',
    timestamp: new Date(1000),
    isOutgoing: false,
    nick: 'alice',
    ...overrides,
  })

  it('resolves a bottomId that is cached to its archive position', async () => {
    await messageCache.saveMessage(mockMessage({ stanzaId: 'archive-42', timestamp: new Date(9000) }))
    const out = await resolveCoverageBottom(CONV, { bottomId: 'archive-42' }, false)
    expect(out).toEqual({ role: 'exact', timestamp: 9000, tiebreak: { kind: 'chat', id: 'client-id-1' } })
  })

  it('resolves a bottomId scoped to a room, distinct from the chat lookup', async () => {
    await messageCache.saveRoomMessages([mockRoomMessage({ stanzaId: 'archive-42', timestamp: new Date(7000) })])
    const out = await resolveCoverageBottom(ROOM, { bottomId: 'archive-42' }, true)
    expect(out).toEqual({
      role: 'exact',
      timestamp: 7000,
      tiebreak: { kind: 'room', from: `${ROOM}/alice`, id: 'client-id-1' },
    })
  })

  it('no coverage record ⇒ "missing" (caller must defer, not treat as covered)', async () => {
    const out = await resolveCoverageBottom(CONV, undefined, false)
    expect(out).toBe('missing')
  })

  it('dangling bottomId (record names a message no longer cached) ⇒ "unresolvable"', async () => {
    const out = await resolveCoverageBottom(ROOM, { bottomId: 'evicted-id' }, true)
    expect(out).toBe('unresolvable')
  })
})
