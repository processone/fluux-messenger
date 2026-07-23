import { beforeEach, describe, expect, it } from 'vitest'
import { AT_BOTTOM_THRESHOLD, type ScrollAnchor } from '@/utils/scrollStateManager'
import type { MessageVirtualizer } from './messageVirtualizer'
import { PositioningController, type PositionRequestDraft } from './positioningController'
import {
  deriveAtLiveEdge,
  deriveEntryPositionFacts,
  deriveGlobalLiveEdgeReachability,
  deriveLiveEdgeNavigationFacts,
  deriveTargetReachability,
  readScrollGeometry,
} from './scrollPositionFacts'
import {
  getScrollShadowSnapshot,
  resetScrollShadowDiagnostics,
} from './scrollPositionShadow'
import {
  messageFraction,
  type BottomFractionAnchorPosition,
  type LiveEdgePosition,
} from './scrollPositionModel'
import { recordedPositioningTraces } from './positioningController.traceFixtures'

const conversationId = 'room@example.test'
const liveEdge: LiveEdgePosition = { kind: 'live-edge', follow: true }

function liveEntryFacts() {
  return deriveEntryPositionFacts({
    syncedLiveEdge: false,
    savedAnchor: null,
    savedOffsetPx: null,
  })
}

function liveReachability() {
  return deriveGlobalLiveEdgeReachability({
    hasRows: true,
    windowAtLiveEdge: true,
  })
}

function observeLiveEntry(controller: PositioningController, id = conversationId) {
  return controller.observeEntry({
    event: 'entry',
    conversationId: id,
    entryFacts: liveEntryFacts(),
    reachability: () => liveReachability(),
    actual: { desired: liveEdge, phase: 'positioning' },
  })
}

beforeEach(() => {
  resetScrollShadowDiagnostics()
})

