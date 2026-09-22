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
})
