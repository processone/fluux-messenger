import { describe, expect, it } from 'vitest'
import {
  decideDividerMutation,
  decideInsertionMutation,
  insertionAnchorApplies,
  residentArrayUnchanged,
  shouldCaptureDividerAnchor,
  shouldRecaptureInsertionAnchor,
  type ResidentTrackingState,
} from './ambientAnchorDecisions'

const resident = (
  overrides: Partial<ResidentTrackingState> = {},
): ResidentTrackingState => ({
  conversationId: 'room-a',
  messageCount: 200,
  firstMessageId: 'm-0',
  lastMessageId: 'm-199',
  interiorPlacementVersion: 7,
  ...overrides,
})

describe('shouldCaptureDividerAnchor', () => {
  const base = {
    tracked: { conversationId: 'room-a', dividerId: 'd-1' },
    conversationId: 'room-a',
    dividerId: 'd-1',
    readerScrolledUp: true,
  }

  it('captures while the tracked divider still describes this render', () => {
    expect(shouldCaptureDividerAnchor(base)).toBe(true)
  })

  it('refuses on the commit where the divider moves, so the pre-mutation geometry survives', () => {
    // The whole point: capturing here would overwrite the anchor the restore is about to use.
    expect(shouldCaptureDividerAnchor({ ...base, dividerId: 'd-2' })).toBe(false)
  })

  it('refuses at the live edge, where there is no reading point to hold', () => {
    expect(shouldCaptureDividerAnchor({ ...base, readerScrolledUp: false })).toBe(false)
  })

  it('refuses for a conversation the tracking does not describe', () => {
    expect(shouldCaptureDividerAnchor({ ...base, conversationId: 'room-b' })).toBe(false)
  })
})

describe('decideDividerMutation', () => {
  const base = {
    tracked: { conversationId: 'room-a', dividerId: 'd-1' },
    conversationId: 'room-a',
    dividerId: 'd-2',
    readerScrolledUp: true,
    hasAnchor: true,
  }

  it('preserves when the divider moved under a scrolled-up reader holding an anchor', () => {
    expect(decideDividerMutation(base)).toEqual({ kind: 'preserve' })
  })

  it('reports unchanged when the divider did not move', () => {
    // Paired with the case above: only dividerId differs.
    expect(decideDividerMutation({ ...base, dividerId: 'd-1' })).toEqual({
      kind: 'unchanged',
    })
  })

  it('resets for a new conversation instead of preserving the departed reading point', () => {
    expect(decideDividerMutation({ ...base, conversationId: 'room-b' })).toEqual({
      kind: 'reset',
    })
  })

  it('only retracks at the live edge or with no anchor captured', () => {
    expect(decideDividerMutation({ ...base, readerScrolledUp: false })).toEqual({
      kind: 'retrack',
    })
    expect(decideDividerMutation({ ...base, hasAnchor: false })).toEqual({
      kind: 'retrack',
    })
  })
})

describe('residentArrayUnchanged', () => {
  it('is true only when every tracked end matches', () => {
    expect(residentArrayUnchanged(resident(), resident())).toBe(true)
  })

  it.each([
    ['conversation', { conversationId: 'room-b' }],
    ['count', { messageCount: 201 }],
    ['first id', { firstMessageId: 'm-1' }],
    ['last id', { lastMessageId: 'm-200' }],
    ['interior placement', { interiorPlacementVersion: 8 }],
  ])('detects a change of %s', (_label, change) => {
    expect(residentArrayUnchanged(resident(), resident(change))).toBe(false)
  })
})

describe('shouldRecaptureInsertionAnchor', () => {
  const current = { scrollTop: 500, scrollHeight: 5_000, clientHeight: 600 }

  it('recaptures when nothing has been captured yet', () => {
    expect(shouldRecaptureInsertionAnchor({ captured: null, current })).toBe(true)
  })

  it('skips the per-row scan when no scalar moved', () => {
    expect(
      shouldRecaptureInsertionAnchor({ captured: { ...current }, current }),
    ).toBe(false)
  })

  it.each([
    ['the reader scrolled', { scrollTop: 501 }],
    ['rows re-measured', { scrollHeight: 5_001 }],
    ['the viewport resized', { clientHeight: 601 }],
  ])('recaptures when %s', (_label, change) => {
    // A virtualizer re-measure moves scrollHeight without touching any message id, so keying on
    // ids alone lets the snapshot age out and the restore lands where the reader no longer is.
    expect(
      shouldRecaptureInsertionAnchor({
        captured: { ...current, ...change },
        current,
      }),
    ).toBe(true)
  })
})

