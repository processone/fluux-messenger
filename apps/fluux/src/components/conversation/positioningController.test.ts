import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AT_BOTTOM_THRESHOLD, type ScrollAnchor } from '@/utils/scrollStateManager'
import type { MessageVirtualizer } from './messageVirtualizer'
import {
  PositioningController,
  type ExplicitTargetExecutor,
  type ExplicitTargetFrameResult,
  type PositionExecutionLease,
  type PositionRequestDraft,
  type SavedPositionExecutionLease,
  type SavedPositionExecutor,
  type UnreadMarkerExecutor,
  type UnreadMarkerFrameResult,
} from './positioningController'
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
  runScrollShadowSafely,
} from './scrollPositionShadow'
import {
  messageFraction,
  pixelOffset,
  type BottomFractionAnchorPosition,
  type ReachabilityFacts,
  type LiveEdgePosition,
  type SavedPositionRequest,
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
  it('swallows and counts invalid shadow facts without blocking the live path', () => {
    const valid = runScrollShadowSafely({
      event: 'valid-entry-facts',
      conversationId,
      fallback: null,
      observe: () => liveEntryFacts(),
    })
    expect(valid).not.toBeNull()
    expect(getScrollShadowSnapshot().instrumentationErrorCount).toBe(0)

    const invalid = runScrollShadowSafely({
      event: 'invalid-entry-facts',
      conversationId,
      fallback: null,
      observe: () => deriveEntryPositionFacts({
        syncedLiveEdge: false,
        savedAnchor: {
          messageId: 'zero-height-row',
          fraction: Number.NaN,
        },
        savedOffsetPx: null,
      }),
    })

    // Calling the strict fact adapter directly would throw and abort the entry effect.
    expect(invalid).toBeNull()
    expect(getScrollShadowSnapshot()).toMatchObject({
      instrumentationErrorCount: 1,
      instrumentationErrors: [{
        event: 'invalid-entry-facts',
        conversationId,
      }],
    })
  })

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

    // A saved-first implementation would select the trace's msg-5 anchor instead.
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

  it('rejects stale deactivation generations', () => {
    const controller = new PositioningController()
    const first = observeLiveEntry(controller, 'first-room@example.test')
    const current = observeLiveEntry(controller, conversationId)

    controller.deactivate('first-room@example.test', first!.generation)
    expect(controller.snapshot().currentConversationId).toBe(conversationId)

    controller.deactivate(conversationId, first!.generation)
    expect(controller.snapshot().currentConversationId).toBe(conversationId)

    controller.deactivate(conversationId, current!.generation)
    expect(controller.snapshot().currentConversationId).toBeNull()
  })
})

