import type { MessageVirtualizer } from './messageVirtualizer'
import type {
  ExplicitTargetExecutor,
  PositionExecutionLease,
  PositionFrameLoop,
} from './positioningController'
import type { ExplicitTargetRequest } from './scrollPositionModel'
import { deriveReachabilityForDesired } from './scrollPositionFacts'
import { findMessageTargetElement } from './messageTargetElement'
import { evaluateJumpTarget } from './jumpTargetVisibility'
import { signalAnomaly } from '@/utils/anomalySignal'
import { AT_BOTTOM_THRESHOLD } from '@/utils/scrollStateManager'

/** Keep live-controller and isolated static-preview target flashes visually identical. */
export const TARGET_HIGHLIGHT_MS = 1500

export interface ExplicitTargetWindowFacts {
  hasRows: boolean
  windowAtLiveEdge: boolean
}

export interface ExplicitTargetPassiveContext {
  conversationId: string
  virtualizer: MessageVirtualizer | undefined
}

export interface ExplicitTargetBrowserAdapterOptions {
  getScroller: () => HTMLElement | null
  getVirtualizer: () => MessageVirtualizer | undefined
  getWindowFacts: () => ExplicitTargetWindowFacts
  getPassiveContext: () => ExplicitTargetPassiveContext
  getActiveConversationId: () => string
  getStoreTargetMessageId: () => string | null | undefined
  beginLoop: (lease: PositionExecutionLease) => PositionFrameLoop | null
  setMeasuredAtBottom: (atLiveEdge: boolean) => void
  markNotAtBottom: () => void
  consumeStoreTarget: () => void
  /**
   * Opens the settle window after a scrollTop write. Without it the measurement settle that lands
   * once the re-assert loop has ended reads as a scrollbar drag: height unchanged, no loop running.
   * See scrollGate.
   */
  recordProgrammaticWrite: (conversationId: string) => void
  log?: (action: string, data?: Record<string, unknown>) => void
}

export interface ExplicitTargetBrowserPorts {
  conversationId: string
  messageReference: string
  consumeStoreTarget: boolean
  loadAround?: ExplicitTargetExecutor['loadAround']
}

export class ExplicitTargetBrowserAdapter {
  constructor(private readonly options: ExplicitTargetBrowserAdapterOptions) {}

  createExecutor(ports: ExplicitTargetBrowserPorts): ExplicitTargetExecutor {
    return {
      reachability: (desired, loadAround) => {
        const scroller = this.options.getScroller()
        const virtualizer = this.options.getVirtualizer()
        const element = scroller
          ? findMessageTargetElement(scroller, desired.messageId)
          : null
        if (element) {
          return {
            kind: 'available',
            index: virtualizer?.getIndexForMessageId(desired.messageId) ?? 0,
            mounted: true,
            placement: 'viable',
          }
        }
        const window = this.options.getWindowFacts()
        const facts = deriveReachabilityForDesired({
          desired,
          hasRows: window.hasRows,
          windowAtLiveEdge: window.windowAtLiveEdge,
          virtualizer,
          scroller,
          loadAround,
          canRecenter: false,
        })
        // An explicit target can name the cache slice to load even before the resident window has
        // hydrated, unlike ordinary conversation-entry positioning.
        return facts.kind === 'empty-window'
          ? { kind: 'target-absent', loadAround }
          : facts
      },
      loadAround: ports.loadAround
        ? (messageId, signal) => {
            if (
              signal.aborted ||
              this.options.getActiveConversationId() !== ports.conversationId
            ) {
              return
            }
            this.options.markNotAtBottom()
            this.options.log?.(
              'TARGET MESSAGE: requesting cache slice around target',
              { conversationId: ports.conversationId, messageId },
            )
            return ports.loadAround?.(messageId, signal)
          }
        : undefined,
      beginLoop: (lease) => this.options.beginLoop(lease),
      readScrollTop: () => this.options.getScroller()?.scrollTop ?? null,
      positionFrame: (request, lease) => this.positionFrame(request, lease),
      complete: (request, outcome, applied) => {
        if (
          this.options.getActiveConversationId() !== request.conversationId ||
          request.desired.messageId !== ports.messageReference
        ) {
          return
        }
        if (
          ports.consumeStoreTarget &&
          this.options.getStoreTargetMessageId() !== request.desired.messageId
        ) {
          return
        }

        const scroller = this.options.getScroller()
        const element = scroller
          ? findMessageTargetElement(scroller, request.desired.messageId)
          : null
        if (element && applied) {
          element.classList.add('message-highlight')
          setTimeout(
            () => element.classList.remove('message-highlight'),
            TARGET_HIGHLIGHT_MS,
          )
        }
        this.options.log?.('TARGET MESSAGE: controller completed', {
          conversationId: request.conversationId,
          generation: request.generation,
          targetId: request.desired.messageId,
          outcome,
          highlighted: Boolean(element && applied),
        })

        if (__FLUUX_ANOMALY__ && scroller) {
          const viewport = scroller.getBoundingClientRect()
          const target = element?.getBoundingClientRect() ?? null
          const miss = evaluateJumpTarget({
            outcome,
            applied,
            target: target ? { top: target.top, bottom: target.bottom } : null,
            viewport: { top: viewport.top, bottom: viewport.bottom },
          })
          if (miss) {
            signalAnomaly({
              name: 'scroll/jump-target-miss',
              offBy: Math.round(miss.offBy),
              messageId: request.desired.messageId,
            })
          }
        }

        if (ports.consumeStoreTarget) this.options.consumeStoreTarget()
      },
    }
  }

  private positionFrame(
    request: ExplicitTargetRequest,
    lease: PositionExecutionLease,
  ): ReturnType<ExplicitTargetExecutor['positionFrame']> {
    if (!lease.isCurrent()) return { kind: 'unavailable' }
    const scroller = this.options.getScroller()
    if (!scroller) return { kind: 'unavailable' }

    // Requests can be submitted during entry. Wait for the passive handoff so the virtualizer from
    // the conversation being left cannot receive the first center write.
    const passive = this.options.getPassiveContext()
    if (passive.conversationId !== request.conversationId) {
      return { kind: 'waiting' }
    }

    const targetId = request.desired.messageId
    const virtualizer = passive.virtualizer
    const index = virtualizer?.getIndexForMessageId(targetId) ?? null
    const element = findMessageTargetElement(scroller, targetId)
    if (index === null && !element) return { kind: 'waiting' }
    if (!lease.isCurrent()) return { kind: 'unavailable' }

    if (index !== null && virtualizer) {
      virtualizer.scrollToIndex(index, { align: 'center' })
    } else {
      element?.scrollIntoView({ block: 'center' })
    }
    const scrollTop = scroller.scrollTop
    const distanceFromBottom =
      scroller.scrollHeight - scrollTop - scroller.clientHeight
    this.options.setMeasuredAtBottom(
      distanceFromBottom < AT_BOTTOM_THRESHOLD,
    )
    this.options.recordProgrammaticWrite(request.conversationId)
    this.options.log?.('TARGET MESSAGE: controller positioned frame', {
      conversationId: request.conversationId,
      generation: request.generation,
      targetId,
      index,
      scrollTop,
      distanceFromBottom,
    })
    return { kind: 'positioned', scrollTop, wrote: true }
  }
}
