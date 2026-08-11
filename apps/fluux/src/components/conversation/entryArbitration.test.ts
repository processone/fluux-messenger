import { describe, expect, it } from 'vitest'
import {
  arbitrateEntry,
  isSyncedLiveEdgeEntry,
  shouldSupersedeWithLateSyncedLiveEdge,
  type EntryArbitrationInput,
  type LateSyncedLiveEdgeInput,
} from './entryArbitration'

/** A saved position written against an OLDER pointer, with the pointer now at the newest row. */
const syncedEntry = (
  overrides: Partial<EntryArbitrationInput> = {},
): EntryArbitrationInput => ({
  persistedAction: 'restore-position',
  savedReadPositionId: 'm-40',
  firstUnreadMessageId: undefined,
  readPointerId: 'm-99',
  lastMessageId: 'm-99',
  targetMessageId: undefined,
  ...overrides,
})

describe('isSyncedLiveEdgeEntry', () => {
  it('supersedes when the synced pointer names the newest row and the save is older', () => {
    expect(isSyncedLiveEdgeEntry(syncedEntry())).toBe(true)
  })

  it('needs a saved position to supersede in the first place', () => {
    expect(
      isSyncedLiveEdgeEntry(syncedEntry({ persistedAction: 'scroll-to-bottom' })),
    ).toBe(false)
    expect(isSyncedLiveEdgeEntry(syncedEntry({ persistedAction: 'no-action' }))).toBe(
      false,
    )
  })

  it('never overrides a genuine unread divider', () => {
    // The divider is the stronger, more specific signal for where to land.
    expect(
      isSyncedLiveEdgeEntry(syncedEntry({ firstUnreadMessageId: 'm-70' })),
    ).toBe(false)
  })

  it('requires a pointer that actually resolved', () => {
    expect(isSyncedLiveEdgeEntry(syncedEntry({ readPointerId: undefined }))).toBe(false)
    // The explicit `!== undefined` guard is what covers an EMPTY conversation: with no pointer and
    // no newest row, a bare equality check reads `undefined === undefined` as "the pointer is at
    // the tail" and throws away a perfectly good saved position.
    expect(
      isSyncedLiveEdgeEntry(
        syncedEntry({ readPointerId: undefined, lastMessageId: undefined }),
      ),
    ).toBe(false)
  })

  it('requires the pointer to name the NEWEST row, not merely a newer one', () => {
    // Paired with the passing case: the pointer moved forward but not to the tail, so the saved
    // position is still the better answer.
    expect(
      isSyncedLiveEdgeEntry(syncedEntry({ readPointerId: 'm-80', lastMessageId: 'm-99' })),
    ).toBe(false)
  })

  it('does nothing when the save already reflects this read state', () => {
    expect(
      isSyncedLiveEdgeEntry(syncedEntry({ savedReadPositionId: 'm-99' })),
    ).toBe(false)
  })

  it('supersedes when the save was written against no pointer at all', () => {
    expect(
      isSyncedLiveEdgeEntry(syncedEntry({ savedReadPositionId: undefined })),
    ).toBe(true)
  })
})

describe('arbitrateEntry: priority table', () => {
  it('prefers a saved position over an unread divider', () => {
    const plan = arbitrateEntry(
      syncedEntry({
        firstUnreadMessageId: 'm-70',
        readPointerId: 'm-40',
        lastMessageId: 'm-99',
      }),
    )
    expect(plan.branch).toBe('saved-position')
  })

  it('prefers an unread divider over the live edge when nothing was saved', () => {
    const plan = arbitrateEntry(
      syncedEntry({ persistedAction: 'scroll-to-bottom', firstUnreadMessageId: 'm-70' }),
    )
    expect(plan.branch).toBe('unread-marker')
  })

  it('steps aside for an explicit target once no saved position or divider applies', () => {
    const plan = arbitrateEntry(
      syncedEntry({
        persistedAction: 'scroll-to-bottom',
        firstUnreadMessageId: undefined,
        targetMessageId: 'm-12',
      }),
    )
    expect(plan.branch).toBe('defer-to-target')
  })

  it('does NOT let an explicit target displace a saved position or a divider', () => {
    // The target is a separate, newer request that supersedes entry later; it must not reorder
    // the provisional table here.
    expect(
      arbitrateEntry(
        syncedEntry({
          readPointerId: 'm-40',
          lastMessageId: 'm-99',
          targetMessageId: 'm-12',
        }),
      ).branch,
    ).toBe('saved-position')
    expect(
      arbitrateEntry(
        syncedEntry({
          persistedAction: 'scroll-to-bottom',
          firstUnreadMessageId: 'm-70',
          targetMessageId: 'm-12',
        }),
      ).branch,
    ).toBe('unread-marker')
  })

  it('falls back to the live edge with nothing saved, unread, or targeted', () => {
    const plan = arbitrateEntry(
      syncedEntry({ persistedAction: 'scroll-to-bottom', savedReadPositionId: undefined }),
    )
    expect(plan.branch).toBe('live-edge')
  })

  it('treats no-action exactly like scroll-to-bottom', () => {
    expect(
      arbitrateEntry(syncedEntry({ persistedAction: 'no-action' })).branch,
    ).toBe('live-edge')
    expect(
      arbitrateEntry(
        syncedEntry({ persistedAction: 'no-action', firstUnreadMessageId: 'm-70' }),
      ).branch,
    ).toBe('unread-marker')
  })
})