describe('positioning controller saved-position ownership', () => {
  const savedAnchor: ScrollAnchor = {
    messageId: 'saved-message',
    fraction: 0.5,
  }

  function savedFacts(savedOffsetPx = 900) {
    return deriveEntryPositionFacts({
      syncedLiveEdge: false,
      savedAnchor,
      savedOffsetPx,
    })
  }

  it('loads an off-window anchor exactly once and resumes when that load settles', async () => {
    let anchorAvailable = false
    let resolveLoad!: () => void
    const loadPromise = new Promise<void>((resolve) => {
      resolveLoad = resolve
    })
    const reconcile = vi.fn(() => true)
    const loadAround = vi.fn(() => loadPromise)
    const executor: SavedPositionExecutor = {
      reachability: (desired, loadStatus) =>
        desired.kind === 'anchor' && !anchorAvailable
          ? { kind: 'target-absent', loadAround: loadStatus }
          : {
              kind: 'available',
              index: 4,
              mounted: true,
              placement: 'viable',
            },
      loadAround,
      reconcile,
    }
    const controller = new PositioningController()
    const request = controller.beginSavedPositionEntry({
      conversationId,
      entryFacts: savedFacts(),
      executor,
    })

    expect(request).not.toBeNull()
    expect(loadAround).toHaveBeenCalledTimes(1)
    expect(reconcile).not.toHaveBeenCalled()
    expect(controller.isSavedPositionPending(conversationId)).toBe(true)

    controller.refreshSavedPosition({
      conversationId,
      generation: request!.generation,
      executor,
    })
    expect(loadAround).toHaveBeenCalledTimes(1)

    anchorAvailable = true
    resolveLoad()
    await loadPromise
    await Promise.resolve()

    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(controller.savedPositionStatus(conversationId)?.phase).toEqual({
      kind: 'position-applied',
    })
  })

  it('drops a late around-load completion after switching conversations', async () => {
    let resolveLoad!: () => void
    const loadPromise = new Promise<void>((resolve) => {
      resolveLoad = resolve
    })
    const reconcile = vi.fn(() => true)
    const controller = new PositioningController()
    controller.beginSavedPositionEntry({
      conversationId,
      entryFacts: savedFacts(),
      executor: {
        reachability: (_desired, loadStatus) => ({
          kind: 'target-absent',
          loadAround: loadStatus,
        }),
        loadAround: () => loadPromise,
        reconcile,
      },
    })

    observeLiveEntry(controller, 'next-room@example.test')
    resolveLoad()
    await loadPromise
    await Promise.resolve()

    expect(reconcile).not.toHaveBeenCalled()
    expect(controller.snapshot().currentConversationId).toBe('next-room@example.test')
    expect(controller.savedPositionStatus(conversationId)).toBeNull()
  })

  it('invalidates an older same-generation reconciliation operation', () => {
    const leases: SavedPositionExecutionLease[] = []
    const executor: SavedPositionExecutor = {
      reachability: () => ({
        kind: 'available',
        index: 4,
        mounted: true,
        placement: 'viable',
      }),
      reconcile: (_request, lease) => {
        leases.push(lease)
        return true
      },
    }
    const controller = new PositioningController()
    const request = controller.beginSavedPositionEntry({
      conversationId,
      entryFacts: savedFacts(),
      executor,
    })
    controller.refreshSavedPosition({
      conversationId,
      generation: request!.generation,
      executor,
    })

    expect(leases).toHaveLength(2)
    expect(leases[0].generation).toBe(leases[1].generation)
    expect(leases[0].operation).toBeLessThan(leases[1].operation)
    expect(leases[0].isCurrent()).toBe(false)
    expect(leases[1].isCurrent()).toBe(true)
  })

  it('cancels saved reconciliation immediately on genuine user input', () => {
    let lease: SavedPositionExecutionLease | null = null
    const controller = new PositioningController()
    controller.beginSavedPositionEntry({
      conversationId,
      entryFacts: savedFacts(),
      executor: {
        reachability: () => ({
          kind: 'available',
          index: 4,
          mounted: true,
          placement: 'viable',
        }),
        reconcile: (_request, currentLease) => {
          lease = currentLease
          return true
        },
      },
    })

    controller.observeUserInput(conversationId)

    expect(lease).not.toBeNull()
    expect(lease!.isCurrent()).toBe(false)
    expect(controller.savedPositionStatus(conversationId)).toBeNull()
  })

  it('promotes an unavailable anchor to its legacy offset under a new generation', () => {
    let reconciled: SavedPositionRequest | null = null
    const controller = new PositioningController()
    const initial = controller.beginSavedPositionEntry({
      conversationId,
      entryFacts: savedFacts(700),
      executor: {
        reachability: (desired) =>
          desired.kind === 'anchor'
            ? { kind: 'target-absent', loadAround: 'unavailable' }
            : {
                kind: 'available',
                index: 0,
                mounted: true,
                placement: 'viable',
              },
        reconcile: (request) => {
          reconciled = request
          return true
        },
      },
    })

    expect(reconciled).not.toBeNull()
    expect(reconciled!.generation).toBeGreaterThan(initial!.generation)
    expect(reconciled!.source).toEqual({
      kind: 'fallback',
      reason: 'saved-position-unavailable',
    })
    expect(reconciled!.desired).toEqual({
      kind: 'legacy-offset',
      offsetPx: pixelOffset(700),
    })
  })

  it('uses the request fallback when anchor reconciliation itself cannot land', () => {
    const desiredKinds: string[] = []
    const controller = new PositioningController()
    controller.beginSavedPositionEntry({
      conversationId,
      entryFacts: savedFacts(650),
      executor: {
        reachability: () => ({
          kind: 'available',
          index: 3,
          mounted: true,
          placement: 'viable',
        }),
        reconcile: (request) => {
          desiredKinds.push(request.desired.kind)
          return request.desired.kind === 'legacy-offset'
        },
      },
    })

    // A generic reconcile-failure fallback would skip the usable legacy offset and go live.
    expect(desiredKinds).toEqual(['anchor', 'legacy-offset'])
    expect(controller.savedPositionStatus(conversationId)?.request.desired).toEqual({
      kind: 'legacy-offset',
      offsetPx: pixelOffset(650),
    })
  })

  it('recenters a slid-up window before applying a saved live-edge fallback', () => {
    let atGlobalLiveEdge = false
    const recenter = vi.fn(() => 'requested' as const)
    const reconcile = vi.fn(() => true)
    const executor = (version: string): SavedPositionExecutor => ({
      reachability: (desired) => {
        if (desired.kind === 'anchor') {
          return { kind: 'target-absent', loadAround: 'unavailable' }
        }
        return {
          kind: 'global-live-edge',
          state: atGlobalLiveEdge
            ? { kind: 'resident-tail', index: 9, mounted: true }
            : { kind: 'recenter-available' },
        }
      },
      recenterVersion: version,
      recenterLiveEdge: recenter,
      reconcile,
    })
    const controller = new PositioningController()
    controller.beginSavedPositionEntry({
      conversationId,
      entryFacts: deriveEntryPositionFacts({
        syncedLiveEdge: false,
        savedAnchor,
        savedOffsetPx: null,
      }),
      executor: executor('slid:idle:10'),
    })

    expect(recenter).toHaveBeenCalledTimes(1)
    expect(reconcile).not.toHaveBeenCalled()

    const pending = controller.savedPositionStatus(conversationId)!
    atGlobalLiveEdge = true
    controller.refreshSavedPosition({
      conversationId,
      generation: pending.request.generation,
      executor: executor('live:idle:20'),
    })

    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(controller.savedPositionStatus(conversationId)?.request.desired).toEqual(liveEdge)
  })

  it('aborts pending saved work when the active generation is deactivated', () => {
    let signal: AbortSignal | null = null
    let resolveLoad!: () => void
    const loadPromise = new Promise<void>((resolve) => {
      resolveLoad = resolve
    })
    const reconcile = vi.fn(() => true)
    const controller = new PositioningController()
    controller.beginSavedPositionEntry({
      conversationId,
      entryFacts: savedFacts(),
      executor: {
        reachability: (_desired, loadStatus) => ({
          kind: 'target-absent',
          loadAround: loadStatus,
        }),
        loadAround: (_messageId, currentSignal) => {
          signal = currentSignal
          return loadPromise
        },
        reconcile,
      },
    })
    const generation = controller.snapshot().watermark

    controller.deactivate(conversationId, generation)
    resolveLoad()

    expect(signal).not.toBeNull()
    expect(signal!.aborted).toBe(true)
    expect(controller.savedPositionStatus(conversationId)).toBeNull()
    expect(reconcile).not.toHaveBeenCalled()
  })
})

