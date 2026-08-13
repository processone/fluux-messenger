/**
 * useScrollExecutors - construction of every leased positioning executor
 *
 * Each positioning slice reconciles behind its own browser adapter. This hook owns the wiring
 * between those adapters and the controller: it builds each executor, holds the adapters that must
 * outlive a single execution, and keeps the frame-loop factory the adapters lease.
 *
 * It deliberately owns no positioning decision, no effect, and no lifecycle. `useMessageListScroll`
 * decides WHEN a request is submitted; this hook only decides HOW its executor is assembled.
 *
 * ## Why the callback identities still churn
 *
 * The factories below are `useCallback`s whose dependency arrays intentionally track render-scoped
 * window facts. That churn is load-bearing, not an oversight: several effects in the scroll hook
 * list a factory as their dependency precisely so they re-run when the live window moves — the
 * `refresh` live-edge effect exists for exactly that reason. Freezing these identities (for example
 * by holding one factory object in a ref) silently stops those effects from re-firing.
 *
 * Values that appear in a dependency array are therefore passed as explicit arguments. Everything
 * else — pure ref readers with stable identity — travels in `ports`, which is read through a ref so
 * it never widens a dependency array.
 */

import { useCallback, useRef, type RefObject } from 'react'
import type { MessageVirtualizer } from './messageVirtualizer'
import type { PinLoopClaim } from './pinLoopClaim'
import {
  createControllerFrameLoop,
  type ControllerFrameLoopLifecycle,
  type ControllerFrameLoopRegistration,
} from './controllerFrameLoop'
import {
  createReassertLoopMonitor,
  reassertLoopSignal,
  type ReassertLoopLabel,
} from './reassertLoopMonitor'
import { BottomFractionAnchorBrowserAdapter } from './bottomFractionAnchorBrowserAdapter'
import { DirectionalHistoryBrowserAdapter } from './directionalHistoryBrowserAdapter'
import { SavedPositionBrowserAdapter } from './savedPositionBrowserAdapter'
import { UnreadMarkerBrowserAdapter } from './unreadMarkerBrowserAdapter'
import { ExplicitTargetBrowserAdapter } from './explicitTargetBrowserAdapter'
import { LiveEdgeBrowserAdapter } from './liveEdgeBrowserAdapter'
import {
  AnchorPreservationBrowserAdapter,
  type AnchorPreservationLoopLabel,
} from './anchorPreservationBrowserAdapter'
import { ResidentTopBrowserAdapter } from './residentTopBrowserAdapter'
import {
  DIRECTIONAL_HISTORY_COOLDOWN_MS,
  type DirectionalHistorySnapshot,
  type DirectionalHistoryWindowCoordinator,
} from './directionalHistoryWindowCoordinator'
import type {
  AnchorPreservationExecutor,
  DirectionalHistoryExecutor,
  ExplicitTargetExecutor,
  LiveEdgeExecutor,
  PositionExecutionLease,
  ResidentTopExecutor,
  SavedPositionExecutor,
  UnreadMarkerExecutor,
} from './positioningController'
import { signalAnomaly } from '@/utils/anomalySignal'
import { AT_BOTTOM_THRESHOLD } from '@/utils/scrollStateManager'

/** Live-window facts as the executors describe them, read fresh on every call. */
export interface ScrollExecutorLiveWindow {
  messageCount: number
  firstMessageId: string | undefined
  windowAtLiveEdge: boolean | undefined
}

/**
 * Stable ref readers and side-effect sinks. None of these may appear in a dependency array, so the
 * hook reads them through a ref; supplying a fresh object literal each render is expected.
 */
