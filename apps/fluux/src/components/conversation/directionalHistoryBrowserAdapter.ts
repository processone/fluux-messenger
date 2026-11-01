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
 * The anchor as the reader last saw it. On an iPhone a load is captured early in the bounce past
 * the top, and the bounce goes on deepening (by up to 102 px in device traces) until the batch
 * lands; the commit then clamps scrollTop to 0, so the restore can no longer read it.
 *
 * A reader who scrolls while the load waits moves on to other rows: the anchor becomes the row
 * then at the top of the view, so the load's capture row may be off screen. A delayed arrival
 * between the view and that row moves it but none of the rows the reader is reading (FLM-210).
 */
interface FollowedAnchor {
  /** The load's captured anchor: the restore request this follow belongs to names it. */
  capturedId: string
  /** The window's first row, which no anchor takes; see `capture`. */
  windowFirstId: string
  id: string
  index: number | null
  offsetFromTop: number
}

/** The row a restore holds, and where it places it. */
export interface DirectionalHistoryPlacement {
  messageId: string
  offsetFromTop: number
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
  private followed: FollowedAnchor | null = null
  // The executor whose restore holds its anchor in the virtualizer, so only it lets go.
  private anchorHolder: object | null = null

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
    const items = virtualizer?.getVirtualItems() ?? []