describe('positioning controller unread-marker ownership', () => {
  function unreadFacts() {
    return deriveEntryPositionFacts({
      syncedLiveEdge: false,
      savedAnchor: null,
      savedOffsetPx: null,
      firstUnreadMessageId: 'first-unread',
      unreadMarkerAlign: 'start',
    })
  }

  function unreadHarness(
    initialReachability: ReturnType<UnreadMarkerExecutor['reachability']> = {
      kind: 'target-absent',
      loadAround: 'unavailable',
    },
  ) {
    const callbacks: Array<() => void> = []
    let frameResult: UnreadMarkerFrameResult = { kind: 'waiting' }
    let scrollTop = 0
    const finish = vi.fn()
    const recordFrame = vi.fn()
    const leases: PositionExecutionLease[] = []
    const positionFrame = vi.fn(() => frameResult)
    const applyLiveEdge = vi.fn(() => true)
    const executor: UnreadMarkerExecutor = {
      reachability: () => initialReachability,
      beginLoop: (lease) => {
        leases.push(lease)
        return {
          schedule: (callback) => callbacks.push(callback),
          recordFrame,
          finish,
        }
      },
      readScrollTop: () => scrollTop,
      positionFrame,
      applyLiveEdge,
    }
    return {
      executor,
      callbacks,
      finish,
      recordFrame,
      leases,
      positionFrame,
      applyLiveEdge,
      setFrameResult: (result: UnreadMarkerFrameResult) => {
        frameResult = result
        if (result.kind === 'positioned') scrollTop = result.scrollTop
      },
      setScrollTop: (value: number) => {
        scrollTop = value
      },
      runFrame: () => {
        const callback = callbacks.shift()
        expect(callback).toBeDefined()
        callback!()
      },
    }
  }

  it('keeps an absent marker pending during local hydration, then converges it', () => {
    const harness = unreadHarness()
    const controller = new PositioningController()
    const request = controller.beginUnreadMarkerEntry({
      conversationId,
      entryFacts: unreadFacts(),
      executor: harness.executor,
    })

    expect(request).not.toBeNull()
    expect(controller.snapshot().active?.phase).toEqual({
      kind: 'pending',
      reason: 'target-not-indexed',
    })
    harness.runFrame()
    expect(harness.positionFrame).toHaveBeenCalledTimes(1)
    expect(harness.callbacks).toHaveLength(1)

    harness.setFrameResult({
      kind: 'positioned',
      scrollTop: 800,
      atLiveEdge: false,
    })
    for (let frame = 0; frame < 9; frame += 1) harness.runFrame()

    expect(controller.snapshot().active?.phase).toEqual({ kind: 'settled' })
    expect(harness.finish).toHaveBeenCalledTimes(1)
    expect(harness.applyLiveEdge).not.toHaveBeenCalled()
  })

  it('promotes a marker that never hydrates to live edge under a new generation', () => {
    const harness = unreadHarness()
    const controller = new PositioningController()
    const request = controller.beginUnreadMarkerEntry({
      conversationId,
      entryFacts: unreadFacts(),
      executor: harness.executor,
    })

    for (let frame = 0; frame <= 120; frame += 1) harness.runFrame()

    expect(harness.positionFrame).toHaveBeenCalledTimes(120)
    expect(harness.applyLiveEdge).toHaveBeenCalledWith(
      'unread-marker-unavailable',
      expect.objectContaining({ conversationId }),
    )
    expect(controller.snapshot().active?.request).toMatchObject({
      generation: expect.any(Number),
      source: {
        kind: 'fallback',
        reason: 'unread-marker-unavailable',
      },
      desired: { kind: 'live-edge', follow: true },
    })
    expect(controller.snapshot().watermark).toBeGreaterThan(request!.generation)
  })

  it('drops a queued marker frame after switching conversations', () => {
    const harness = unreadHarness()
    const controller = new PositioningController()
    controller.beginUnreadMarkerEntry({
      conversationId,
      entryFacts: unreadFacts(),
      executor: harness.executor,
    })
    const staleFrame = harness.callbacks.shift()!

    observeLiveEntry(controller, 'next-room@example.test')
    staleFrame()

    expect(harness.positionFrame).not.toHaveBeenCalled()
    expect(harness.finish).toHaveBeenCalledTimes(1)
    expect(controller.snapshot().currentConversationId).toBe('next-room@example.test')
  })

  it('cancels unread reconciliation immediately on genuine user input', () => {
    const harness = unreadHarness()
    const controller = new PositioningController()
    controller.beginUnreadMarkerEntry({
      conversationId,
      entryFacts: unreadFacts(),
      executor: harness.executor,
    })
    const staleFrame = harness.callbacks.shift()!

    controller.observeUserInput(conversationId)
    staleFrame()

    expect(harness.positionFrame).not.toHaveBeenCalled()
    expect(harness.finish).toHaveBeenCalledTimes(1)
    expect(harness.leases[0].isCurrent()).toBe(false)
  })

  it('treats geometry takeover as cancellation rather than a settled marker', () => {
    const harness = unreadHarness({
      kind: 'available',
      index: 12,
      mounted: true,
      placement: 'viable',
    })
    harness.setFrameResult({
      kind: 'positioned',
      scrollTop: 800,
      atLiveEdge: false,
    })
    const controller = new PositioningController()
    controller.beginUnreadMarkerEntry({
      conversationId,
      entryFacts: unreadFacts(),
      executor: harness.executor,
    })

    harness.runFrame()
    harness.setScrollTop(1200)
    harness.runFrame()

    expect(harness.positionFrame).toHaveBeenCalledTimes(1)
    expect(harness.finish).toHaveBeenCalledTimes(1)
    expect(controller.snapshot().active).toBeNull()
    expect(controller.snapshot().lateMdsEligibleFor).toBeNull()
  })

  it('supersedes entry with pill navigation before the first frame and writes once per frame', () => {
    const entry = unreadHarness()
    const pill = unreadHarness({
      kind: 'available',
      index: 12,
      mounted: false,
      placement: 'viable',
    })
    pill.setFrameResult({
      kind: 'positioned',
      scrollTop: 900,
      atLiveEdge: false,
    })
    const controller = new PositioningController()
    controller.beginUnreadMarkerEntry({
      conversationId,
      entryFacts: unreadFacts(),
      executor: entry.executor,
    })
    const staleEntryFrame = entry.callbacks.shift()!
    controller.beginUnreadMarkerNavigation({
      conversationId,
      navigationFacts: {
        firstUnreadMessageId: 'first-unread',
        unreadMarkerNeedsVisit: true,
        unreadMarkerAlign: 'start',
      },
      executor: pill.executor,
    })

    staleEntryFrame()
    pill.runFrame()

    expect(entry.positionFrame).not.toHaveBeenCalled()
    expect(entry.finish).toHaveBeenCalledTimes(1)
    expect(pill.positionFrame).toHaveBeenCalledTimes(1)
    expect(pill.callbacks).toHaveLength(1)
  })

  it('promotes an executor-declared near-top target without issuing another marker frame', () => {
    const harness = unreadHarness({
      kind: 'available',
      index: 1,
      mounted: true,
      // Preflight geometry is only a hint. The final near-top decision belongs to the owned frame
      // reconciler after row measurement, so this must not synchronously promote the fallback.
      placement: 'use-unavailable-policy',
    })
    harness.setFrameResult({ kind: 'unavailable' })
    const controller = new PositioningController()
    controller.beginUnreadMarkerEntry({
      conversationId,
      entryFacts: unreadFacts(),
      executor: harness.executor,
    })

    expect(harness.callbacks).toHaveLength(1)
    expect(harness.applyLiveEdge).not.toHaveBeenCalled()
    harness.runFrame()

    expect(harness.positionFrame).toHaveBeenCalledTimes(1)
    expect(harness.callbacks).toHaveLength(0)
    expect(harness.applyLiveEdge).toHaveBeenCalledWith(
      'unread-marker-unavailable',
      expect.any(Object),
    )
  })
})

