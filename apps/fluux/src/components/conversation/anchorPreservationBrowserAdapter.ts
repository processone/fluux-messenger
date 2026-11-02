import type { MessageVirtualizer } from './messageVirtualizer'
import type {
  AnchorPreservationExecutor,
  PositionExecutionLease,
  PositionFrameLoop,
} from './positioningController'
import type { AnchorPreservationRequest } from './scrollPositionModel'
import type { BottomFractionAnchorBrowserAdapter } from './bottomFractionAnchorBrowserAdapter'
import { deriveReachabilityForDesired } from './scrollPositionFacts'
import { AT_BOTTOM_THRESHOLD, type ScrollAnchor } from '@/utils/scrollStateManager'
import { findMessageRowElement } from './messageRowIdentity'

/** Distinguishes fixed-anchor stimuli in frame-loop diagnostics. */
export type AnchorPreservationLoopLabel =
  | 'media-anchor'
  | 'divider-anchor'
  | 'insertion-anchor'
  | 'width-anchor'
  | 'interaction-anchor'

export interface AnchorPreservationWindowFacts {
  hasRows: boolean
  windowAtLiveEdge: boolean
}

export interface AnchorPreservationBrowserAdapterOptions {
  getScroller: () => HTMLElement | null
  getVirtualizer: () => MessageVirtualizer | undefined
  getActiveConversationId: () => string
  getWindowFacts: () => AnchorPreservationWindowFacts
  beginLoop: (
    label: AnchorPreservationLoopLabel,
    lease: PositionExecutionLease,
  ) => PositionFrameLoop | null
  anchorAdapter: BottomFractionAnchorBrowserAdapter
  /**
   * Raw bottom-intent bookkeeping, deliberately NOT the measured-live-edge evidence channel:
   * preserving a reading point must not report a live-edge observation to the SDK.
   */
  setAtBottom: (atBottom: boolean) => void
  rememberScrollSnapshot: () => void
  recordProgrammaticWrite: (conversationId: string) => void
  observeGeometry: (conversationId: string) => void
  log?: (action: string, data?: Record<string, unknown>) => void
}

/**
 * Owns the browser half of fixed-anchor layout preservation: media remeasurement, unread-divider
 * movement, and delayed live-path insertion inside the resident window. All three share the
 * bottom-fraction geometry adapter, so saved restoration and preservation converge on identical
 * row-rect/virtualizer measurements without a second positioning lifecycle.
 */
export class AnchorPreservationBrowserAdapter {
  constructor(private readonly options: AnchorPreservationBrowserAdapterOptions) {}

  createExecutor(
    label: AnchorPreservationLoopLabel,
  ): AnchorPreservationExecutor {
    return {
      observeGeometry: () => this.options.observeGeometry(this.options.getActiveConversationId()),
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
      beginLoop: (lease) => this.options.beginLoop(label, lease),
      positionFrame: (request, lease) => this.positionFrame(request, lease),
      complete: (request, outcome) => {
        if (
          this.options.getActiveConversationId() !== request.conversationId
        ) {
          return
        }
        const scroller = this.options.getScroller()
        if (scroller && request.source.kind !== 'interaction') {
          this.options.setAtBottom(
            scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
              AT_BOTTOM_THRESHOLD,
          )
          this.options.rememberScrollSnapshot()
        }
        // Ending an interaction loop is not a write. Recording here would bless a native
        // scroll before the replacement loop observes it, and snap selection/find back.
        if (request.source.kind !== 'interaction') this.options.recordProgrammaticWrite(request.conversationId)
        this.options.log?.('ANCHOR: controller completed preservation', {
          conversationId: request.conversationId,
          generation: request.generation,
          source: request.source.kind,
          outcome,
        })
      },
    }
  }

  private positionFrame(
    request: AnchorPreservationRequest,
    lease: PositionExecutionLease,
  ): ReturnType<AnchorPreservationExecutor['positionFrame']> {
    if (
      !lease.isCurrent() ||
      this.options.getActiveConversationId() !== request.conversationId
    ) {
      return { kind: 'unavailable' }
    }
    if (request.desired.placement.kind === 'top-offset') {
      const scroller = this.options.getScroller()
      const row = scroller && findMessageRowElement(scroller, request.desired.messageId)
      const bubble = row?.querySelector<HTMLElement>('[data-message-body]') ?? row
      if (!scroller || !bubble) return { kind: 'unavailable' }
      const target = Math.max(0, scroller.scrollTop + bubble.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top - request.desired.placement.offsetPx)
      // A growing viewport can clamp away the held offset (for example when typing stops).
      // Reserve only the missing scroll range, under this same positioning lease.
      const padding = parseFloat(getComputedStyle(scroller).paddingBottom) || 0
      const naturalHeight = scroller.scrollHeight - padding
      scroller.style.paddingBottom = `${Math.max(0, target + scroller.clientHeight - naturalHeight)}px`
      if (Math.abs(scroller.scrollTop - target) > 0.5) {
        const virtualizer = this.options.getVirtualizer()
        if (virtualizer) {
          const write = virtualizer.scrollToOffset(target, { owner: lease.owner })
          if (write.outcome().status === 'applied') this.options.recordProgrammaticWrite(request.conversationId)
        } else {
          scroller.scrollTop = target
          this.options.recordProgrammaticWrite(request.conversationId)
        }
      }
      return { kind: 'positioned', scrollTop: scroller.scrollTop, reassert: true }
    }
    const anchor: ScrollAnchor = {
      messageId: request.desired.messageId,
      fraction: request.desired.placement.fraction,
    }
    const result = this.options.anchorAdapter.position(anchor, lease.owner)
    if (result.kind === 'positioned') this.options.recordProgrammaticWrite(request.conversationId)
    return result
  }
}
