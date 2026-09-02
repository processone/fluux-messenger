import type { DirectionalHistoryCapture } from './directionalHistoryWindowCoordinator'
import type { MessageVirtualizer } from './messageVirtualizer'
import type {
  DirectionalHistoryExecutor,
  PositionExecutionLease,
  PositionFrameLoop,
} from './positioningController'
import { deriveReachabilityForDesired } from './scrollPositionFacts'
import {
  findMessageRowElement,
  messageRowElements,
  readMessageRowId,
} from './messageRowIdentity'

export interface DirectionalHistoryBrowserCapture {
  anchor: { id: string; offsetFromTop: number } | null
  facts: DirectionalHistoryCapture
  geometry: {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
  }
}

export interface DirectionalHistoryBrowserAdapterOptions {
  getScroller: () => HTMLElement | null
  getVirtualizer: () => MessageVirtualizer | undefined
  getActiveConversationId: () => string
  beginLoop: (lease: PositionExecutionLease) => PositionFrameLoop | null
  requestFrame: (callback: () => void) => number
  cancelFrame: (id: number) => void
  log?: (action: string, data?: Record<string, unknown>) => void
}

/**
 * Browser-only mechanics for directional history preservation.
 *
 * The window coordinator decides whether and how long a load owns a snapshot, while the
 * positioning controller owns generations and convergence. This adapter only captures current
 * DOM/virtualizer geometry, performs writes under the controller lease, and owns the one-frame
 * browser settlement callbacks that are cancelled on teardown.
 */
export class DirectionalHistoryBrowserAdapter {
  private readonly settlementFrames = new Set<number>()
  private disposed = false

  constructor(private readonly options: DirectionalHistoryBrowserAdapterOptions) {}

  isAvailable(): boolean {
    return this.options.getScroller() !== null
  }

  capture(
    firstMessageId: string,
    messageCount: number,
  ): DirectionalHistoryBrowserCapture | null {
    const scroller = this.options.getScroller()
    if (!scroller) return null
    const virtualizer = this.options.getVirtualizer()
    const { scrollTop, scrollHeight, clientHeight } = scroller
    let anchor: DirectionalHistoryBrowserCapture['anchor'] = null

    if (virtualizer) {
      if (scrollTop === 0 && firstMessageId) {
        anchor = {
          id: firstMessageId,
          offsetFromTop:
            virtualizer.getOffsetForMessageId(firstMessageId) ?? 0,
        }
      } else {
        for (const item of virtualizer.getVirtualItems()) {
          const viewportOffset = item.start - scrollTop
          if (viewportOffset < -item.size / 2) continue
          const wrapper = scroller.querySelector(
            `[data-index="${item.index}"]`,
          )
          const message = wrapper?.querySelector(
            '[data-message-row-id], [data-message-id]',
          ) as HTMLElement | null
          const messageId = message ? readMessageRowId(message) : undefined
          if (!messageId) continue
          anchor = { id: messageId, offsetFromTop: viewportOffset }
          break
        }
        if (!anchor && firstMessageId) {
          anchor = {
            id: firstMessageId,
            offsetFromTop:
              (virtualizer.getOffsetForMessageId(firstMessageId) ?? 0) -
              scrollTop,
          }
        }
      }
    } else {
      const messages = messageRowElements(scroller)
      const scrollerRect = scroller.getBoundingClientRect()
      for (const message of messages) {
        const element = message as HTMLElement
        const rect = element.getBoundingClientRect()
        if (rect.top - scrollerRect.top < -rect.height / 2) continue
        const messageId = readMessageRowId(element)
        if (!messageId) continue
        anchor = {
          id: messageId,
          offsetFromTop: element.offsetTop - scrollTop,
        }
        break
      }
      if (!anchor) {
        const first = messages[0] as HTMLElement | undefined
        const messageId = first ? readMessageRowId(first) : undefined
        if (first && messageId) {
          anchor = {
            id: messageId,
            offsetFromTop: first.offsetTop - scrollTop,
          }
        }
      }
    }

    const geometry = { scrollTop, scrollHeight, clientHeight }
    const result = {
      anchor,
      facts: {
        anchorMessageId: anchor?.id ?? '',
        anchorOffsetFromTop: anchor?.offsetFromTop ?? 0,
        distanceFromBottom: scrollHeight - scrollTop - clientHeight,
        firstMessageId,
        messageCount,
      },
      geometry,
    }
    this.options.log?.('DIRECTIONAL HISTORY CAPTURE', result)
    return result
  }

