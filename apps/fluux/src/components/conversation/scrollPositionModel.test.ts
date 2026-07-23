import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  acceptPositionRequest,
  advancePhaseIfCurrent,
  cancelReconciliationForUserInput,
  deactivateConversation,
  initialPositioningModel,
  isCurrentGeneration,
  messageFraction,
  pixelOffset,
  resolveReachability,
  selectEntryPosition,
  selectLiveEdgeNavigation,
  settleUserPosition,
  shouldReconcileAfterAppend,
  type BottomFractionAnchorPosition,
  type PixelOffset,
  type PositionRequest,
} from './scrollPositionModel'

const conversationId = 'room@example.test'
const otherConversationId = 'other-room@example.test'
const liveEdge = { kind: 'live-edge', follow: true } as const
const savedAnchor: BottomFractionAnchorPosition = {
  kind: 'anchor',
  messageId: 'last-message',
  placement: {
    kind: 'bottom-fraction',
    fraction: messageFraction(1),
  },
}

type SavedEntryRequest = Extract<
  PositionRequest,
  {
    source: { kind: 'entry'; reason: 'saved-position' }
    desired: BottomFractionAnchorPosition
  }
>

function savedRequest(generation: number): SavedEntryRequest {
  return {
    generation,
    conversationId,
    source: { kind: 'entry', reason: 'saved-position' },
    desired: savedAnchor,
    onUnavailable: { kind: 'live-edge' },
  }
}

function liveEntry(generation: number, id = conversationId): PositionRequest {
  return {
    generation,
    conversationId: id,
    source: { kind: 'entry', reason: 'live-edge' },
    desired: liveEdge,
  }
}

function explicitMessage(generation: number): PositionRequest {
  return {
    generation,
    conversationId,
    source: { kind: 'user-navigation', reason: 'message-target' },
    desired: {
      kind: 'message',
      messageId: 'explicit-target',
      align: 'center',
    },
    onUnavailable: { kind: 'wait' },
  }
}

function lateMds(generation: number, id = conversationId): PositionRequest {
  return {
    generation,
    conversationId: id,
    source: {
      kind: 'late-mds-supersession',
      reason: 'read-pointer-at-live-edge',
    },
    desired: liveEdge,
  }
}

function outgoingMessage(generation: number): PositionRequest {
  return {
    generation,
    conversationId,
    source: { kind: 'live-update', reason: 'outgoing-message' },
    desired: liveEdge,
  }
}