describe('positioning controller shadow mode', () => {
  it('mints strictly increasing generations across controllers and conversation switches', () => {
    const firstController = new PositioningController()
    const first = observeLiveEntry(firstController)
    const switched = observeLiveEntry(firstController, 'next-room@example.test')
    const remountedController = new PositioningController()
    const remounted = observeLiveEntry(remountedController)

    // A per-instance counter reset would make the remounted generation equal the first.
    expect(first?.generation).toBeGreaterThan(0)
    expect(switched!.generation).toBeGreaterThan(first!.generation)
    expect(remounted!.generation).toBeGreaterThan(switched!.generation)
    expect(getScrollShadowSnapshot()).toMatchObject({
      generationCount: 3,
      divergenceCount: 0,
    })
  })

  it('derives live-edge truth from current geometry, not a stale at-bottom latch', () => {
    const geometry = readScrollGeometry({
      scrollTop: 100,
      scrollHeight: 1200,
      clientHeight: 500,
    } as HTMLElement)
    const staleIsAtBottomLatch = true

    // Control: using the stale latch would return true; geometry is 600px from the bottom.
    expect(staleIsAtBottomLatch).toBe(true)
    expect(geometry.distanceFromBottom).toBe(600)
    expect(deriveAtLiveEdge(geometry, AT_BOTTOM_THRESHOLD)).toBe(false)
  })

  it('flags a legacy bottom reassert when neither the request nor live geometry owns it', () => {
    const controller = new PositioningController()
    const actualFollowsStaleLatch = controller.observeBottomReassert({
      event: 'stale-latch',
      conversationId,
      geometryAtLiveEdge: false,
      actualFollowsLive: true,
    })

    // A comparator that copied isAtBottomRef would accept this unsupported write.
    expect(actualFollowsStaleLatch).toBe(false)
    expect(getScrollShadowSnapshot().divergenceCount).toBe(1)

    resetScrollShadowDiagnostics()
    const measuredLiveEdge = controller.observeBottomReassert({
      event: 'measured-live-edge',
      conversationId,
      geometryAtLiveEdge: true,
      actualFollowsLive: true,
    })
    expect(measuredLiveEdge).toBe(true)
    expect(getScrollShadowSnapshot().divergenceCount).toBe(0)
  })

  it('rejects request/fact mismatches instead of converting them to warn-and-stop', () => {
    const controller = new PositioningController()
    const liveDraft: PositionRequestDraft = {
      source: { kind: 'entry', reason: 'live-edge' },
      desired: liveEdge,
    }
    const rejected = controller.observeRequest({
      event: 'bad-live-facts',
      conversationId,
      draft: liveDraft,
      reachability: {
        kind: 'available',
        index: 4,
        mounted: true,
        placement: 'viable',
      },
      actual: { desired: null, phase: 'idle' },
    })

    // A generic resolver would accept this and return unavailable(warn-and-stop).
    expect(rejected).toBeNull()
    expect(controller.snapshot().currentConversationId).toBeNull()
    const anchoredController = new PositioningController()
    const rejectedAnchor = anchoredController.observeRequest({
      event: 'bad-anchor-facts',
      conversationId,
      draft: {
        source: { kind: 'entry', reason: 'saved-position' },
        desired: {
          kind: 'anchor',
          messageId: 'message-20',
          placement: {
            kind: 'bottom-fraction',
            fraction: messageFraction(0.75),
          },
        },
        onUnavailable: { kind: 'live-edge' },
      },
      reachability: liveReachability(),
      actual: { desired: null, phase: 'idle' },
    })
    expect(rejectedAnchor).toBeNull()
    expect(anchoredController.snapshot().currentConversationId).toBeNull()
    expect(getScrollShadowSnapshot()).toMatchObject({
      decisionCount: 2,
      divergenceCount: 0,
    })
  })

  it('preserves synced-live-edge precedence over a saved anchor on real entry facts', () => {
    const trace = recordedPositioningTraces.syncedLiveEdgeEntry
    const persisted: ScrollAnchor = trace.savedAnchor
    const controller = new PositioningController()
    const request = controller.observeEntry({
      event: 'synced-entry',
      conversationId: trace.conversationId,
      entryFacts: deriveEntryPositionFacts({
        syncedLiveEdge: true,
        savedAnchor: persisted,
        savedOffsetPx: trace.savedOffsetPx,
        firstUnreadMessageId: trace.firstUnreadMessageId,
      }),
      reachability: () => liveReachability(),
      actual: { desired: liveEdge, phase: 'positioning' },
    })

    // A saved-first implementation would select message-20 instead.
    expect(request?.source).toEqual({ kind: 'entry', reason: 'synced-live-edge' })
    expect(request?.desired).toEqual(liveEdge)
    expect(getScrollShadowSnapshot().divergenceCount).toBe(0)
  })

  it('allows outgoing send to supersede media preservation', () => {
    const trace = recordedPositioningTraces.mediaThenOutgoing
    const mediaAnchor: BottomFractionAnchorPosition = {
      kind: 'anchor',
      messageId: trace.anchor.messageId,
      placement: {
        kind: 'bottom-fraction',
        fraction: messageFraction(trace.anchor.fraction),
      },
    }
    const controller = new PositioningController()
    observeLiveEntry(controller, trace.conversationId)
    const mediaDraft: PositionRequestDraft = {
      source: { kind: 'media-preservation', reason: 'remeasure' },
      desired: mediaAnchor,
      onUnavailable: { kind: 'warn-and-stop' },
    }
    controller.observeRequest({
      event: 'media-preservation',
      conversationId: trace.conversationId,
      draft: mediaDraft,
      reachability: {
        kind: 'available',
        index: trace.anchor.index,
        mounted: true,
        placement: 'viable',
      },
      actual: { desired: mediaAnchor, phase: 'positioning' },
    })
    const outgoing = controller.observeRequest({
      event: 'outgoing-after-media',
      conversationId: trace.conversationId,
      draft: {
        source: { kind: 'live-update', reason: 'outgoing-message' },
        desired: liveEdge,
      },
      reachability: liveReachability(),
      actual: { desired: liveEdge, phase: 'positioning' },
    })

    // Wrongly treating every preservation source as blocking would return null.
    expect(outgoing?.source).toEqual({
      kind: 'live-update',
      reason: 'outgoing-message',
    })
    expect(getScrollShadowSnapshot().divergenceCount).toBe(0)
  })

  it('releases outgoing suppression after the first saved-position write, before settle', () => {
    const trace = recordedPositioningTraces.savedRestoreThenOutgoing
    const traceAnchor: BottomFractionAnchorPosition = {
      kind: 'anchor',
      messageId: trace.anchor.messageId,
      placement: {
        kind: 'bottom-fraction',
        fraction: messageFraction(trace.anchor.fraction),
      },
    }
    const controller = new PositioningController()
    const saved = controller.observeEntry({
      event: 'saved-entry',
      conversationId: trace.conversationId,
      entryFacts: deriveEntryPositionFacts({
        syncedLiveEdge: false,
        savedAnchor: trace.anchor,
        savedOffsetPx: trace.savedOffsetPx,
      }),
      reachability: () => ({
        kind: 'available',
        index: trace.anchor.index,
        mounted: true,
        placement: 'viable',
      }),
      actual: { desired: traceAnchor, phase: 'positioning' },
    })
    const dropped = controller.observeRequest({
      event: 'outgoing-before-landing',
      conversationId: trace.conversationId,
      draft: {
        source: { kind: 'live-update', reason: 'outgoing-message' },
        desired: liveEdge,
      },
      reachability: liveReachability(),
      actual: { desired: null, phase: 'idle' },
    })
    controller.markPositionApplied(trace.conversationId, saved!.generation)
    const accepted = controller.observeRequest({
      event: 'outgoing-after-landing',
      conversationId: trace.conversationId,
      draft: {
        source: { kind: 'live-update', reason: 'outgoing-message' },
        desired: liveEdge,
      },
      reachability: liveReachability(),
      actual: { desired: liveEdge, phase: 'positioning' },
    })

    // Waiting for settled instead of position-applied would reject both attempts.
    expect(dropped).toBeNull()
    expect(accepted).not.toBeNull()
    expect(getScrollShadowSnapshot().divergenceCount).toBe(0)
  })
})

