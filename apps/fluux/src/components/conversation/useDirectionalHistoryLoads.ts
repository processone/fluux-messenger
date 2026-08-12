/**
 * useDirectionalHistoryLoads - starting and settling load-older / load-newer batches
 *
 * Eligibility, cooldown, monotonic load identity and no-shift completion are already decided by the
 * value-only `DirectionalHistoryWindowCoordinator`; visual anchor capture and the pre-paint restore
 * belong to `DirectionalHistoryBrowserAdapter`. This hook is the wiring between them: it starts a
 * load, submits the positioning request that will hold the reading position across the window
 * shift, invokes the caller's loader, and releases the request when a load settles without shifting
 * the window.
 *
 * It owns no eligibility rule and no pixel write of its own.
 */

import { useCallback, useRef } from 'react'
import type {
  DirectionalHistoryBrowserAdapter,
  DirectionalHistoryBrowserCapture,
} from './directionalHistoryBrowserAdapter'
import type {
  DirectionalHistoryReleaseDecision,
  DirectionalHistorySnapshot,
  DirectionalHistoryWindowCoordinator,
} from './directionalHistoryWindowCoordinator'
import { runScrollShadowSafely } from './scrollPositionShadow'
import { pixelOffset } from './scrollPositionModel'
import type { DirectionalHistoryExecutor } from './positioningController'

export interface DirectionalHistoryLoadPorts {
  getBrowser: () => DirectionalHistoryBrowserAdapter
  getCoordinator: () => DirectionalHistoryWindowCoordinator | null
  getActiveConversationId: () => string
  /** Live window as of NOW, for the settlement callback that runs a frame later. */
  getLiveWindow: () => { messageCount: number; firstMessageId: string | undefined }
  hasTravelledAway: (conversationId: string, edge: 'top' | 'bottom') => boolean
  clearTravel: (conversationId: string, edge: 'top' | 'bottom') => void
  buildExecutor: (saved: DirectionalHistorySnapshot) => DirectionalHistoryExecutor
  beginDirectionalHistory: (input: {
    conversationId: string
    desired: {
      kind: 'anchor'
      messageId: string
      placement: { kind: 'top-offset'; offsetPx: ReturnType<typeof pixelOffset> }
    }
    distanceFromBottom: ReturnType<typeof pixelOffset>
    executor: DirectionalHistoryExecutor
  }) => { generation: number } | null | undefined
  cancelWithoutShift: (input: {
    conversationId: string
    generation: number
  }) => void
  log: (action: string, data?: Record<string, unknown>) => void
}

export interface UseDirectionalHistoryLoadsInput {
  ports: DirectionalHistoryLoadPorts
  conversationId: string
  firstMessageId: string | undefined
  messageCount: number
  windowAtLiveEdge: boolean | undefined
  isLoadingOlder: boolean | undefined
  isLoadingNewer: boolean | undefined
  isHistoryComplete: boolean | undefined
  onScrollToTop: (() => unknown) | undefined
  onLoadNewer: (() => unknown) | undefined
}

export interface DirectionalHistoryLoads {
  /** Boundary-triggered older load (scroll to top, wheel at the top). */
  triggerLoadOlder: () => void
  /** Boundary-triggered newer load; the coordinator permits it only in a slid-up window. */
  triggerLoadNewer: () => void
  /** Explicit "load earlier messages" command, which bypasses the travel requirement. */
  handleLoadEarlier: () => void
  /**
   * Apply a coordinator release decision. Stable identity: an effect observing the live-edge
   * transition depends on it.
   */
  applyReleaseDecision: (decision: DirectionalHistoryReleaseDecision) => void
}