describe('scroll position model', () => {
  it('couples provenance to compatible desired-position types', () => {
    type InvalidLateMdsAnchor = {
      generation: number
      conversationId: string
      source: {
        kind: 'late-mds-supersession'
        reason: 'read-pointer-at-live-edge'
      }
      desired: BottomFractionAnchorPosition
    }
    type InvalidOutgoingResidentTop = {
      generation: number
      conversationId: string
      source: { kind: 'live-update'; reason: 'outgoing-message' }
      desired: { kind: 'resident-top' }
    }
    type ValidSavedFallback = {
      generation: number
      conversationId: string
      source: { kind: 'fallback'; reason: 'saved-position-unavailable' }
      desired: { kind: 'legacy-offset'; offsetPx: PixelOffset }
    }

    // These compile-time controls fail if PositionRequest is widened back into independent source
    // and desired fields. The valid control prevents an accidentally impossible fallback contract.
    expectTypeOf<InvalidLateMdsAnchor>().not.toMatchTypeOf<PositionRequest>()
    expectTypeOf<InvalidOutgoingResidentTop>().not.toMatchTypeOf<PositionRequest>()
    expectTypeOf<ValidSavedFallback>().toMatchTypeOf<PositionRequest>()
  })

  it('validates fractional anchor bounds instead of leaving incompatible geometry implicit', () => {
    expect(messageFraction(0)).toBe(0)
    expect(messageFraction(1)).toBe(1)
    expect(() => messageFraction(-0.01)).toThrow(RangeError)
    expect(() => messageFraction(1.01)).toThrow(RangeError)
    expect(() => messageFraction(Number.NaN)).toThrow(RangeError)
    expect(() => messageFraction(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(pixelOffset(-12.5)).toBe(-12.5)
    expect(() => pixelOffset(Number.NEGATIVE_INFINITY)).toThrow(RangeError)
  })

  it('follows appends only for live-edge policy, never for fixed positions at the tail', () => {
    const nonFollowingRequests: PositionRequest[] = [
      {
        generation: 2,
        conversationId,
        source: { kind: 'media-preservation', reason: 'remeasure' },
        desired: savedAnchor,
        onUnavailable: { kind: 'warn-and-stop' },
      },
      {
        generation: 3,
        conversationId,
        source: { kind: 'user-navigation', reason: 'message-target' },
        desired: { kind: 'message', messageId: 'last-message', align: 'center' },
        onUnavailable: { kind: 'wait' },
      },
      {
        generation: 4,
        conversationId,
        source: { kind: 'user-navigation', reason: 'resident-top' },
        desired: { kind: 'resident-top' },
      },
    ]
    nonFollowingRequests.forEach((request) => {
      const live = acceptPositionRequest(initialPositioningModel(), liveEntry(1))
      expect(shouldReconcileAfterAppend(live, conversationId)).toBe(true)
      const model = acceptPositionRequest(live, request)
      expect(shouldReconcileAfterAppend(model, conversationId)).toBe(false)
    })

    const legacyEntry: PositionRequest = {
      generation: 5,
      conversationId,
      source: { kind: 'entry', reason: 'saved-position' },
      desired: { kind: 'legacy-offset', offsetPx: pixelOffset(50) },
    }
    const model = acceptPositionRequest(initialPositioningModel(), legacyEntry)
    expect(shouldReconcileAfterAppend(model, conversationId)).toBe(false)
  })

  it('distinguishes empty, loadable, unavailable, unmounted, and mounted targets', () => {
    const request = savedRequest(1)
    expect(resolveReachability(request, { kind: 'empty-window' })).toEqual({
      kind: 'pending',
      reason: 'empty-window',
    })
    expect(
      resolveReachability(request, { kind: 'target-absent', loadAround: 'available' }),
    ).toEqual({
      kind: 'loading-around',
      messageId: 'last-message',
    })
    expect(
      resolveReachability(request, { kind: 'target-absent', loadAround: 'loading' }),
    ).toEqual({
      kind: 'pending',
      reason: 'around-load',
    })
    expect(
      resolveReachability(request, { kind: 'target-absent', loadAround: 'unavailable' }),
    ).toEqual({
      kind: 'unavailable',
      policy: { kind: 'live-edge' },
    })
    expect(
      resolveReachability(request, {
        kind: 'available',
        index: 42,
        mounted: false,
        placement: 'viable',
      }),
    ).toEqual({
      kind: 'mounting',
      index: 42,
      messageId: 'last-message',
    })
    expect(
      resolveReachability(request, {
        kind: 'available',
        index: 42,
        mounted: true,
        placement: 'viable',
      }),
    ).toEqual({ kind: 'reconciling' })
  })

  it('keeps unavailable behavior request-specific instead of applying one generic fallback', () => {
    const absent = { kind: 'target-absent', loadAround: 'exhausted' } as const
    const savedWithLegacy: PositionRequest = {
      ...savedRequest(1),
      onUnavailable: {
        kind: 'legacy-offset',
        offsetPx: pixelOffset(1234),
        otherwise: 'live-edge',
      },
    }
    const explicit = explicitMessage(2)
    const preservation: PositionRequest = {
      generation: 3,
      conversationId,
      source: { kind: 'media-preservation', reason: 'remeasure' },
      desired: savedAnchor,
      onUnavailable: { kind: 'warn-and-stop' },
    }

    expect(resolveReachability(savedWithLegacy, absent)).toEqual({
      kind: 'unavailable',
      policy: {
        kind: 'legacy-offset',
        offsetPx: pixelOffset(1234),
        otherwise: 'live-edge',
      },
    })
    expect(resolveReachability(explicit, absent)).toEqual({
      kind: 'pending',
      reason: 'target-not-indexed',
    })
    expect(resolveReachability(preservation, absent)).toEqual({
      kind: 'unavailable',
      policy: { kind: 'warn-and-stop' },
    })
  })

  it('preserves directional history with distance-from-bottom while media failure stops', () => {
    const absent = { kind: 'target-absent', loadAround: 'unavailable' } as const
    const directional: PositionRequest = {
      generation: 2,
      conversationId,
      source: { kind: 'history-preservation', reason: 'window-shift' },
      desired: {
        kind: 'anchor',
        messageId: 'top-visible',
        placement: { kind: 'top-offset', offsetPx: pixelOffset(-18) },
      },
      onUnavailable: {
        kind: 'distance-from-bottom',
        distancePx: pixelOffset(640),
      },
    }
    const media: PositionRequest = {
      generation: 3,
      conversationId,
      source: { kind: 'media-preservation', reason: 'remeasure' },
      desired: savedAnchor,
      onUnavailable: { kind: 'warn-and-stop' },
    }

    expect(resolveReachability(directional, absent)).toEqual({
      kind: 'unavailable',
      policy: { kind: 'distance-from-bottom', distancePx: pixelOffset(640) },
    })
    expect(resolveReachability(media, absent)).toEqual({
      kind: 'unavailable',
      policy: { kind: 'warn-and-stop' },
    })
  })

  it('falls back from a mounted unread marker whose start placement would hit resident top', () => {
    const request: PositionRequest = {
      generation: 1,
      conversationId,
      source: { kind: 'entry', reason: 'unread-marker' },
      desired: {
        kind: 'message',
        messageId: 'first-unread',
        align: 'start',
      },
      onUnavailable: { kind: 'live-edge' },
    }

    expect(
      resolveReachability(request, {
        kind: 'available',
        index: 0,
        mounted: true,
        placement: 'use-unavailable-policy',
      }),
    ).toEqual({
      kind: 'unavailable',
      policy: { kind: 'live-edge' },
    })
    expect(
      resolveReachability(request, {
        kind: 'available',
        index: 0,
        mounted: false,
        placement: 'use-unavailable-policy',
      }),
    ).toEqual({
      kind: 'unavailable',
      policy: { kind: 'live-edge' },
    })
    expect(
      resolveReachability(request, {
        kind: 'available',
        index: 10,
        mounted: true,
        placement: 'viable',
      }),
    ).toEqual({ kind: 'reconciling' })
  })

  it('reconciles a raw legacy offset without mounting an unrelated row', () => {
    const legacy: PositionRequest = {
      generation: 1,
      conversationId,
      source: { kind: 'entry', reason: 'saved-position' },
      desired: { kind: 'legacy-offset', offsetPx: pixelOffset(400) },
    }
    expect(
      resolveReachability(legacy, {
        kind: 'available',
        index: 99,
        mounted: false,
        placement: 'viable',
      }),
    ).toEqual({ kind: 'reconciling' })
    expect(
      resolveReachability(liveEntry(1), {
        kind: 'global-live-edge',
        state: { kind: 'resident-tail', index: 99, mounted: false },
      }),
    ).toEqual({ kind: 'mounting', index: 99 })
  })

  it('recenters a slid-up window before mounting and reconciling the global live edge', () => {
    const request = liveEntry(1)
    expect(
      resolveReachability(request, {
        kind: 'global-live-edge',
        state: { kind: 'recenter-available' },
      }),
    ).toEqual({ kind: 'recentering-live-edge' })
    expect(
      resolveReachability(request, {
        kind: 'global-live-edge',
        state: { kind: 'recentering' },
      }),
    ).toEqual({ kind: 'pending', reason: 'live-edge-recenter' })
    expect(
      resolveReachability(request, {
        kind: 'global-live-edge',
        state: { kind: 'resident-tail', index: 99, mounted: false },
      }),
    ).toEqual({ kind: 'mounting', index: 99 })
    expect(
      resolveReachability(request, {
        kind: 'global-live-edge',
        state: { kind: 'resident-tail', index: 99, mounted: true },
      }),
    ).toEqual({ kind: 'reconciling' })
  })

  it('selects synced live edge ahead of saved state and saved state ahead of unread', () => {
    const ordinary = selectEntryPosition({
      syncedLiveEdge: false,
      savedAnchor,
      savedOffsetPx: pixelOffset(1234),
      firstUnreadMessageId: 'first-unread',
    })
    const synced = selectEntryPosition({
      syncedLiveEdge: true,
      savedAnchor,
      savedOffsetPx: pixelOffset(1234),
      firstUnreadMessageId: 'first-unread',
    })

    expect(ordinary).toEqual({
      source: { kind: 'entry', reason: 'saved-position' },
      desired: savedAnchor,
      onUnavailable: {
        kind: 'legacy-offset',
        offsetPx: 1234,
        otherwise: 'live-edge',
      },
    })
    expect(synced).toEqual({
      source: { kind: 'entry', reason: 'synced-live-edge' },
      desired: liveEdge,
    })
  })

  it('preserves raw-only legacy saves instead of silently choosing unread or live edge', () => {
    const withUnread = selectEntryPosition({
      syncedLiveEdge: false,
      savedOffsetPx: pixelOffset(1234),
      firstUnreadMessageId: 'first-unread',
    })
    const withoutUnread = selectEntryPosition({
      syncedLiveEdge: false,
      savedOffsetPx: pixelOffset(1234),
    })

    const expected = {
      source: { kind: 'entry', reason: 'saved-position' },
      desired: { kind: 'legacy-offset', offsetPx: pixelOffset(1234) },
    }
    expect(withUnread).toEqual(expected)
    expect(withoutUnread).toEqual(expected)
  })

  it('uses unread only without saved state, then falls back to live edge', () => {
    const unread = selectEntryPosition({
      syncedLiveEdge: false,
      firstUnreadMessageId: 'first-unread',
    })
    const noUnread = selectEntryPosition({ syncedLiveEdge: false })

    expect(unread).toEqual({
      source: { kind: 'entry', reason: 'unread-marker' },
      desired: {
        kind: 'message',
        messageId: 'first-unread',
        align: 'start',
      },
      onUnavailable: { kind: 'live-edge' },
    })
    expect(noUnread).toEqual({
      source: { kind: 'entry', reason: 'live-edge' },
      desired: liveEdge,
    })
  })

  it('preserves FAB/End marker-first navigation only while the marker still needs a visit', () => {
    const marker = selectLiveEdgeNavigation({
      firstUnreadMessageId: 'first-unread',
      unreadMarkerNeedsVisit: true,
      unreadMarkerAlign: 'top-third',
    })
    const live = selectLiveEdgeNavigation({
      firstUnreadMessageId: 'first-unread',
      unreadMarkerNeedsVisit: false,
      unreadMarkerAlign: 'top-third',
    })

    expect(marker).toEqual({
      source: { kind: 'user-navigation', reason: 'unread-marker' },
      desired: {
        kind: 'message',
        messageId: 'first-unread',
        align: 'top-third',
      },
      onUnavailable: { kind: 'live-edge' },
    })
    expect(live).toEqual({
      source: { kind: 'user-navigation', reason: 'live-edge' },
      desired: liveEdge,
    })
  })

  it('accepts only newer generations and ignores stale phase completion and cancellation', () => {
    const first = acceptPositionRequest(initialPositioningModel(), savedRequest(1))
    const secondRequest = explicitMessage(2)
    const second = acceptPositionRequest(first, secondRequest)

    expect(acceptPositionRequest(second, savedRequest(1))).toBe(second)
    expect(
      advancePhaseIfCurrent(second, conversationId, 1, { kind: 'reconciling' }),
    ).toBe(second)
    expect(cancelReconciliationForUserInput(second, conversationId, 1)).toBe(second)
    expect(
      cancelReconciliationForUserInput(second, otherConversationId, 2),
    ).toBe(second)
    expect(
      advancePhaseIfCurrent(second, conversationId, 2, { kind: 'reconciling' }),
    ).toEqual({
      ...second,
      active: {
        request: secondRequest,
        phase: { kind: 'reconciling' },
      },
    })
  })

  it('lets late MDS supersede only the provisional entry for the current conversation', () => {
    const entry = acceptPositionRequest(initialPositioningModel(), savedRequest(1))
    const mdsRequest = lateMds(2)
    const superseded = acceptPositionRequest(entry, mdsRequest)

    expect(superseded.active).toEqual({
      request: mdsRequest,
      phase: { kind: 'resolving' },
    })
    expect(superseded.lateMdsEligibleFor).toBeNull()
  })

  it('does not let delayed MDS revive a room after entry into another room', () => {
    const roomA = acceptPositionRequest(initialPositioningModel(), liveEntry(1))
    const roomBRequest = liveEntry(2, otherConversationId)
    const roomB = acceptPositionRequest(roomA, roomBRequest)
    const delayedRoomA = acceptPositionRequest(roomB, lateMds(3))
    const staleMedia: PositionRequest = {
      generation: 3,
      conversationId,
      source: { kind: 'media-preservation', reason: 'remeasure' },
      desired: savedAnchor,
      onUnavailable: { kind: 'warn-and-stop' },
    }

    expect(delayedRoomA).toBe(roomB)
    expect(acceptPositionRequest(roomB, staleMedia)).toBe(roomB)
    expect(roomB.currentConversationId).toBe(otherConversationId)
    expect(roomB.active?.request).toEqual(roomBRequest)
    expect(shouldReconcileAfterAppend(roomB, conversationId)).toBe(false)
    expect(shouldReconcileAfterAppend(roomB, otherConversationId)).toBe(true)
  })

  it('independently closes late-MDS eligibility on takeover, navigation, and outgoing send', () => {
    const takeoverEntry = acceptPositionRequest(initialPositioningModel(), liveEntry(1))
    const cancelled = cancelReconciliationForUserInput(
      takeoverEntry,
      conversationId,
      1,
    )
    expect(takeoverEntry.lateMdsEligibleFor).toBe(conversationId)
    expect(acceptPositionRequest(cancelled, lateMds(2))).toBe(cancelled)

    const navigationEntry = acceptPositionRequest(initialPositioningModel(), liveEntry(1))
    const explicit = acceptPositionRequest(navigationEntry, explicitMessage(2))
    expect(navigationEntry.lateMdsEligibleFor).toBe(conversationId)
    expect(acceptPositionRequest(explicit, lateMds(3))).toBe(explicit)

    const outgoingEntry = acceptPositionRequest(initialPositioningModel(), liveEntry(1))
    const outgoing = acceptPositionRequest(outgoingEntry, outgoingMessage(2))
    expect(outgoingEntry.lateMdsEligibleFor).toBe(conversationId)
    expect(outgoing.active?.request).toEqual(outgoingMessage(2))
    expect(acceptPositionRequest(outgoing, lateMds(3))).toBe(outgoing)
  })

  it('drops outgoing pin attempts while restore or directional preservation owns position', () => {
    const restore = acceptPositionRequest(initialPositioningModel(), savedRequest(1))
    const restorePending = advancePhaseIfCurrent(restore, conversationId, 1, {
      kind: 'loading-around',
      messageId: 'last-message',
    })
    expect(acceptPositionRequest(restorePending, outgoingMessage(2))).toBe(
      restorePending,
    )
    const restoreReleased = advancePhaseIfCurrent(restorePending, conversationId, 1, {
      kind: 'position-applied',
    })
    expect(acceptPositionRequest(restoreReleased, outgoingMessage(2)).active?.request).toEqual(
      outgoingMessage(2),
    )

    const live = acceptPositionRequest(initialPositioningModel(), liveEntry(1))
    const historyRequest: PositionRequest = {
      generation: 2,
      conversationId,
      source: { kind: 'history-preservation', reason: 'window-shift' },
      desired: {
        kind: 'anchor',
        messageId: 'top-visible',
        placement: { kind: 'top-offset', offsetPx: pixelOffset(-10) },
      },
      onUnavailable: {
        kind: 'distance-from-bottom',
        distancePx: pixelOffset(500),
      },
    }
    const history = acceptPositionRequest(live, historyRequest)
    const historyPending = advancePhaseIfCurrent(history, conversationId, 2, {
      kind: 'mounting',
      index: 4,
      messageId: 'top-visible',
    })
    expect(acceptPositionRequest(historyPending, outgoingMessage(3))).toBe(
      historyPending,
    )

    const historyReleased = advancePhaseIfCurrent(historyPending, conversationId, 2, {
      kind: 'position-applied',
    })
    expect(acceptPositionRequest(historyReleased, outgoingMessage(3)).active?.request).toEqual(
      outgoingMessage(3),
    )
  })

  it('cancels reconciliation separately from follow-live settled geometry', () => {
    const entry = acceptPositionRequest(initialPositioningModel(), liveEntry(1))
    const cancelled = cancelReconciliationForUserInput(entry, conversationId, 1)

    // Input at the threshold cancels the current write loop but does not yet prove the reader left.
    expect(cancelled.active).toEqual({
      request: liveEntry(1),
      phase: { kind: 'paused-user-input' },
    })
    expect(shouldReconcileAfterAppend(cancelled, conversationId)).toBe(false)

    const stayedAtEdge = settleUserPosition(cancelled, conversationId, true)
    const leftEdge = settleUserPosition(cancelled, conversationId, false)
    const rearmRequest: PositionRequest = {
      generation: 2,
      conversationId,
      source: { kind: 'user-navigation', reason: 'live-edge' },
      desired: liveEdge,
    }
    const returnedToEdge = settleUserPosition(
      leftEdge,
      conversationId,
      true,
      rearmRequest,
    )
    expect(shouldReconcileAfterAppend(stayedAtEdge, conversationId)).toBe(true)
    expect(shouldReconcileAfterAppend(leftEdge, conversationId)).toBe(false)
    expect(shouldReconcileAfterAppend(returnedToEdge, conversationId)).toBe(true)
    expect(returnedToEdge.active).toEqual({
      request: rearmRequest,
      phase: { kind: 'settled' },
    })
    expect(settleUserPosition(cancelled, otherConversationId, false)).toBe(cancelled)
  })

  it('retains the watermark after cancellation and settlement', () => {
    const active = acceptPositionRequest(initialPositioningModel(), liveEntry(7))
    const settled = advancePhaseIfCurrent(active, conversationId, 7, { kind: 'settled' })
    const cancelled = cancelReconciliationForUserInput(settled, conversationId, 7)

    expect(settled.watermark).toBe(7)
    expect(acceptPositionRequest(settled, liveEntry(7))).toBe(settled)
    expect(cancelled.watermark).toBe(7)
    expect(cancelled.active?.phase).toEqual({ kind: 'paused-user-input' })
    expect(
      advancePhaseIfCurrent(cancelled, conversationId, 7, { kind: 'settled' }),
    ).toBe(cancelled)
    expect(isCurrentGeneration(cancelled, conversationId, 7)).toBe(true)
    expect(acceptPositionRequest(settled, liveEntry(8)).watermark).toBe(8)
  })

  it('deactivates an unmounted conversation without letting stale cleanup clear a newer entry', () => {
    const roomA = acceptPositionRequest(initialPositioningModel(), liveEntry(1))
    const inactive = deactivateConversation(roomA, conversationId, 1)
    expect(inactive).toEqual({
      ...roomA,
      currentConversationId: null,
      active: null,
      lateMdsEligibleFor: null,
    })
    expect(acceptPositionRequest(inactive, lateMds(2))).toBe(inactive)

    const roomB = acceptPositionRequest(inactive, liveEntry(2, otherConversationId))
    expect(deactivateConversation(roomB, conversationId, 1)).toBe(roomB)
    expect(deactivateConversation(roomB, otherConversationId, 1)).toBe(roomB)
  })

  it('rejects non-positive, fractional, and non-finite generations', () => {
    const initial = initialPositioningModel()
    expect(acceptPositionRequest(initial, liveEntry(0))).toBe(initial)
    expect(acceptPositionRequest(initial, liveEntry(1.5))).toBe(initial)
    expect(acceptPositionRequest(initial, liveEntry(Number.POSITIVE_INFINITY))).toBe(
      initial,
    )
  })
})
