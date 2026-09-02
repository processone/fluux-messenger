import type { MessageVirtualizer } from './messageVirtualizer'
import type {
  PositionExecutionLease,
  PositionFrameLoop,
  UnreadMarkerExecutor,
} from './positioningController'
import type { UnreadMarkerRequest } from './scrollPositionModel'
import { deriveReachabilityForDesired } from './scrollPositionFacts'
import { findMessageRowElement } from './messageRowIdentity'
import { AT_BOTTOM_THRESHOLD } from '@/utils/scrollStateManager'

export interface UnreadMarkerWindowFacts {
  hasRows: boolean
  windowAtLiveEdge: boolean
}

export interface UnreadMarkerPassiveContext {
  conversationId: string
  virtualizer: MessageVirtualizer | undefined
}

export interface UnreadMarkerBrowserAdapterOptions {
  getScroller: () => HTMLElement | null
  getVirtualizer: () => MessageVirtualizer | undefined
  getWindowFacts: () => UnreadMarkerWindowFacts
  getPassiveContext: () => UnreadMarkerPassiveContext
  beginLoop: (lease: PositionExecutionLease) => PositionFrameLoop | null
  setMeasuredAtBottom: (atLiveEdge: boolean) => void
  /**
   * Opens the settle window after a scrollTop write. Without it the measurement settle that lands
   * once the re-assert loop has ended reads as a scrollbar drag: height unchanged, no loop running.
   * See scrollGate.
   */
  recordProgrammaticWrite: (conversationId: string) => void
  log?: (action: string, data?: Record<string, unknown>) => void
}

export class UnreadMarkerBrowserAdapter {
  constructor(private readonly options: UnreadMarkerBrowserAdapterOptions) {}

  createExecutor(
    liveEdge: UnreadMarkerExecutor['liveEdge'],
  ): UnreadMarkerExecutor {
    return {
      liveEdge,
      reachability: (desired) => {
        const facts = this.options.getWindowFacts()
        return deriveReachabilityForDesired({
          desired,
          hasRows: facts.hasRows,
          windowAtLiveEdge: facts.windowAtLiveEdge,
          virtualizer: this.options.getVirtualizer(),
          scroller: this.options.getScroller(),
          loadAround: 'unavailable',
          canRecenter: false,
        })
      },
      beginLoop: (lease) => this.options.beginLoop(lease),
      readScrollTop: () => this.options.getScroller()?.scrollTop ?? null,
      positionFrame: (request, lease) => this.positionFrame(request, lease),
    }
  }

  private positionFrame(
    request: UnreadMarkerRequest,
    lease: PositionExecutionLease,
  ): ReturnType<UnreadMarkerExecutor['positionFrame']> {
    if (!lease.isCurrent()) return { kind: 'unavailable' }
    const scroller = this.options.getScroller()
    if (!scroller) return { kind: 'unavailable' }

    // Entry waits until the passive latest-value handoff has installed the new conversation's
    // virtualizer. The synchronous render ref can still describe a transient pre-paint window.
    const passive = this.options.getPassiveContext()
    if (passive.conversationId !== request.conversationId) {
      return { kind: 'waiting' }
    }

    const virtualizer = passive.virtualizer
    const markerId = request.desired.messageId
    const markerIndex = virtualizer
      ? virtualizer.getIndexForMessageId(markerId)
      : null
    let offset: number | null = null
    if (virtualizer) {
      if (markerIndex === null) {
        // An empty virtualizer is still hydrating. Once it has rows, an unindexed divider names a
        // message outside the resident slice and must transfer to the live-edge fallback.
        return virtualizer.itemCount === 0
          ? { kind: 'waiting' }
          : { kind: 'unavailable' }
      }
      offset = virtualizer.getOffsetForMessageId(markerId)
    } else {
      const element = findMessageRowElement(scroller, markerId)
      if (element) offset = element.offsetTop
    }
    if (offset === null) return { kind: 'waiting' }

    // Avoid scrollTop=0, which is the explicit load-older threshold. An unread divider near the
    // resident start retains the established live-edge fallback instead.
    if (offset <= scroller.clientHeight / 3) {
      return { kind: 'unavailable' }
    }
    if (!lease.isCurrent()) return { kind: 'unavailable' }

    if (virtualizer && markerIndex !== null) {
      virtualizer.scrollToIndex(markerIndex, { align: 'start' })
    } else {
      const top = request.desired.align === 'top-third'
        ? Math.max(0, offset - scroller.clientHeight / 3)
        : offset
      scroller.scrollTop = top
    }

    const scrollTop = scroller.scrollTop
    const distanceFromBottom =
      scroller.scrollHeight - scrollTop - scroller.clientHeight
    const atLiveEdge = distanceFromBottom < AT_BOTTOM_THRESHOLD
    this.options.setMeasuredAtBottom(atLiveEdge)
    this.options.recordProgrammaticWrite(request.conversationId)
    this.options.log?.('UNREAD MARKER: controller positioned frame', {
      conversationId: request.conversationId,
      generation: request.generation,
      markerId,
      markerIndex,
      offset,
      scrollTop,
      distanceFromBottom,
      atLiveEdge,
    })
    return { kind: 'positioned', scrollTop, atLiveEdge }
  }
}