export interface ScrollExecutorPorts {
  getScroller: () => HTMLDivElement | null
  getVirtualizer: () => MessageVirtualizer | undefined
  getActiveConversationId: () => string
  /**
   * The live window as of NOW, not as of the render that built an executor. A live-edge executor
   * outlives that render: the unread-marker fallback carries one from entry and promotes it from
   * inside a rAF frame, long after the cached slice landed. Describing the entry window there
   * reports `empty-window` for a window that has since filled, parking the promoted execution in
   * `pending` with no frame loop.
   */
  getLiveWindow: () => ScrollExecutorLiveWindow
  /**
   * Latest-value conversation handoff. Entry positioning must wait for it so the virtualizer from
   * the conversation being left cannot receive the first write.
   */
  getPassiveContext: () => {
    conversationId: string
    virtualizer: MessageVirtualizer | undefined
  }
  isLoadingOlder: () => boolean | undefined
  getLoadAround: () =>
    | ((anchorMessageId: string) => Promise<unknown> | void)
    | undefined
  getStoreTargetMessageId: () => string | null | undefined
  consumeStoreTarget: () => void
  recordProgrammaticWrite: (conversationId: string, at: number) => void
  getDirectionalWindow: () => DirectionalHistoryWindowCoordinator | null
  /** Adopt the current message count as the directional-load baseline after a landed restore. */
  syncPrevMessageCount: () => void
  pinBottomClaim: () => PinLoopClaim
  /** Shared with the scroll handler, which reads it to tell programmatic scroll from genuine input. */
  reassertLoopRegistry: RefObject<ControllerFrameLoopRegistration | null>
  log: (action: string, data?: Record<string, unknown>) => void
}

export interface UseScrollExecutorsInput {
  ports: ScrollExecutorPorts
  // Everything below participates in a dependency array. See the note at the top of this file.
  conversationId: string
  messageCount: number
  firstMessageId: string | undefined
  lastMessageId: string | undefined
  windowAtLiveEdge: boolean | undefined
  isLoadingNewer: boolean | undefined
  onLoadNewer: (() => unknown) | undefined
  isAtBottomRef: RefObject<boolean>
  setMeasuredAtBottom: (atEdge: boolean) => void
  rememberBottomIntent: () => void
  rememberCurrentScrollSnapshot: () => void
}

export interface ScrollExecutors {
  createLiveEdgeExecutor: (
    trigger: string,
    smoothNonVirtualized?: boolean,
  ) => LiveEdgeExecutor
  createAnchorPreservationExecutor: (
    loopLabel: AnchorPreservationLoopLabel,
  ) => AnchorPreservationExecutor
  buildDirectionalHistoryExecutor: (
    saved: DirectionalHistorySnapshot,
  ) => DirectionalHistoryExecutor
  buildSavedPositionExecutor: () => SavedPositionExecutor
  buildUnreadMarkerExecutor: () => UnreadMarkerExecutor
  buildExplicitTargetExecutor: (
    messageReference: string,
    consumeStoreTarget: boolean,
  ) => ExplicitTargetExecutor
  createResidentTopExecutor: () => ResidentTopExecutor
  getDirectionalHistoryBrowser: () => DirectionalHistoryBrowserAdapter
  /** Conversation entry: drop repaint debt owed by the room being left. */
  resetLiveEdgeRepaintDebt: () => void
  /** Unmount: release the directional adapter's scheduler without racing a rebuild. */
  disposeDirectionalHistoryBrowser: () => void
}

const distanceFromBottom = (el: HTMLElement) =>
  el.scrollHeight - el.scrollTop - el.clientHeight

