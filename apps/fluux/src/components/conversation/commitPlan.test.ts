import { describe, expect, it } from 'vitest'
import { planCommit, type CommitFacts, type CommitEventKind } from './commitPlan'

/**
 * Intent: one pure function decides which scroll work a commit owes and in what order, replacing
 * the order implied by the declaration order of the old effects. The first-commit list and each
 * trigger below mirror the dependency lists those effects had.
 */

const fn = () => {}
const callbacks = (): CommitFacts['callbacks'] => ({
  rebaseArrivalBaseline: fn,
  assumeAtBottom: fn,
  assumeAwayFromBottom: fn,
  assumeEntryPosition: fn,
  cancelMediaBatch: fn,
  resetLiveEdgeRepaintDebt: fn,
  resetPendingInput: fn,
  createLiveEdgeExecutor: fn,
  buildSavedPositionExecutor: fn,
  buildUnreadMarkerExecutor: fn,
  buildExplicitTargetExecutor: fn,
  buildDirectionalHistoryExecutor: fn,
  restartDirectionalRestore: fn,
  applyDirectionalReleaseDecision: fn,
  emergencyLiveEdgeWrite: fn,
  reconcileLiveEdge: fn,
  reconcileMessageTargetAfterResize: fn,
})

const facts = (patch: Partial<CommitFacts> = {}): CommitFacts => ({
  conversationId: 'room',
  messageCount: 5,
  firstMessageId: 'm0',
  lastMessageId: 'm4',
  interiorPlacementVersion: 0,
  windowAtLiveEdge: true,
  isLoadingOlder: false,
  isLoadingNewer: false,
  firstNewMessageId: undefined,
  readPointerId: undefined,
  targetMessageId: undefined,
  staticMode: false,
  lastMessageIsOutgoing: false,
  hasTypingIndicator: false,
  rowGrowthSignature: '',
  callbacks: callbacks(),
  ...patch,
})

const kinds = (previous: CommitFacts | null, next: CommitFacts): CommitEventKind[] =>
  planCommit(previous, next).map((event) => event.kind)

const EVERY_COMMIT: CommitEventKind[] = ['refresh-interaction-hold', 'publish-committed']

describe('planCommit', () => {
  it('plans the entry work in the order the old effects ran on the first commit', () => {
    expect(kinds(null, facts())).toEqual([
      'enter-conversation',
      'late-synced-read',
      'settle-divider',
      'refresh-saved-position',
      'refresh-live-edge',
      'restore-directional-window',
      'arrival',
      'typing-indicator',
      'refresh-interaction-hold',
      'remember-read-position',
      'publish-committed',
      'log-mount',
      'store-target',
      'release-directional-window',
    ])
  })

  it('runs every layout event before any passive event', () => {
    const phases = planCommit(null, facts()).map((event) => event.phase)
    expect(phases.indexOf('passive')).toBeGreaterThan(phases.lastIndexOf('layout') - 1)
    expect(phases.slice(phases.indexOf('passive')).every((phase) => phase === 'passive')).toBe(true)
  })

  it('plans only the every-commit work when nothing changed', () => {
    const same = facts()
    expect(kinds(same, facts({ callbacks: same.callbacks }))).toEqual(EVERY_COMMIT)
  })

  it('plans an arrival, a live-edge refresh and a saved-position refresh for an appended message', () => {
    const before = facts()
    const after = facts({ messageCount: 6, lastMessageId: 'm5', callbacks: before.callbacks })
    expect(kinds(before, after)).toEqual([
      'enter-conversation',
      'late-synced-read',
      'refresh-saved-position',
      'refresh-live-edge',
      'restore-directional-window',
      'arrival',
      ...EVERY_COMMIT,
      'store-target',
    ])
  })

  it('plans the whole entry set, in order, on a conversation switch without a row-growth event', () => {
    const before = facts({ rowGrowthSignature: 'a' })
    const after = facts({ conversationId: 'other', rowGrowthSignature: 'b', callbacks: before.callbacks })
    const planned = kinds(before, after)
    expect(planned.slice(0, 3)).toEqual(['enter-conversation', 'late-synced-read', 'settle-divider'])
    expect(planned).not.toContain('row-growth')
  })

  it('plans row growth only for a changed signature in the same conversation', () => {
    const before = facts({ rowGrowthSignature: 'a' })
    expect(kinds(before, facts({ rowGrowthSignature: 'b', callbacks: before.callbacks }))).toContain('row-growth')
    expect(kinds(before, facts({ rowGrowthSignature: 'a', callbacks: before.callbacks }))).not.toContain('row-growth')
  })

  it('hands the divider and typing events what the previous commit held', () => {
    const before = facts({ firstNewMessageId: 'm2', hasTypingIndicator: true })
    const after = facts({ firstNewMessageId: undefined, hasTypingIndicator: false, callbacks: before.callbacks })
    const events = planCommit(before, after)
    expect(events.find((event) => event.kind === 'settle-divider')).toMatchObject({
      sameConversation: true,
      previousDivider: 'm2',
    })
    expect(events.find((event) => event.kind === 'typing-indicator')).toMatchObject({
      sameConversation: true,
      hadTypingIndicator: true,
    })
  })

  it('plans static mode without any event that needs positioning', () => {
    const planned = kinds(null, facts({ staticMode: true }))
    for (const kind of ['refresh-saved-position', 'refresh-live-edge', 'restore-directional-window'] as const) {
      expect(planned).not.toContain(kind)
    }
  })

  it('plans the older-load catch-up only when the load finishes', () => {
    const loading = facts({ isLoadingOlder: true })
    expect(kinds(loading, facts({ isLoadingOlder: false, callbacks: loading.callbacks }))).toContain('older-load-finished')
    expect(kinds(facts(), loading)).not.toContain('older-load-finished')
    expect(kinds(null, facts({ isLoadingOlder: false }))).not.toContain('older-load-finished')
  })

  it('re-arms the marker clear only when the marker changes', () => {
    const before = facts({ firstNewMessageId: 'm2' })
    expect(kinds(before, facts({ firstNewMessageId: 'm3', callbacks: before.callbacks }))).toContain('rearm-marker-clear')
    expect(kinds(before, facts({ firstNewMessageId: 'm2', callbacks: before.callbacks }))).not.toContain('rearm-marker-clear')
    expect(kinds(null, before)).not.toContain('rearm-marker-clear')
  })

  it('plans the directional restore when the first row, count or placement version changes', () => {
    const before = facts()
    for (const patch of [{ firstMessageId: 'm-1' }, { interiorPlacementVersion: 1 }, { messageCount: 6 }]) {
      expect(kinds(before, facts({ ...patch, callbacks: before.callbacks }))).toContain('restore-directional-window')
    }
    expect(kinds(before, facts({ isLoadingNewer: true, callbacks: before.callbacks }))).not.toContain('restore-directional-window')
  })

  it('plans work again when a derived callback gets a new identity', () => {
    const before = facts()
    const changed = facts({ callbacks: { ...before.callbacks, createLiveEdgeExecutor: () => {} } })
    expect(kinds(before, changed)).toEqual(
      expect.arrayContaining(['enter-conversation', 'late-synced-read', 'settle-divider', 'refresh-live-edge', 'arrival']),
    )
  })

  it('plans the mount log once, on the first commit', () => {
    expect(kinds(null, facts())).toContain('log-mount')
    const before = facts()
    expect(kinds(before, facts({ messageCount: 6, callbacks: before.callbacks }))).not.toContain('log-mount')
  })
})