describe('position fact adapters', () => {
  it('derives mounted state from the current virtual window', () => {
    const virtualizer = {
      itemCount: 100,
      getIndexForMessageId: () => 42,
      getVirtualItems: () => [{ index: 42, start: 1000, size: 64, key: 'message-42' }],
    } as unknown as MessageVirtualizer
    const mounted = deriveTargetReachability({
      messageId: 'message-42',
      hasRows: true,
      virtualizer,
      loadAround: 'available',
    })
    virtualizer.getVirtualItems = () => []
    const unmounted = deriveTargetReachability({
      messageId: 'message-42',
      hasRows: true,
      virtualizer,
      loadAround: 'available',
    })

    // Remembering a previous mount would return the same result for both current windows.
    expect(mounted).toMatchObject({ kind: 'available', mounted: true })
    expect(unmounted).toMatchObject({ kind: 'available', mounted: false })
  })

  it('derives FAB marker-first behavior from its current offset', () => {
    const geometry = readScrollGeometry({
      scrollTop: 500,
      scrollHeight: 3000,
      clientHeight: 600,
    } as HTMLElement)
    const below = deriveLiveEdgeNavigationFacts({
      firstUnreadMessageId: 'message-50',
      markerOffsetPx: 1400,
      geometry,
      virtualized: true,
    })
    const visible = deriveLiveEdgeNavigationFacts({
      firstUnreadMessageId: 'message-50',
      markerOffsetPx: 900,
      geometry,
      virtualized: true,
    })

    expect(below.unreadMarkerNeedsVisit).toBe(true)
    expect(visible.unreadMarkerNeedsVisit).toBe(false)
  })
})