describe('insertionAnchorApplies', () => {
  it('keeps no anchor at the live edge', () => {
    // 5000 - 4400 - 600 = 0 from the bottom.
    expect(
      insertionAnchorApplies(
        { scrollTop: 4_400, scrollHeight: 5_000, clientHeight: 600 },
        300,
      ),
    ).toBe(false)
  })

  it('keeps an anchor once the reader is clear of the threshold', () => {
    expect(
      insertionAnchorApplies(
        { scrollTop: 4_100, scrollHeight: 5_000, clientHeight: 600 },
        300,
      ),
    ).toBe(true)
  })

  it('treats exactly the threshold as away from the edge', () => {
    expect(
      insertionAnchorApplies(
        { scrollTop: 4_100, scrollHeight: 5_000, clientHeight: 600 },
        300,
      ),
    ).toBe(true)
    expect(
      insertionAnchorApplies(
        { scrollTop: 4_101, scrollHeight: 5_000, clientHeight: 600 },
        300,
      ),
    ).toBe(false)
  })
})

describe('decideInsertionMutation', () => {
  const call = (
    next: Partial<ResidentTrackingState>,
    extra: { directionalLoadLanding?: boolean; hasAnchor?: boolean } = {},
  ) =>
    decideInsertionMutation({
      tracked: resident(),
      next: resident(next),
      directionalLoadLanding: extra.directionalLoadLanding ?? false,
      hasAnchor: extra.hasAnchor ?? true,
    })

  it('preserves a mid-array insertion that grew the array without moving the bottom', () => {
    expect(call({ messageCount: 201 })).toEqual({ kind: 'preserve' })
  })

  it('preserves an insertion at the resident bound, where only the first id moves', () => {
    // `appendLive` evicts the oldest row as it inserts, so the count is identical.
    expect(call({ firstMessageId: 'm-1' })).toEqual({ kind: 'preserve' })
  })

  it('ignores a live-edge arrival, which moves the last row', () => {
    // Paired with the first case: same count change, but the bottom moved too.
    expect(call({ messageCount: 201, lastMessageId: 'm-200' })).toEqual({
      kind: 'retrack',
    })
  })

  it('yields to a directional load landing in this commit', () => {
    // Same array change as the preserved case; only the in-flight snapshot differs. A first-id
    // change alone cannot distinguish these two, which is why the load flag is consulted.
    expect(call({ firstMessageId: 'older-0', messageCount: 250 })).toEqual({
      kind: 'preserve',
    })
    expect(
      call(
        { firstMessageId: 'older-0', messageCount: 250 },
        { directionalLoadLanding: true },
      ),
    ).toEqual({ kind: 'retrack' })
  })

  it('treats an interior placement bump as authoritative even when the bottom moved', () => {
    expect(
      call({ interiorPlacementVersion: 8, lastMessageId: 'm-200' }),
    ).toEqual({ kind: 'preserve' })
  })

  it('ignores a stale interior placement version that went backwards', () => {
    expect(call({ interiorPlacementVersion: 6 })).toEqual({ kind: 'retrack' })
  })

  it('only retracks when nothing about the resident array moved', () => {
    expect(call({})).toEqual({ kind: 'retrack' })
  })

  it('only retracks when no pre-mutation anchor was captured', () => {
    expect(call({ messageCount: 201 }, { hasAnchor: false })).toEqual({
      kind: 'retrack',
    })
  })

  it('resets for a new conversation before any insertion test runs', () => {
    expect(call({ conversationId: 'room-b', messageCount: 201 })).toEqual({
      kind: 'reset',
    })
  })
})