describe('arbitrateEntry: synced live edge invalidating local state', () => {
  it('sends a superseded restore to the live edge and retires the saved position', () => {
    const plan = arbitrateEntry(syncedEntry())
    expect(plan).toMatchObject({
      syncedLiveEdgeSupersedes: true,
      clearSavedPosition: true,
      armPendingSyncedLiveEdge: false,
      branch: 'live-edge',
      entersAtBottom: true,
    })
  })

  it('still steps aside for an explicit target after superseding', () => {
    const plan = arbitrateEntry(syncedEntry({ targetMessageId: 'm-12' }))
    expect(plan.clearSavedPosition).toBe(true)
    expect(plan.branch).toBe('defer-to-target')
    expect(plan.entersAtBottom).toBe(false)
  })

  it('arms the late watch for a restore that was NOT superseded', () => {
    // Paired with the superseding case: the pointer has not reached the tail, so the restore
    // stands and must be watched in case the pointer resolves afterwards.
    const plan = arbitrateEntry(
      syncedEntry({ readPointerId: 'm-40', lastMessageId: 'm-99' }),
    )
    expect(plan).toMatchObject({
      syncedLiveEdgeSupersedes: false,
      clearSavedPosition: false,
      armPendingSyncedLiveEdge: true,
      branch: 'saved-position',
    })
  })

  it('never arms the watch when no position was restored', () => {
    expect(
      arbitrateEntry(syncedEntry({ persistedAction: 'scroll-to-bottom' }))
        .armPendingSyncedLiveEdge,
    ).toBe(false)
  })

  it('enters at the bottom only on the live-edge branch', () => {
    expect(arbitrateEntry(syncedEntry()).entersAtBottom).toBe(true)
    expect(
      arbitrateEntry(syncedEntry({ readPointerId: 'm-40', lastMessageId: 'm-99' }))
        .entersAtBottom,
    ).toBe(false)
    expect(
      arbitrateEntry(
        syncedEntry({ persistedAction: 'scroll-to-bottom', firstUnreadMessageId: 'm-70' }),
      ).entersAtBottom,
    ).toBe(false)
  })
})

describe('shouldSupersedeWithLateSyncedLiveEdge', () => {
  const late = (
    overrides: Partial<LateSyncedLiveEdgeInput> = {},
  ): LateSyncedLiveEdgeInput => ({
    armedForConversation: 'room-a',
    conversationId: 'room-a',
    staticMode: false,
    hasGenuineInput: false,
    firstUnreadMessageId: undefined,
    readPointerId: 'm-99',
    lastMessageId: 'm-99',
    armedSavedReadPositionId: 'm-40',
    ...overrides,
  })

  it('supersedes when the pointer resolves to the tail after the restore landed', () => {
    expect(shouldSupersedeWithLateSyncedLiveEdge(late())).toBe(true)
  })

  it('does nothing unless entry armed the watch for THIS conversation', () => {
    expect(
      shouldSupersedeWithLateSyncedLiveEdge(late({ armedForConversation: undefined })),
    ).toBe(false)
    // A delayed result from the room just left must never reposition the current one.
    expect(
      shouldSupersedeWithLateSyncedLiveEdge(late({ armedForConversation: 'room-b' })),
    ).toBe(false)
  })

  it('yields to the reader once they have taken over', () => {
    expect(
      shouldSupersedeWithLateSyncedLiveEdge(late({ hasGenuineInput: true })),
    ).toBe(false)
  })

  it('never fires in a static preview', () => {
    expect(shouldSupersedeWithLateSyncedLiveEdge(late({ staticMode: true }))).toBe(false)
  })

  it('leaves a divider-bearing conversation to the divider settle path', () => {
    expect(
      shouldSupersedeWithLateSyncedLiveEdge(late({ firstUnreadMessageId: 'm-70' })),
    ).toBe(false)
  })

  it('requires a resolved pointer that reached the tail and moved past the save', () => {
    expect(
      shouldSupersedeWithLateSyncedLiveEdge(late({ readPointerId: undefined })),
    ).toBe(false)
    expect(
      shouldSupersedeWithLateSyncedLiveEdge(late({ readPointerId: 'm-80' })),
    ).toBe(false)
    expect(
      shouldSupersedeWithLateSyncedLiveEdge(late({ armedSavedReadPositionId: 'm-99' })),
    ).toBe(false)
  })
})