export function useScrollExecutors({
  ports,
  conversationId,
  messageCount,
  firstMessageId,
  lastMessageId,
  windowAtLiveEdge,
  isLoadingNewer,
  onLoadNewer,
  isAtBottomRef,
  setMeasuredAtBottom,
  rememberBottomIntent,
  rememberCurrentScrollSnapshot,
}: UseScrollExecutorsInput): ScrollExecutors {
  // Plain value assignment in the render body, matching the scroll hook's other latest-value refs.
  // Reading ports through this ref is what keeps them out of every dependency array below.
  const portsRef = useRef(ports)
  portsRef.current = ports

  const reassertMonitorRef = useRef<ReturnType<typeof createReassertLoopMonitor> | null>(null)
  const supersedeReassertLoopRef = useRef(() => {
    portsRef.current.reassertLoopRegistry.current?.finish()
  })

  // Adapters that must outlive a single executor. The live-edge adapter is the load-bearing case:
  // its repaint-burst coalescer spans a run of arrivals that each supersede the last, so
  // per-executor state could never coalesce.
  const bottomFractionAnchorBrowserRef =
    useRef<BottomFractionAnchorBrowserAdapter | null>(null)
  const directionalHistoryBrowserRef =
    useRef<DirectionalHistoryBrowserAdapter | null>(null)
  const liveEdgeBrowserRef = useRef<LiveEdgeBrowserAdapter | null>(null)

  const beginControllerFrameLoop = useCallback((
    label: ReassertLoopLabel,
    lease: PositionExecutionLease,
    lifecycle?: ControllerFrameLoopLifecycle,
  ) => {
    if (!lease.isCurrent()) return null
    return createControllerFrameLoop({
      lease,
      supersede: supersedeReassertLoopRef.current,
      beginHandle: () => (reassertMonitorRef.current ??=
        createReassertLoopMonitor()).begin(label, performance.now()),
      registry: portsRef.current.reassertLoopRegistry,
      // Native WebKit/Chromium scheduler methods require Window as their receiver. Keep them behind
      // closures when passing into the extracted adapter; an unbound method throws before the first
      // convergence frame and strands the requested position.
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (id) => cancelAnimationFrame(id),
      now: () => performance.now(),
      // The adapter forwards whatever the monitor produced; deciding what to do with it
      // belongs here. Fan-out, not re-pointing: the prose is untouched.
      warn: (warning) => {
        console.warn(warning.message)
        if (__FLUUX_ANOMALY__) signalAnomaly(reassertLoopSignal(warning))
      },
      lifecycle,
    })
  }, [])

  const getBottomFractionAnchorBrowser = useCallback(() => {
    if (bottomFractionAnchorBrowserRef.current === null) {
      bottomFractionAnchorBrowserRef.current =
        new BottomFractionAnchorBrowserAdapter({
          getScroller: () => portsRef.current.getScroller(),
          getVirtualizer: () => portsRef.current.getVirtualizer(),
        })
    }
    return bottomFractionAnchorBrowserRef.current
  }, [])

  const getDirectionalHistoryBrowser = useCallback(() => {
    if (directionalHistoryBrowserRef.current === null) {
      directionalHistoryBrowserRef.current =
        new DirectionalHistoryBrowserAdapter({
          getScroller: () => portsRef.current.getScroller(),
          getVirtualizer: () => portsRef.current.getVirtualizer(),
          getActiveConversationId: () =>
            portsRef.current.getActiveConversationId(),
          beginLoop: (lease) => beginControllerFrameLoop('prepend', lease),
          requestFrame: (callback) => requestAnimationFrame(callback),
          cancelFrame: (id) => cancelAnimationFrame(id),
          log: (action, data) => portsRef.current.log(action, data),
        })
    }
    return directionalHistoryBrowserRef.current
  }, [beginControllerFrameLoop])

  const getLiveEdgeBrowser = useCallback(() => {
    if (liveEdgeBrowserRef.current === null) {
      liveEdgeBrowserRef.current = new LiveEdgeBrowserAdapter({
        getScroller: () => portsRef.current.getScroller(),
        getVirtualizer: () => portsRef.current.getVirtualizer(),
        getActiveConversationId: () =>
          portsRef.current.getActiveConversationId(),
        getWindowFacts: () => {
          const live = portsRef.current.getLiveWindow()
          return {
            hasRows: live.messageCount > 0 && live.firstMessageId !== undefined,
            windowAtLiveEdge: live.windowAtLiveEdge !== false,
          }
        },
        isLoadingOlder: () => portsRef.current.isLoadingOlder(),
        beginLoop: (lease) => {
          const claim = portsRef.current.pinBottomClaim()
          return beginControllerFrameLoop('pin-bottom', lease, {
            onStart: claim.renew,
            onFrame: claim.renew,
            onFinish: claim.release,
          })
        },
        setMeasuredAtBottom,
        recordProgrammaticWrite: (id) =>
          portsRef.current.recordProgrammaticWrite(id, Date.now()),
        log: (action, data) => portsRef.current.log(action, data),
      })
    }
    return liveEdgeBrowserRef.current
  }, [beginControllerFrameLoop, setMeasuredAtBottom])

  const createLiveEdgeExecutor = useCallback((
    trigger: string,
    smoothNonVirtualized = false,
  ): LiveEdgeExecutor => getLiveEdgeBrowser().createExecutor({
    trigger,
    smoothNonVirtualized,
    rememberBottomIntent,
    canRecenter: Boolean(onLoadNewer),
    recenterVersion: [
      windowAtLiveEdge === false ? 'slid' : 'live',
      isLoadingNewer ? 'loading' : 'idle',
      messageCount,
      lastMessageId ?? '',
    ].join(':'),
    recenter: onLoadNewer
      ? (signal) => {
          if (signal.aborted) return 'unavailable'
          if (isLoadingNewer) return 'waiting'
          onLoadNewer()
          return 'requested'
        }
      : undefined,
  }), [
    getLiveEdgeBrowser,
    isLoadingNewer,
    lastMessageId,
    messageCount,
    onLoadNewer,
    rememberBottomIntent,
    windowAtLiveEdge,
  ])

  const createAnchorPreservationExecutor = useCallback(
    (loopLabel: AnchorPreservationLoopLabel): AnchorPreservationExecutor =>
      new AnchorPreservationBrowserAdapter({
        getScroller: () => portsRef.current.getScroller(),
        getVirtualizer: () => portsRef.current.getVirtualizer(),
        getActiveConversationId: () =>
          portsRef.current.getActiveConversationId(),
        getWindowFacts: () => ({
          hasRows: messageCount > 0 && firstMessageId !== undefined,
          windowAtLiveEdge: windowAtLiveEdge !== false,
        }),
        beginLoop: (label, lease) => beginControllerFrameLoop(label, lease),
        anchorAdapter: getBottomFractionAnchorBrowser(),
        setAtBottom: (atBottom) => { isAtBottomRef.current = atBottom },
        rememberScrollSnapshot: rememberCurrentScrollSnapshot,
        recordProgrammaticWrite: (id) =>
          portsRef.current.recordProgrammaticWrite(id, Date.now()),
        log: (action, data) => portsRef.current.log(action, data),
      }).createExecutor(loopLabel),
    [
      beginControllerFrameLoop,
      firstMessageId,
      getBottomFractionAnchorBrowser,
      isAtBottomRef,
      messageCount,
      rememberCurrentScrollSnapshot,
      windowAtLiveEdge,
    ],
  )

  const createDirectionalHistoryCompletion = useCallback(
    (saved: DirectionalHistorySnapshot): DirectionalHistoryExecutor['complete'] =>
      (request, outcome) => {
        const active = portsRef.current
        if (active.getActiveConversationId() !== request.conversationId) return
        if (outcome === 'applied') {
          const restored = active.getDirectionalWindow()?.markRestored(
            saved.requestId,
            Date.now(),
          )
          const restoredAt = restored?.restoredAt
          if (restoredAt === undefined) return
          active.syncPrevMessageCount()
          active.recordProgrammaticWrite(request.conversationId, restoredAt)
          setTimeout(() => {
            portsRef.current.getDirectionalWindow()?.expireRestored(
              saved.requestId,
              restoredAt,
            )
          }, DIRECTIONAL_HISTORY_COOLDOWN_MS)
        } else {
          active.getDirectionalWindow()?.finishPosition(saved.requestId)
        }
        if (outcome !== 'applied') {
          active.recordProgrammaticWrite(request.conversationId, Date.now())
        }
        active.log('DIRECTIONAL HISTORY COMPLETE', {
          generation: request.generation,
          outcome,
          restored: Boolean(saved.restored),
        })
      },
    [],
  )

  const buildDirectionalHistoryExecutor = useCallback(
    (saved: DirectionalHistorySnapshot): DirectionalHistoryExecutor =>
      getDirectionalHistoryBrowser().createExecutor(
        createDirectionalHistoryCompletion(saved),
      ),
    [createDirectionalHistoryCompletion, getDirectionalHistoryBrowser],
  )

  const buildSavedPositionExecutor = useCallback((): SavedPositionExecutor => {
    const browser = new SavedPositionBrowserAdapter({
      getScroller: () => portsRef.current.getScroller(),
      getVirtualizer: () => portsRef.current.getVirtualizer(),
      getWindowFacts: () => ({
        hasRows: messageCount > 0 && firstMessageId !== undefined,
        windowAtLiveEdge: windowAtLiveEdge !== false,
        canRecenter: Boolean(onLoadNewer),
      }),
      beginLoop: (lease) => beginControllerFrameLoop('restore-anchor', lease),
      anchorAdapter: getBottomFractionAnchorBrowser(),
    })
    return browser.createExecutor({
      liveEdge: createLiveEdgeExecutor('restore-fallback'),
      loadAround: portsRef.current.getLoadAround()
        ? (messageId, signal) => {
            if (signal.aborted) return
            isAtBottomRef.current = false
            portsRef.current.log(
              'RESTORE: anchor not loaded, requesting cache slice around it',
              { messageId, conversationId },
            )
            return portsRef.current.getLoadAround()?.(messageId)
          }
        : undefined,
      recenterVersion: [
        windowAtLiveEdge === false ? 'slid' : 'live',
        isLoadingNewer ? 'loading' : 'idle',
        messageCount,
        lastMessageId ?? '',
      ].join(':'),
      recenterLiveEdge: onLoadNewer
        ? (signal) => {
            if (signal.aborted) return 'unavailable'
            if (isLoadingNewer) return 'waiting'
            onLoadNewer()
            return 'requested'
          }
        : undefined,
      complete: (request, outcome) => {
        const scroller = portsRef.current.getScroller()
        if (!scroller) return
        setMeasuredAtBottom(distanceFromBottom(scroller) < AT_BOTTOM_THRESHOLD)
        rememberCurrentScrollSnapshot()
        portsRef.current.recordProgrammaticWrite(
          request.conversationId,
          Date.now(),
        )
        portsRef.current.log('RESTORE: controller completed position', {
          conversationId,
          generation: request.generation,
          desired: request.desired,
          outcome,
        })
      },
    })
  }, [
    beginControllerFrameLoop,
    conversationId,
    createLiveEdgeExecutor,
    firstMessageId,
    getBottomFractionAnchorBrowser,
    isAtBottomRef,
    isLoadingNewer,
    lastMessageId,
    messageCount,
    onLoadNewer,
    rememberCurrentScrollSnapshot,
    setMeasuredAtBottom,
    windowAtLiveEdge,
  ])

  const buildUnreadMarkerExecutor = useCallback((): UnreadMarkerExecutor => {
    const browser = new UnreadMarkerBrowserAdapter({
      getScroller: () => portsRef.current.getScroller(),
      getVirtualizer: () => portsRef.current.getVirtualizer(),
      getWindowFacts: () => {
        const live = portsRef.current.getLiveWindow()
        return {
          hasRows: live.messageCount > 0 && live.firstMessageId !== undefined,
          windowAtLiveEdge: live.windowAtLiveEdge !== false,
        }
      },
      getPassiveContext: () => portsRef.current.getPassiveContext(),
      beginLoop: (lease) => beginControllerFrameLoop('marker', lease),
      setMeasuredAtBottom,
      recordProgrammaticWrite: (id) =>
        portsRef.current.recordProgrammaticWrite(id, Date.now()),
      log: (action, data) => portsRef.current.log(action, data),
    })
    return browser.createExecutor(createLiveEdgeExecutor('marker-fallback'))
  }, [
    beginControllerFrameLoop,
    createLiveEdgeExecutor,
    setMeasuredAtBottom,
  ])

  const buildExplicitTargetExecutor = useCallback((
    messageReference: string,
    consumeStoreTarget: boolean,
  ): ExplicitTargetExecutor => {
    const browser = new ExplicitTargetBrowserAdapter({
      getScroller: () => portsRef.current.getScroller(),
      getVirtualizer: () => portsRef.current.getVirtualizer(),
      getWindowFacts: () => {
        const live = portsRef.current.getLiveWindow()
        return {
          hasRows: live.messageCount > 0 && live.firstMessageId !== undefined,
          windowAtLiveEdge: live.windowAtLiveEdge !== false,
        }
      },
      getPassiveContext: () => portsRef.current.getPassiveContext(),
      getActiveConversationId: () =>
        portsRef.current.getActiveConversationId(),
      getStoreTargetMessageId: () =>
        portsRef.current.getStoreTargetMessageId(),
      beginLoop: (lease) => beginControllerFrameLoop('target', lease),
      setMeasuredAtBottom,
      markNotAtBottom: () => { isAtBottomRef.current = false },
      consumeStoreTarget: () => portsRef.current.consumeStoreTarget(),
      recordProgrammaticWrite: (id) =>
        portsRef.current.recordProgrammaticWrite(id, Date.now()),
      log: (action, data) => portsRef.current.log(action, data),
    })
    return browser.createExecutor({
      conversationId,
      messageReference,
      consumeStoreTarget,
      loadAround: portsRef.current.getLoadAround(),
    })
  }, [
    beginControllerFrameLoop,
    conversationId,
    isAtBottomRef,
    setMeasuredAtBottom,
  ])

  const createResidentTopExecutor = useCallback((): ResidentTopExecutor =>
    new ResidentTopBrowserAdapter({
      getScroller: () => portsRef.current.getScroller(),
      getVirtualizer: () => portsRef.current.getVirtualizer(),
      getWindowFacts: () => ({
        hasRows: messageCount > 0 && firstMessageId !== undefined,
        windowAtLiveEdge: windowAtLiveEdge !== false,
      }),
      beginLoop: (lease) => beginControllerFrameLoop('resident-top', lease),
      log: (action, data) => portsRef.current.log(action, data),
    }).createExecutor(), [
    beginControllerFrameLoop,
    firstMessageId,
    messageCount,
    windowAtLiveEdge,
  ])

  const resetLiveEdgeRepaintDebt = useCallback(() => {
    // Read through the ref, not the lazy getter: a list that never pinned owes nothing, and building
    // the adapter here just to reset it would also add a dependency to the caller's entry effect.
    liveEdgeBrowserRef.current?.resetRepaintDebt()
  }, [])

  const disposeDirectionalHistoryBrowser = useCallback(() => {
    const directionalBrowser = directionalHistoryBrowserRef.current
    directionalBrowser?.dispose()
    if (directionalHistoryBrowserRef.current === directionalBrowser) {
      directionalHistoryBrowserRef.current = null
    }
  }, [])

  return {
    createLiveEdgeExecutor,
    createAnchorPreservationExecutor,
    buildDirectionalHistoryExecutor,
    buildSavedPositionExecutor,
    buildUnreadMarkerExecutor,
    buildExplicitTargetExecutor,
    createResidentTopExecutor,
    getDirectionalHistoryBrowser,
    resetLiveEdgeRepaintDebt,
    disposeDirectionalHistoryBrowser,
  }
}