export function useDirectionalHistoryLoads({
  ports,
  conversationId,
  firstMessageId,
  messageCount,
  windowAtLiveEdge,
  isLoadingOlder,
  isLoadingNewer,
  isHistoryComplete,
  onScrollToTop,
  onLoadNewer,
}: UseDirectionalHistoryLoadsInput): DirectionalHistoryLoads {
  // Read through a ref so the two stable callbacks below need no dependency on `ports`, which is
  // supplied fresh each render.
  const portsRef = useRef(ports)
  portsRef.current = ports

  const applyReleaseDecision = useCallback(
    (decision: DirectionalHistoryReleaseDecision) => {
      if (decision.kind !== 'cancel') return
      const active = portsRef.current
      active.log('DIRECTIONAL HISTORY RELEASE (without window shift)', {
        requestId: decision.snapshot.requestId,
        oldFirstId: decision.snapshot.oldFirstId,
        oldMessageCount: decision.snapshot.oldMessageCount,
        messageCount: active.getLiveWindow().messageCount,
        generation: decision.generation,
      })
      active.cancelWithoutShift({
        conversationId: decision.snapshot.conversationId,
        generation: decision.generation,
      })
    },
    // Stable on purpose: the live-edge transition effect depends on this identity.
    [],
  )

  const settleAfterFrame = useCallback(
    (browser: DirectionalHistoryBrowserAdapter, requestId: number) => {
      browser.scheduleSettlement(() => {
        const active = portsRef.current
        applyReleaseDecision(
          active.getCoordinator()?.releaseSettledWithoutShift({
            requestId,
            conversationId: active.getActiveConversationId(),
            firstMessageId: active.getLiveWindow().firstMessageId ?? '',
          }) ?? { kind: 'none' },
        )
      })
    },
    [applyReleaseDecision],
  )

  const beginLoad = (
    direction: 'older' | 'newer',
    mode: 'automatic' | 'explicit',
  ): {
    saved: DirectionalHistorySnapshot
    capture: DirectionalHistoryBrowserCapture | null
  } | null => {
    const browser = ports.getBrowser()
    if (!browser.isAvailable()) return null
    let capture: DirectionalHistoryBrowserCapture | null = null
    const edge = direction === 'older' ? 'top' : 'bottom'
    const result = ports.getCoordinator()?.begin({
      conversationId,
      direction,
      mode,
      now: Date.now(),
      loaderAvailable:
        direction === 'older' ? Boolean(onScrollToTop) : Boolean(onLoadNewer),
      loading:
        direction === 'older' ? Boolean(isLoadingOlder) : Boolean(isLoadingNewer),
      historyComplete: Boolean(isHistoryComplete),
      windowAtLiveEdge: windowAtLiveEdge !== false,
      travelledAway: ports.hasTravelledAway(conversationId, edge),
      capture: () => {
        capture = browser.capture(firstMessageId ?? '', messageCount)
        return capture?.facts ?? {
          anchorMessageId: '',
          anchorOffsetFromTop: 0,
          distanceFromBottom: 0,
          firstMessageId: firstMessageId ?? '',
          messageCount,
        }
      },
    })
    if (!result || result.kind === 'blocked') {
      if (result?.reason === 'recently-restored') {
        ports.log('LOAD BLOCKED (recently restored)')
      }
      return null
    }
    if (result.clearTravel) ports.clearTravel(conversationId, edge)

    const saved = result.snapshot
    const request = runScrollShadowSafely({
      event: 'directional-history-capture',
      conversationId,
      fallback: null,
      observe: () => ports.beginDirectionalHistory({
        conversationId,
        desired: {
          kind: 'anchor',
          messageId: saved.anchorMessageId,
          placement: {
            kind: 'top-offset',
            offsetPx: pixelOffset(saved.anchorOffsetFromTop),
          },
        },
        distanceFromBottom: pixelOffset(saved.distanceFromBottom),
        executor: ports.buildExecutor(saved),
      }) ?? null,
    })
    if (request) {
      ports.getCoordinator()?.attachGeneration(saved.requestId, request.generation)
    }
    return { saved, capture }
  }

  const runLoad = (saved: DirectionalHistorySnapshot, run: () => unknown): void => {
    const browser = ports.getBrowser()
    ports.getCoordinator()?.invokeLoad(saved, run, (requestId) =>
      settleAfterFrame(browser, requestId),
    )
  }

  const logStart = (
    label: string,
    saved: DirectionalHistorySnapshot,
    capture: DirectionalHistoryBrowserCapture | null,
  ) => {
    ports.log(label, {
      anchor: capture?.anchor ?? null,
      distanceFromBottom: saved.distanceFromBottom,
      scrollHeight: capture?.geometry.scrollHeight,
      scrollTop: capture?.geometry.scrollTop,
      clientHeight: capture?.geometry.clientHeight,
      firstMessageId,
      messageCount,
    })
  }

  const triggerLoadOlder = () => {
    const started = beginLoad('older', 'automatic')
    if (!started) return
    logStart('PREPEND START', started.saved, started.capture)
    runLoad(started.saved, () => onScrollToTop?.())
  }

  // Loading newer APPENDS a batch and EVICTS the oldest (opposite end), so it shifts every offset
  // up; the same anchor prepend uses holds the viewport steady. The evicted rows are the OLDEST —
  // far above the viewport — so the top-visible anchor survives, making the restore
  // direction-agnostic.
  const triggerLoadNewer = () => {
    const started = beginLoad('newer', 'automatic')
    if (!started) return
    runLoad(started.saved, () => onLoadNewer?.())
  }

  const handleLoadEarlier = () => {
    const started = beginLoad('older', 'explicit')
    if (!started) return
    logStart('LOAD EARLIER', started.saved, started.capture)
    runLoad(started.saved, () => onScrollToTop?.())
  }

  return {
    triggerLoadOlder,
    triggerLoadNewer,
    handleLoadEarlier,
    applyReleaseDecision,
  }
}