describe('positioning controller explicit-target ownership', () => {
  function targetHarness(options: {
    reachability?: (
      loadStatus: Parameters<ExplicitTargetExecutor['reachability']>[1],
    ) => ReachabilityFacts
    loadAround?: ExplicitTargetExecutor['loadAround']
  } = {}) {
    const callbacks: Array<() => void> = []
    const finish = vi.fn()
    const recordFrame = vi.fn()
    const complete = vi.fn()
    const leases: PositionExecutionLease[] = []
    let frameResult: ExplicitTargetFrameResult = { kind: 'waiting' }
    let scrollTop = 0
    const positionFrame = vi.fn(() => frameResult)
    const beginLoop = vi.fn((lease: PositionExecutionLease) => {
      leases.push(lease)
      return {
        schedule: (callback: () => void) => callbacks.push(callback),
        recordFrame,
        finish,
      }
    })
    const executor: ExplicitTargetExecutor = {
      reachability: (_desired, loadStatus) =>
        options.reachability?.(loadStatus) ?? {
          kind: 'available',
          index: 12,
          mounted: true,
          placement: 'viable',
        },
      loadAround: options.loadAround,
      beginLoop,
      readScrollTop: () => scrollTop,
      positionFrame,
      complete,
    }
    return {
      executor,
      callbacks,
      finish,
      recordFrame,
      complete,
      leases,
      positionFrame,
      beginLoop,
      setFrameResult: (result: ExplicitTargetFrameResult) => {
        frameResult = result
        if (result.kind === 'positioned') scrollTop = result.scrollTop
      },
      setScrollTop: (value: number) => {
        scrollTop = value
      },
      runFrame: () => {
        const callback = callbacks.shift()
        expect(callback).toBeDefined()
        callback!()
      },
    }
  }

  it('loads an absent target once and re-drives it when the load completes', async () => {
    let available = false
    let resolveLoad!: () => void
    const loadPromise = new Promise<void>((resolve) => {
      resolveLoad = resolve
    })
    const loadAround = vi.fn(() => loadPromise)
    const harness = targetHarness({
      reachability: (loadStatus) =>
        available
          ? {
              kind: 'available',
              index: 12,
              mounted: false,
              placement: 'viable',
            }
          : { kind: 'target-absent', loadAround: loadStatus },
      loadAround,
    })
    const controller = new PositioningController()
    observeLiveEntry(controller)
    const request = controller.beginExplicitTarget({
      conversationId,
      messageId: 'target-a',
      executor: harness.executor,
    })
    const refreshed = controller.beginExplicitTarget({
      conversationId,
      messageId: 'target-a',
      executor: harness.executor,
    })

    expect(refreshed?.generation).toBe(request?.generation)
    expect(loadAround).toHaveBeenCalledTimes(1)
    expect(harness.beginLoop).not.toHaveBeenCalled()

    available = true
    resolveLoad()
    await loadPromise
    await Promise.resolve()

    expect(harness.beginLoop).toHaveBeenCalledTimes(1)
    expect(harness.callbacks).toHaveLength(1)
  })

  it('keeps an exhausted wait target pending without repeating its around load', async () => {
    const loadAround = vi.fn().mockResolvedValue(undefined)
    const harness = targetHarness({
      reachability: (loadStatus) => ({
        kind: 'target-absent',
        loadAround: loadStatus,
      }),
      loadAround,
    })
    const controller = new PositioningController()
    observeLiveEntry(controller)
    const request = controller.beginExplicitTarget({
      conversationId,
      messageId: 'missing-target',
      executor: harness.executor,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(controller.snapshot().active).toMatchObject({
      request: { generation: request!.generation },
      phase: { kind: 'pending', reason: 'target-not-indexed' },
    })
    controller.refreshExplicitTarget({
      conversationId,
      generation: request!.generation,
      executor: harness.executor,
    })
    expect(loadAround).toHaveBeenCalledTimes(1)
    expect(harness.complete).not.toHaveBeenCalled()
  })

  it('settles after four stable frames and records every actual write', () => {
    const harness = targetHarness()
    const controller = new PositioningController()
    observeLiveEntry(controller)
    controller.beginExplicitTarget({
      conversationId,
      messageId: 'stable-target',
      executor: harness.executor,
    })

    for (const scrollTop of [100, 115, 116, 117, 118]) {
      harness.setFrameResult({
        kind: 'positioned',
        scrollTop,
        wrote: true,
      })
      harness.runFrame()
    }

    expect(harness.positionFrame).toHaveBeenCalledTimes(5)
    expect(harness.recordFrame).toHaveBeenCalledTimes(5)
    expect(harness.recordFrame).toHaveBeenCalledWith(true)
    expect(harness.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        desired: expect.objectContaining({ messageId: 'stable-target' }),
      }),
      'settled',
      true,
    )
    expect(controller.snapshot().active?.phase).toEqual({ kind: 'settled' })
  })

  it('completes best-effort after exactly thirty non-converging writes', () => {
    const harness = targetHarness()
    const controller = new PositioningController()
    observeLiveEntry(controller)
    controller.beginExplicitTarget({
      conversationId,
      messageId: 'moving-target',
      executor: harness.executor,
    })

    for (let frame = 0; frame < 30; frame += 1) {
      harness.setFrameResult({
        kind: 'positioned',
        scrollTop: frame * 20,
        wrote: true,
      })
      harness.runFrame()
    }
    expect(harness.complete).not.toHaveBeenCalled()
    harness.runFrame()

    expect(harness.positionFrame).toHaveBeenCalledTimes(30)
    expect(harness.recordFrame).toHaveBeenCalledTimes(30)
    expect(harness.complete).toHaveBeenCalledWith(
      expect.any(Object),
      'best-effort',
      true,
    )
  })

  it('reports user takeover and invalidates the queued target frame', () => {
    const harness = targetHarness()
    const controller = new PositioningController()
    observeLiveEntry(controller)
    controller.beginExplicitTarget({
      conversationId,
      messageId: 'cancelled-target',
      executor: harness.executor,
    })
    const staleFrame = harness.callbacks.shift()!

    controller.observeUserInput(conversationId)
    staleFrame()

    expect(harness.positionFrame).not.toHaveBeenCalled()
    expect(harness.finish).toHaveBeenCalledTimes(1)
    expect(harness.leases[0].isCurrent()).toBe(false)
    expect(harness.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        desired: expect.objectContaining({ messageId: 'cancelled-target' }),
      }),
      'user-takeover',
      false,
    )
  })

  it('treats a 301px geometry drift as user takeover', () => {
    const harness = targetHarness()
    harness.setFrameResult({
      kind: 'positioned',
      scrollTop: 100,
      wrote: true,
    })
    const controller = new PositioningController()
    observeLiveEntry(controller)
    controller.beginExplicitTarget({
      conversationId,
      messageId: 'dragged-away-target',
      executor: harness.executor,
    })
    harness.runFrame()
    harness.setScrollTop(401)
    harness.runFrame()

    expect(harness.positionFrame).toHaveBeenCalledTimes(1)
    expect(harness.complete).toHaveBeenCalledWith(
      expect.any(Object),
      'user-takeover',
      true,
    )
    expect(controller.snapshot().active).toBeNull()
  })

  it('silently supersedes target A with B and drops A queued work', () => {
    const targetA = targetHarness()
    const targetB = targetHarness()
    const controller = new PositioningController()
    observeLiveEntry(controller)
    controller.beginExplicitTarget({
      conversationId,
      messageId: 'target-a',
      executor: targetA.executor,
    })
    const staleFrame = targetA.callbacks.shift()!
    const targetBRequest = controller.beginExplicitTarget({
      conversationId,
      messageId: 'target-b',
      executor: targetB.executor,
    })

    staleFrame()

    expect(targetA.finish).toHaveBeenCalledTimes(1)
    expect(targetA.positionFrame).not.toHaveBeenCalled()
    expect(targetA.complete).not.toHaveBeenCalled()
    expect(targetB.callbacks).toHaveLength(1)
    expect(controller.snapshot().active?.request).toBe(targetBRequest)
  })

  it('drops an around-load completion after switching rooms without completing the target', async () => {
    let resolveLoad!: () => void
    const loadPromise = new Promise<void>((resolve) => {
      resolveLoad = resolve
    })
    const harness = targetHarness({
      reachability: (loadStatus) => ({
        kind: 'target-absent',
        loadAround: loadStatus,
      }),
      loadAround: () => loadPromise,
    })
    const controller = new PositioningController()
    observeLiveEntry(controller)
    controller.beginExplicitTarget({
      conversationId,
      messageId: 'old-room-target',
      executor: harness.executor,
    })

    observeLiveEntry(controller, 'next-room@example.test')
    resolveLoad()
    await loadPromise
    await Promise.resolve()

    expect(harness.beginLoop).not.toHaveBeenCalled()
    expect(harness.complete).not.toHaveBeenCalled()
    expect(controller.snapshot().currentConversationId).toBe(
      'next-room@example.test',
    )
  })

  it('lets a target supersede unread entry without completing the marker or target', () => {
    const markerCallbacks: Array<() => void> = []
    const markerFinish = vi.fn()
    const markerExecutor: UnreadMarkerExecutor = {
      reachability: () => ({
        kind: 'available',
        index: 3,
        mounted: true,
        placement: 'viable',
      }),
      beginLoop: () => ({
        schedule: (callback) => markerCallbacks.push(callback),
        recordFrame: vi.fn(),
        finish: markerFinish,
      }),
      readScrollTop: () => 0,
      positionFrame: () => ({ kind: 'waiting' }),
      applyLiveEdge: () => true,
    }
    const target = targetHarness()
    const controller = new PositioningController()
    controller.beginUnreadMarkerEntry({
      conversationId,
      entryFacts: deriveEntryPositionFacts({
        syncedLiveEdge: false,
        savedAnchor: null,
        savedOffsetPx: null,
        firstUnreadMessageId: 'first-unread',
        unreadMarkerAlign: 'start',
      }),
      executor: markerExecutor,
    })
    const staleMarkerFrame = markerCallbacks.shift()!

    controller.beginExplicitTarget({
      conversationId,
      messageId: 'explicit-target',
      executor: target.executor,
    })
    staleMarkerFrame()

    expect(markerFinish).toHaveBeenCalledTimes(1)
    expect(target.complete).not.toHaveBeenCalled()
    expect(target.callbacks).toHaveLength(1)
  })

  it('lets a newer unread entry silently cancel an explicit target', () => {
    const target = targetHarness()
    const markerFinish = vi.fn()
    const markerExecutor: UnreadMarkerExecutor = {
      reachability: () => ({
        kind: 'available',
        index: 3,
        mounted: true,
        placement: 'viable',
      }),
      beginLoop: () => ({
        schedule: vi.fn(),
        recordFrame: vi.fn(),
        finish: markerFinish,
      }),
      readScrollTop: () => 0,
      positionFrame: () => ({ kind: 'waiting' }),
      applyLiveEdge: () => true,
    }
    const controller = new PositioningController()
    observeLiveEntry(controller)
    controller.beginExplicitTarget({
      conversationId,
      messageId: 'superseded-target',
      executor: target.executor,
    })
    const staleTargetFrame = target.callbacks.shift()!

    controller.beginUnreadMarkerEntry({
      conversationId,
      entryFacts: deriveEntryPositionFacts({
        syncedLiveEdge: false,
        savedAnchor: null,
        savedOffsetPx: null,
        firstUnreadMessageId: 'first-unread',
        unreadMarkerAlign: 'start',
      }),
      executor: markerExecutor,
    })
    staleTargetFrame()

    expect(target.finish).toHaveBeenCalledTimes(1)
    expect(target.positionFrame).not.toHaveBeenCalled()
    expect(target.complete).not.toHaveBeenCalled()
    expect(markerFinish).not.toHaveBeenCalled()
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
