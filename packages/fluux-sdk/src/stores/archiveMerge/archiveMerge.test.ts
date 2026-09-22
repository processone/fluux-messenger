import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createArchiveMerge, type ArchiveMergeKind, type CoverageMap, type GapMap } from './index'
import type { CoverageRecord } from '../../core/types/pagination'
import type { GapInterval } from '../shared/mamGap'

const ENTITY = 'e1'
const GAP: GapInterval = { start: 1000, startId: 'g1' }
const NEXT_GAP: GapInterval = { start: 2000, startId: 'g2' }
const RECORD: CoverageRecord = { bottomId: 'bottom-1' }
const DEEPER: CoverageRecord = { bottomId: 'bottom-0' }

describe.each<ArchiveMergeKind>(['chat', 'room'])('archive merge durable commit (%s)', (kind) => {
  let applied: Array<{ change: unknown; guards: unknown; transition: string }>
  let noted: unknown[]
  let current: boolean
  const make = () => createArchiveMerge(kind, {
    captureEntity: () => () => current,
    applyDeferred: (_entityId, change, guards, transition) => { applied.push({ change, guards, transition }) },
    noteApplied: (_entityId, note) => { noted.push(note) },
  })

  const maps = (gap?: GapInterval, record?: CoverageRecord): { gaps: GapMap; coverage: CoverageMap } => ({
    gaps: new Map(gap ? [[ENTITY, gap]] : []),
    coverage: new Map(record ? [[ENTITY, record]] : []),
  })

  beforeEach(() => {
    applied = []
    noted = []
    current = true
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

  describe('planMerge', () => {
    const msg = (id: string, ts: number, stanzaId?: string) => ({
      type: kind === 'room' ? 'groupchat' : 'chat',
      id,
      ...(kind === 'room' ? { roomJid: ENTITY, nick: 'someone' } : { conversationId: ENTITY }),
      from: kind === 'room' ? `${ENTITY}/someone` : ENTITY,
      body: id,
      isOutgoing: false,
      timestamp: new Date(ts),
      ...(stanzaId ? { stanzaId } : {}),
    }) as never

    const facts = (overrides: Partial<Parameters<ReturnType<typeof make>['planMerge']>[1]> = {}) => ({
      gaps: new Map(),
      coverage: new Map(),
      mamStates: new Map(),
      direction: 'backward' as const,
      complete: true,
      isFetchLatest: false,
      preserveGapMarker: false,
      page: { first: 'arch-1', last: 'arch-2' },
      extras: undefined,
      merged: [msg('m1', 1000, 'arch-1')],
      fetched: [msg('m1', 1000, 'arch-1')],
      newMessagesCount: 1,
      patchedCount: 0,
      residentNewestTs: 2000,
      newestHeldBelowId: 'arch-9',
      fallbackHeldTs: 2000,
      gatedOnDurableWrite: false,
      ...overrides,
    })

    it('records where coverage now reaches, and says the bottom is proven', () => {
      // A fetch-latest names its own bottom: the oldest row the page carried.
      const plan = make().planMerge(ENTITY, facts({ isFetchLatest: true }))
      expect(plan.coverageAfterMerge.get(ENTITY)?.bottomId).toBe('arch-1')
      // Nothing to clear leaves the flag unwritten; what matters is that it is not raised.
      expect(plan.mamStates.get(ENTITY)?.coverageBottomUnproven).not.toBe(true)
      expect(plan.coverageChanged).toBe(true)
    })

    it('flags an unproven bottom when a disjoint fetch-latest lands above held history', () => {
      // Nothing resident to anchor a boundary, and the page sits above the entity's preview: the
      // rows in between were never fetched, so cache-oldest is not contiguous with the live edge.
      const plan = make().planMerge(ENTITY, facts({
        isFetchLatest: true,
        residentNewestTs: undefined,
        fallbackHeldTs: 500,
        merged: [msg('m1', 1000, 'arch-1')],
        fetched: [msg('m1', 1000, 'arch-1')],
      }))
      expect(plan.mamStates.get(ENTITY)?.coverageBottomUnproven).toBe(true)
    })

    it('holds the whole plan back when the rows it names are not stored yet', () => {
      const plan = make().planMerge(ENTITY, facts({ isFetchLatest: true, gatedOnDurableWrite: true }))
      expect(plan.deferred).toBe(true)
      expect(plan.coverageAfterMerge.size).toBe(0)
      expect(noted).toEqual([])
    })

    it('says when a created record took its bottom from the walk rather than a cursor', () => {
      // A forward catch-up that came back complete proves everything from its oldest row to the
      // live edge came down in it, so that row anchors the record.
      const plan = make().planMerge(ENTITY, facts({
        direction: 'forward',
        complete: true,
        extras: { walkOldestId: 'arch-1' },
      }))
      expect(plan.coverageBootstrappedFromWalkExtent).toBe(true)
    })
  })
})
