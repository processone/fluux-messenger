import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createArchiveMerge, type ArchiveMergeKind, type CoverageMap, type GapMap, type MergePageFacts } from './index'
import { setStorageScopeJid } from '../../utils/storageScope'
import * as searchIndex from '../../utils/searchIndex'
import type { CoverageRecord } from '../../core/types/pagination'
import type { GapInterval } from '../shared/mamGap'
import type { Message } from '../../core/types/chat'
import type { RoomMessage } from '../../core/types/room'

vi.mock('../../utils/searchIndex', () => ({ indexMessages: vi.fn(() => Promise.resolve()) }))

const ENTITY = 'e1'
const GAP: GapInterval = { start: 1000, startId: 'g1' }
const NEXT_GAP: GapInterval = { start: 2000, startId: 'g2' }
const RECORD: CoverageRecord = { bottomId: 'bottom-1' }
const DEEPER: CoverageRecord = { bottomId: 'bottom-0' }

type AnyMessage = Message | RoomMessage

describe.each<ArchiveMergeKind>(['chat', 'room'])('archive merge durable commit (%s)', (kind) => {
  let applied: Array<{ change: unknown; guards: unknown; transition: string }>
  let noted: unknown[]
  let current: boolean
  let replayed: AnyMessage[] | undefined
  let stored: AnyMessage[][]
  let saveOutcome: boolean
  let chained: Array<Promise<boolean>>
  let savesPending: boolean
  let dropped: Array<string | RoomMessage>
  let resumed: string[]
  let scheduled: string[]
  let recounted: string[]
  let markerRetries: Array<{ stanzaId: string; merged: AnyMessage[] }>
  let pendingMarker: string | undefined
  let coverage: CoverageRecord | undefined

  const make = () => createArchiveMerge<AnyMessage>(kind, {
    captureEntity: () => () => current,
    applyDeferred: (_entityId, change, guards, transition) => { applied.push({ change, guards, transition }) },
    noteApplied: (_entityId, note) => { noted.push(note) },
    replayRetractions: (_entityId, page) => replayed ?? page,
    lastHeldTimestamp: () => 2000,
    saveRows: (rows) => { stored.push(rows); return Promise.resolve(saveOutcome) },
    saves: {
      chain: (_id, save) => { chained.push(save); return save },
      has: () => savesPending,
    },
    readTracker: {
      noteUnreadInputsChanged: () => {},
      dropUnreadMessage: (_id, source) => { dropped.push(source); return true },
      resumeDeferredRecounts: (id) => { resumed.push(id) },
      captureUnreadInputs: () => () => true,
      scheduleRecount: (id) => { scheduled.push(id) },
      applyRemoteDisplayed: (_id, stanzaId, merged) => { markerRetries.push({ stanzaId, merged }) },
    },
    unreadKey: (message) => (kind === 'room' ? (message as RoomMessage) : message.id),
    pendingRemoteMarker: () => pendingMarker,
    recountUnread: (id) => { recounted.push(id) },
    coverageOf: () => coverage,
  })

  const maps = (gap?: GapInterval, record?: CoverageRecord): { gaps: GapMap; coverage: CoverageMap } => ({
    gaps: new Map(gap ? [[ENTITY, gap]] : []),
    coverage: new Map(record ? [[ENTITY, record]] : []),
  })

  const msg = (id: string, ts: number, stanzaId?: string) => ({
    type: kind === 'room' ? 'groupchat' : 'chat',
    id,
    ...(kind === 'room' ? { roomJid: ENTITY, nick: 'someone' } : { conversationId: ENTITY }),
    from: kind === 'room' ? `${ENTITY}/someone` : ENTITY,
    body: id,
    isOutgoing: false,
    timestamp: new Date(ts),
    ...(stanzaId ? { stanzaId } : {}),
  }) as unknown as AnyMessage

  const PAGE = { first: 'arch-1', last: 'arch-2' }

  const facts = (overrides: Partial<MergePageFacts<AnyMessage>> = {}): MergePageFacts<AnyMessage> => ({
    gaps: new Map(),
    coverage: new Map(),
    mamStates: new Map(),
    merged: [msg('m1', 1000, 'arch-1')],
    newMessages: [msg('m1', 1000, 'arch-1')],
    patched: [],
    residentNewestTs: 2000,
    newestHeldBelowId: 'arch-9',
    ...overrides,
  })

  beforeEach(() => {
    applied = []
    noted = []
    current = true
    replayed = undefined
    stored = []
    saveOutcome = true
    chained = []
    savesPending = false
    dropped = []
    resumed = []
    scheduled = []
    recounted = []
    markerRetries = []
    pendingMarker = undefined
    coverage = undefined
    setStorageScopeJid('me@example.com')
    vi.mocked(searchIndex.indexMessages).mockClear()
  })

  it('applies a transition at once when the merge has nothing to store', () => {
    const before = maps(GAP, RECORD)
    const after = maps(NEXT_GAP, DEEPER)
    const plan = make().planDurableCommit(ENTITY, {
      gaps: { current: before.gaps, next: after.gaps },
      coverage: { current: before.coverage, next: after.coverage, transition: 'deepened' },
      gatedOnDurableWrite: false,
    })
    expect(plan.deferred).toBe(false)
    expect(plan.gapsAfterMerge).toBe(after.gaps)
    expect(plan.coverageAfterMerge).toBe(after.coverage)
    expect(noted).toEqual([{ gaps: after.gaps, coverage: after.coverage, transition: 'deepened' }])
  })

  it('holds a transition back until the rows it names are stored', async () => {
    const before = maps(GAP, RECORD)
    const after = maps(NEXT_GAP, DEEPER)
    const plan = make().planDurableCommit(ENTITY, {
      gaps: { current: before.gaps, next: after.gaps },
      coverage: { current: before.coverage, next: after.coverage, transition: 'deepened' },
      gatedOnDurableWrite: true,
    })
    // The merge's own write keeps the old cursors: they still describe what is stored.
    expect(plan.deferred).toBe(true)
    expect(plan.gapsAfterMerge).toBe(before.gaps)
    expect(plan.coverageAfterMerge).toBe(before.coverage)
    expect(noted).toEqual([])

    plan.commitWhenDurable(Promise.resolve(true))
    await vi.waitFor(() => expect(applied).toHaveLength(1))
    expect(applied[0]).toEqual({
      change: { gaps: NEXT_GAP, coverage: DEEPER },
      // The values the merge computed from, so a later merge's transition is not clobbered.
      guards: { gap: GAP, coverage: RECORD },
      transition: 'deepened',
    })
  })

  it('commits nothing when the write reports it did not store the rows', async () => {
    const before = maps(GAP, RECORD)
    const after = maps(NEXT_GAP, DEEPER)
    const plan = make().planDurableCommit(ENTITY, {
      gaps: { current: before.gaps, next: after.gaps },
      coverage: { current: before.coverage, next: after.coverage, transition: 'deepened' },
      gatedOnDurableWrite: true,
    })
    plan.commitWhenDurable(Promise.resolve(false))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(applied).toEqual([])
  })

  it('commits nothing once the entity or its cache has been torn down', async () => {
    const before = maps(GAP, RECORD)
    const after = maps(NEXT_GAP, DEEPER)
    const plan = make().planDurableCommit(ENTITY, {
      gaps: { current: before.gaps, next: after.gaps },
      coverage: { current: before.coverage, next: after.coverage, transition: 'deepened' },
      gatedOnDurableWrite: true,
    })
    current = false
    plan.commitWhenDurable(Promise.resolve(true))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(applied).toEqual([])
  })

  it('defers only what changed', async () => {
    const before = maps(GAP, RECORD)
    const plan = make().planDurableCommit(ENTITY, {
      // The gap map is the very one the merge read: nothing to transition.
      gaps: { current: before.gaps, next: before.gaps },
      coverage: { current: before.coverage, next: maps(GAP, DEEPER).coverage, transition: 'deepened' },
      gatedOnDurableWrite: true,
    })
    plan.commitWhenDurable(Promise.resolve(true))
    await vi.waitFor(() => expect(applied).toHaveLength(1))
    expect(applied[0]).toMatchObject({ change: { coverage: DEEPER } })
    expect(Object.keys((applied[0] as { change: object }).change)).toEqual(['coverage'])
  })

  it('carries a gap deletion, not just a replacement', async () => {
    const before = maps(GAP, RECORD)
    const plan = make().planDurableCommit(ENTITY, {
      // A backward page that reached across the gap closes it.
      gaps: { current: before.gaps, next: new Map() },
      coverage: { current: before.coverage, next: before.coverage, transition: 'none' },
      gatedOnDurableWrite: true,
    })
    plan.commitWhenDurable(Promise.resolve(true))
    await vi.waitFor(() => expect(applied).toHaveLength(1))
    expect((applied[0] as { change: { gaps?: GapInterval } }).change).toEqual({ gaps: undefined })
  })

  describe('storePage', () => {
    const run = (options = {}, complete = true, direction: 'backward' | 'forward' = 'backward') =>
      make().begin(ENTITY, [msg('m1', 1000, 'arch-1')], PAGE, complete, direction, options)

    it('records where coverage now reaches, and says the bottom is proven', async () => {
      // A fetch-latest names its own bottom: the oldest row the page carried.
      const plan = run({ isFetchLatest: true }).storePage(facts())
      expect(plan.coverageChanged).toBe(true)
      // Nothing to clear leaves the flag unwritten; what matters is that it is not raised.
      expect(plan.mamStates.get(ENTITY)?.coverageBottomUnproven).not.toBe(true)
      // The page has a row to store, so the record lands with that write, not before it.
      await vi.waitFor(() => expect(applied).toHaveLength(1))
      expect((applied[0].change as { coverage: CoverageRecord }).coverage.bottomId).toBe('arch-1')
    })

    it('flags an unproven bottom when a disjoint fetch-latest lands above held history', () => {
      // Nothing resident to anchor a boundary, and the page sits above the entity's preview: the
      // rows in between were never fetched, so cache-oldest is not contiguous with the live edge.
      const plan = make()
        .begin(ENTITY, [msg('m1', 1000, 'arch-1')], PAGE, true, 'backward', { isFetchLatest: true })
        .storePage(facts({ residentNewestTs: undefined }))
      // `lastHeldTimestamp` is 2000 and the page's oldest row is 1000, so the page is NOT above
      // held history: the seam only forms the other way round.
      expect(plan.mamStates.get(ENTITY)?.coverageBottomUnproven).not.toBe(true)

      const above = make()
        .begin(ENTITY, [msg('m1', 3000, 'arch-1')], PAGE, true, 'backward', { isFetchLatest: true })
        .storePage(facts({
          residentNewestTs: undefined,
          merged: [msg('m1', 3000, 'arch-1')],
          newMessages: [msg('m1', 3000, 'arch-1')],
        }))
      expect(above.mamStates.get(ENTITY)?.coverageBottomUnproven).toBe(true)
    })

    it('holds the whole plan back when the rows it names are not stored yet', () => {
      const plan = run({ isFetchLatest: true }).storePage(facts())
      // The page carried a row to store, so its own transitions wait for that write.
      expect(plan.deferred).toBe(true)
      expect(plan.coverageAfterMerge.size).toBe(0)
      expect(noted).toEqual([])
      expect(stored).toEqual([[msg('m1', 1000, 'arch-1')]])
    })

    it('says when a created record took its bottom from the walk rather than a cursor', () => {
      // A forward catch-up that came back complete proves everything from its oldest row to the
      // live edge came down in it, so that row anchors the record.
      const plan = run({ extras: { walkOldestId: 'arch-1' } }, true, 'forward').storePage(facts())
      expect(plan.coverageBootstrappedFromWalkExtent).toBe(true)
      // The badge cannot be counted from the page that bootstrapped the record.
      expect(plan.extendsHistoryPastFloor).toBe(false)
    })

    it('says a forward page extended history past the read pointer', () => {
      const plan = run({}, false, 'forward').storePage(facts())
      expect(plan.extendsHistoryPastFloor).toBe(true)
    })

    it('merges the page the retraction replay handed back, not the archive page', () => {
      const tombstone = msg('m1', 1000, 'arch-1')
      replayed = [tombstone]
      const merge = run()
      expect(merge.messages).toEqual([tombstone])
      merge.storePage(facts({ newMessages: [tombstone] }))
      expect(stored).toEqual([[tombstone]])
    })

    it('chains a no-op write so a transition deferred behind an earlier page still commits', async () => {
      // Nothing of this page's own to store, but an earlier page of the same entity is in
      // flight: its cursor must not leap one that never landed.
      savesPending = true
      const plan = run({ isFetchLatest: true }).storePage(facts({ newMessages: [], merged: [] }))
      expect(stored).toEqual([])
      expect(plan.deferred).toBe(true)
      expect(chained).toHaveLength(1)
      await vi.waitFor(() => expect(applied).toHaveLength(1))
    })

    it('indexes the rows it stored for search', () => {
      run().storePage(facts())
      expect(vi.mocked(searchIndex.indexMessages)).toHaveBeenCalledWith([msg('m1', 1000, 'arch-1')])
    })
  })

  describe('settled', () => {
    const merged = [msg('m1', 1000, 'arch-1')]

    it('hands the stored rows over to the archive once the write commits', async () => {
      const merge = make().begin(ENTITY, merged, PAGE, true, 'backward')
      merge.storePage(facts())
      merge.settled({ merged, recount: false })
      await vi.waitFor(() => expect(resumed).toEqual([ENTITY]))
      // The rows are countable from the archive now, so they leave the transient overlay.
      expect(dropped).toEqual([kind === 'room' ? merged[0] : 'm1'])
    })

    it('keeps the rows in the overlay when the write failed', async () => {
      saveOutcome = false
      const merge = make().begin(ENTITY, merged, PAGE, true, 'backward')
      merge.storePage(facts())
      merge.settled({ merged, recount: false })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(dropped).toEqual([])
      expect(resumed).toEqual([])
    })

    it('stops the follow-up once the account it read has been switched away', async () => {
      const merge = make().begin(ENTITY, merged, PAGE, true, 'backward')
      merge.storePage(facts())
      setStorageScopeJid('someone-else@example.com')
      merge.settled({ merged, recount: false })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(dropped).toEqual([])
      expect(resumed).toEqual([])
    })

    it('retries a read marker no earlier slice could order, against the merged page', () => {
      pendingMarker = 'arch-1'
      const merge = make().begin(ENTITY, merged, PAGE, true, 'backward')
      merge.storePage(facts())
      merge.settled({ merged, recount: false })
      expect(markerRetries).toEqual([{ stanzaId: 'arch-1', merged }])
    })

    it('re-derives the unread count from the archive when the page asked for it', () => {
      const merge = make().begin(ENTITY, merged, PAGE, true, 'backward')
      merge.storePage(facts())
      merge.settled({ merged, recount: true })
      expect(recounted).toEqual([ENTITY])
    })

    it('reports nothing and schedules nothing for a merge that never reached its rows', () => {
      // The store bailed inside its own write — an unknown room, say. There is no disposition to
      // describe and no count to re-derive.
      const merge = make().begin(ENTITY, merged, PAGE, true, 'backward')
      merge.settled({ merged, recount: false })
      expect(stored).toEqual([])
      expect(dropped).toEqual([])
      expect(recounted).toEqual([])
    })
  })
})