  createExecutor(
    complete: DirectionalHistoryExecutor['complete'],
  ): DirectionalHistoryExecutor {
    let initialized = false
    let previousTarget = 0
    let usedFallback = false

    return {
      reachability: (desired) => {
        const scroller = this.options.getScroller()
        const virtualizer = this.options.getVirtualizer()
        return deriveReachabilityForDesired({
          desired,
          hasRows: Boolean(
            (virtualizer && virtualizer.itemCount > 0) ||
            (scroller && messageRowElements(scroller).length > 0),
          ),
          windowAtLiveEdge: true,
          virtualizer,
          scroller,
          loadAround: 'unavailable',
          canRecenter: false,
        })
      },
      beginLoop: (lease) => this.options.beginLoop(lease),
      positionFrame: (request, lease) => {
        if (
          !lease.isCurrent() ||
          this.options.getActiveConversationId() !== request.conversationId
        ) {
          return { kind: 'unavailable' }
        }
        const scroller = this.options.getScroller()
        if (!scroller) return { kind: 'unavailable' }
        const virtualizer = this.options.getVirtualizer()

        if (!initialized) {
          // Preserve both reads from the former pre-paint path: first flush the current layout,
          // then force the overflow-hidden layout that cancels WebKit momentum.
          void scroller.offsetHeight
          cancelKineticScroll(scroller)
        }

        let target: number | null = null
        let usedMethod = 'none'
        if (request.desired.messageId) {
          const virtualOffset =
            virtualizer?.getOffsetForMessageId(request.desired.messageId) ??
            null
          if (virtualOffset !== null) {
            target = virtualOffset - request.desired.placement.offsetPx
            usedMethod = 'virtualizer-offset'
          } else {
            const anchor = findMessageRowElement(scroller, request.desired.messageId)
            if (anchor) {
              target = anchor.offsetTop - request.desired.placement.offsetPx
              usedMethod = 'element-based'
            }
          }
        }

        if (target === null) {
          if (initialized) {
            return {
              kind: 'positioned',
              scrollTop: scroller.scrollTop,
              wrote: false,
              reassert: Boolean(virtualizer && !usedFallback),
            }
          }
          target =
            scroller.scrollHeight -
            scroller.clientHeight -
            request.onUnavailable.distancePx
          usedMethod = 'distance-from-bottom'
          usedFallback = true
        }

        const maxScrollTop = Math.max(
          0,
          scroller.scrollHeight - scroller.clientHeight,
        )
        const boundedTarget = Math.max(0, Math.min(target, maxScrollTop))
        const targetMoved =
          initialized && Math.abs(boundedTarget - previousTarget) > 2
        const geometryDrift =
          initialized && Math.abs(scroller.scrollTop - boundedTarget) > 5
        const shouldWrite = !initialized || targetMoved || geometryDrift
        if (shouldWrite) {
          if (virtualizer) virtualizer.scrollToOffset(boundedTarget)
          else scroller.scrollTop = boundedTarget
        }
        previousTarget = boundedTarget
        initialized = true

        this.options.log?.('DIRECTIONAL HISTORY POSITION', {
          generation: request.generation,
          usedMethod,
          target: boundedTarget,
          targetMoved,
          geometryDrift,
          wrote: shouldWrite,
        })
        return {
          kind: 'positioned',
          scrollTop: scroller.scrollTop,
          wrote: shouldWrite,
          reassert: Boolean(virtualizer && !usedFallback),
        }
      },
      complete,
    }
  }

  scheduleSettlement(callback: () => void): void {
    if (this.disposed) return
    let frame: number | null = null
    let pending = true
    frame = this.options.requestFrame(() => {
      pending = false
      if (frame !== null) this.settlementFrames.delete(frame)
      if (!this.disposed) callback()
    })
    if (pending) this.settlementFrames.add(frame)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const frame of this.settlementFrames) {
      this.options.cancelFrame(frame)
    }
    this.settlementFrames.clear()
  }
}

function cancelKineticScroll(scroller: HTMLElement): void {
  scroller.style.overflowY = 'hidden'
  void scroller.offsetHeight
  scroller.style.overflowY = ''
}