    // At scrollTop 0 the first message is on screen. A virtual window that does not reach the top
    // is stale (WebKit can hold back the scroll that re-windows it), so its rows cannot name the
    // anchor; the first message can. A current window takes the row after it, as below.
    if (
      virtualizer && scrollTop === 0 && firstMessageId &&
      !items.some(item => item.start <= 0 && item.start + item.size > 0)
    ) {
      anchor = {
        id: firstMessageId,
        offsetFromTop: rowStart(virtualizer, firstMessageId) ?? 0,
      }
    } else if (virtualizer) {
      anchor = firstVisibleRow(scroller, items, firstMessageId)
      if (!anchor && firstMessageId) {
        anchor = {
          id: firstMessageId,
          offsetFromTop:
            (rowStart(virtualizer, firstMessageId) ?? 0) -
            scrollTop,
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

    this.followed = virtualizer && anchor
      ? {
          capturedId: anchor.id,
          windowFirstId: firstMessageId,
          id: anchor.id,
          index: virtualizer.getIndexForMessageId(anchor.id),
          offsetFromTop: anchor.offsetFromTop,
        }
      : null
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

  /**
   * Follow the reader's view with the anchor until the batch lands. Called on every scroll event;
   * it stops once rows land before the anchor (its index changes): they move it, and only the
   * restore, which runs in that same commit, may place it from then on. Rows added after it, such
   * as a live message, do not move it.
   *
   * While rendered rows cover the top of the view, the anchor is the row the reader now sees there,
   * chosen as `capture` chooses it: an arrival below it then moves none of the rows the reader is
   * reading, and the restore it starts leaves them where they are (FLM-210). Past the top in a
   * bounce, or with a stale window, no rendered row can name the view, so the anchor stays and only
   * its offset follows.
   */
  observeScroll(): void {
    const followed = this.followed
    if (!followed) return
    const scroller = this.options.getScroller()
    const virtualizer = this.options.getVirtualizer()
    if (!scroller || !virtualizer) return
    if (virtualizer.getIndexForMessageId(followed.id) !== followed.index) return
    const items = virtualizer.getVirtualItems()
    const scrollTop = scroller.scrollTop
    if (items.some(item => item.start <= scrollTop && item.start + item.size > scrollTop)) {
      const current = firstVisibleRow(scroller, items, followed.windowFirstId)
      const index = current ? virtualizer.getIndexForMessageId(current.id) : null
      if (current && index !== null) {
        followed.id = current.id
        followed.index = index
        followed.offsetFromTop = current.offsetFromTop
        return
      }
    }
    // Rendered rows include the library's hold during a gesture; the layout start is the fallback
    // for an anchor the reader scrolled out of the rendered window.
    const start =
      virtualizer.getVirtualItems().find(item => item.index === followed.index)?.start ??
      rowStart(virtualizer, followed.id)
    if (start === null) return
    followed.offsetFromTop = start - scroller.scrollTop
  }

  /**
   * The followed anchor of the load that captured `capturedId`, once. A restart of the same load
   * uses the placement this restore recorded; a new load captures its own.
   */
  private takeFollowed(capturedId: string | undefined): DirectionalHistoryPlacement | null {
    const followed = this.followed
    if (!followed || followed.capturedId !== capturedId) return null
    this.followed = null
    return { messageId: followed.id, offsetFromTop: followed.offsetFromTop }
  }

  private releaseAnchor(holder: object): void {
    if (this.anchorHolder !== holder) return
    this.anchorHolder = null
    this.options.getVirtualizer()?.holdAnchor?.(null)
  }

  /**
   * `onPlaced` hears which row the restore holds and where, once, on its first frame, so a restart
   * of the same load can place it there again: the followed anchor is taken only once.
   */
  createExecutor(
    complete: DirectionalHistoryExecutor['complete'],
    onPlaced?: (placement: DirectionalHistoryPlacement) => void,
  ): DirectionalHistoryExecutor {
    let initialized = false
    let previousTarget = 0
    let usedFallback = false
    // The row the restore holds and where it goes, fixed on the first frame: the row the reader
    // last saw at the top of the view, where they saw it.
    let anchorId: string | undefined
    let placementOffset: number | null = null
    const holder = {}

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

        if (placementOffset === null) {
          const followed = this.takeFollowed(request.desired.messageId)
          anchorId = followed?.messageId ?? request.desired.messageId
          placementOffset = followed?.offsetFromTop ?? request.desired.placement.offsetPx
          if (anchorId) onPlaced?.({ messageId: anchorId, offsetFromTop: placementOffset })
        }
        let target: number | null = null
        let usedMethod = 'none'
        if (anchorId) {
          const virtualOffset = virtualizer
            ? rowStart(virtualizer, anchorId)
            : null
          if (virtualOffset !== null) {
            target = virtualOffset - placementOffset
            usedMethod = 'virtualizer-offset'
          } else {
            const anchor = findMessageRowElement(scroller, anchorId)
            if (anchor) {
              target = anchor.offsetTop - placementOffset
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
        if (
          virtualizer?.holdAnchor && anchorId &&
          usedMethod === 'virtualizer-offset' && this.anchorHolder !== holder
        ) {
          // Rows that measure after the write, between the viewport top and the anchor, would
          // otherwise move it until the next frame's correction, which the reader's touch cancels.
          virtualizer.holdAnchor(anchorId)
          this.anchorHolder = holder
        }
        if (shouldWrite) {
          if (virtualizer) virtualizer.scrollToOffset(boundedTarget, { releaseGesture: true, owner: lease.owner })
          else scroller.scrollTop = boundedTarget
        }
        previousTarget = boundedTarget
        initialized = true

        this.options.log?.('DIRECTIONAL HISTORY POSITION', {
          generation: request.generation,
          anchorId,
          usedMethod,
          placementOffset,
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
      complete: (request, outcome) => {
        if (outcome !== 'applied') this.releaseAnchor(holder)
        complete(request, outcome)
      },
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
    this.followed = null
    if (this.anchorHolder) this.releaseAnchor(this.anchorHolder)
    for (const frame of this.settlementFrames) {
      this.options.cancelFrame(frame)
    }
    this.settlementFrames.clear()
  }
}

/**
 * The first row at least half in view, skipping the window's first row: prepended history changes
 * that row, which stops heading its group and loses its sender line (~43 px) when older messages of
 * the same sender land above it. Anchoring on it would keep its top still while the text under the
 * reader jumps.
 */
function firstVisibleRow(
  scroller: HTMLElement,
  items: readonly { index: number; start: number; size: number }[],
  windowFirstId: string,
): { id: string; offsetFromTop: number } | null {
  const scrollTop = scroller.scrollTop
  for (const item of items) {
    const viewportOffset = item.start - scrollTop
    if (viewportOffset < -item.size / 2) continue
    const wrapper = scroller.querySelector(`[data-index="${item.index}"]`)
    const message = wrapper?.querySelector(
      '[data-message-row-id], [data-message-id]',
    ) as HTMLElement | null
    const messageId = message ? readMessageRowId(message) : undefined
    if (!messageId || messageId === windowFirstId) continue
    return { id: messageId, offsetFromTop: viewportOffset }
  }
  return null
}

/**
 * Where a row starts in the content. The anchor math needs the real start: the clamped offset
 * lookup reads short for a row in the final viewport, by as much as the row sits past the
 * scrollable range, and the restore would land the anchor off by that much.
 */
function rowStart(virtualizer: MessageVirtualizer, messageId: string): number | null {
  return virtualizer.getMessageStart
    ? virtualizer.getMessageStart(messageId)
    : virtualizer.getOffsetForMessageId(messageId)
}

function cancelKineticScroll(scroller: HTMLElement): void {
  scroller.style.overflowY = 'hidden'
  void scroller.offsetHeight
  scroller.style.overflowY = ''
}
