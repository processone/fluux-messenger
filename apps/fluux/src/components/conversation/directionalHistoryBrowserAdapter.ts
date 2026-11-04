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
 * This holds with virtualization off too, the flag's documented opt-out (review FLM-338 R1).
 */
interface FollowedAnchor {
  /** The load's captured anchor: the restore request this follow belongs to names it. */
  capturedId: string
  /** The window's first row, which a virtualized anchor takes last; see `anchorRowInView`. */
  windowFirstId: string
  /** Whether the virtualizer rendered the list at capture: `index` counts its rows if so, and the
   *  rendered message rows if not. */
  virtual: boolean
  id: string
  index: number | null
  offsetFromTop: number
}

/** A rendered row, `top` measured from the top of the view. */
interface RowInView {
  id: string
  top: number
  height: number
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
    // Without a virtualizer, the anchor's place among the rendered message rows.
    let messageIndex: number | null = null
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
      const row = anchorRowInView(virtualRowsInView(scroller, items), clientHeight, firstMessageId)
      anchor = row ? { id: row.id, offsetFromTop: row.top } : null
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
      const row = anchorRowInView(messageRowsInView(scroller, messages), clientHeight)
      if (row) {
        anchor = { id: row.id, offsetFromTop: row.element.offsetTop - scrollTop }
        messageIndex = messages.indexOf(row.element)
      } else {
        const first = messages[0] as HTMLElement | undefined
        const messageId = first ? readMessageRowId(first) : undefined
        if (first && messageId) {
          anchor = {
            id: messageId,
            offsetFromTop: first.offsetTop - scrollTop,
          }
          messageIndex = 0
        }
      }
    }

    this.followed = anchor
      ? {
          capturedId: anchor.id,
          windowFirstId: firstMessageId,
          virtual: Boolean(virtualizer),
          id: anchor.id,
          index: virtualizer ? virtualizer.getIndexForMessageId(anchor.id) : messageIndex,
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
   * chosen as `capture` chooses it: an arrival outside the view then moves none of the rows the
   * reader is reading, and the restore it starts leaves them where they are (FLM-210). Past the top
   * in a bounce, or with a stale window, no rendered row can name the view, so the anchor stays and
   * only its offset follows.
   */
  observeScroll(): void {
    const followed = this.followed
    if (!followed) return
    const scroller = this.options.getScroller()
    if (!scroller) return
    const virtualizer = this.options.getVirtualizer()
    if (Boolean(virtualizer) !== followed.virtual) return
    if (virtualizer) followVirtualRows(followed, scroller, virtualizer)
    else followMessageRows(followed, scroller)
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

function followVirtualRows(
  followed: FollowedAnchor,
  scroller: HTMLElement,
  virtualizer: MessageVirtualizer,
): void {
  if (virtualizer.getIndexForMessageId(followed.id) !== followed.index) return
  const items = virtualizer.getVirtualItems()
  const scrollTop = scroller.scrollTop
  if (items.some(item => item.start <= scrollTop && item.start + item.size > scrollTop)) {
    const current = anchorRowInView(
      virtualRowsInView(scroller, items),
      scroller.clientHeight,
      followed.windowFirstId,
    )
    const index = current ? virtualizer.getIndexForMessageId(current.id) : null
    if (current && index !== null) {
      followed.id = current.id
      followed.index = index
      followed.offsetFromTop = current.top
      return
    }
  }
  // Rendered rows include the library's hold during a gesture; the layout start is the fallback
  // for an anchor the reader scrolled out of the rendered window.
  const start =
    items.find(item => item.index === followed.index)?.start ??
    rowStart(virtualizer, followed.id)
  if (start === null) return
  followed.offsetFromTop = start - scrollTop
}

/** The unvirtualized path: every message row is rendered, so only a bounce past the top leaves the
 *  view without a row to name it. */
function followMessageRows(followed: FollowedAnchor, scroller: HTMLElement): void {
  const messages = messageRowElements(scroller)
  const index = messages.findIndex(element => readMessageRowId(element) === followed.id)
  if (index < 0 || index !== followed.index) return
  const scrollTop = scroller.scrollTop
  if (scrollTop >= 0) {
    const current = anchorRowInView(messageRowsInView(scroller, messages), scroller.clientHeight)
    if (current) {
      followed.id = current.id
      followed.index = messages.indexOf(current.element)
      followed.offsetFromTop = current.element.offsetTop - scrollTop
      return
    }
  }
  followed.offsetFromTop = messages[index].offsetTop - scrollTop
}

/**
 * The row a load holds, from the rows in view in order: the row at the top of the view. Only a row
 * in view qualifies, so an arrival outside the view moves none of the rows the reader reads.
 *
 * A row mostly scrolled past the top gives way to the next row when that row starts in the top half
 * of the view, as it always does when the first row is no taller than the view: the reader is
 * reading the next one. A row taller than the view that still fills most of it stays the anchor
 * (review FLM-338 R2): the next row is off screen or barely in it, and an arrival between the two
 * would otherwise move the message being read.
 *
 * The window's first row, `skipId`, is held only when it is the only row in view: prepended history
 * changes that row, which stops heading its group and loses its sender line (~43 px) when older
 * messages of the same sender land above it, so its top would stay still while the text under the
 * reader jumped.
 */
function anchorRowInView<Row extends RowInView>(
  rowsInView: Iterable<Row>,
  viewHeight: number,
  skipId?: string,
): Row | null {
  let first: Row | null = null
  let skipped: Row | null = null
  for (const row of rowsInView) {
    if (row.id === skipId) {
      skipped = row
      continue
    }
    if (!first) {
      if (row.top >= -row.height / 2) return row
      first = row
      continue
    }
    return row.top < viewHeight / 2 ? row : first
  }
  return first ?? skipped
}

/** The virtualizer's message rows that are in view, in order. */
function* virtualRowsInView(
  scroller: HTMLElement,
  items: readonly { index: number; start: number; size: number }[],
): Generator<RowInView> {
  const scrollTop = scroller.scrollTop
  const viewHeight = scroller.clientHeight
  for (const item of items) {
    const top = item.start - scrollTop
    if (top + item.size <= 0) continue
    if (top >= viewHeight) return
    const wrapper = scroller.querySelector(`[data-index="${item.index}"]`)
    const message = wrapper?.querySelector(
      '[data-message-row-id], [data-message-id]',
    ) as HTMLElement | null
    const id = message ? readMessageRowId(message) : undefined
    if (id) yield { id, top, height: item.size }
  }
}

/** The rendered message rows that are in view, in order. They are laid out in DOM order, so the
 *  first one is found by bisection rather than by measuring every row above the view. */
function* messageRowsInView(
  scroller: HTMLElement,
  messages: readonly HTMLElement[],
): Generator<RowInView & { element: HTMLElement }> {
  const viewTop = scroller.getBoundingClientRect().top
  const viewHeight = scroller.clientHeight
  let low = 0
  let high = messages.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (messages[middle].getBoundingClientRect().bottom - viewTop <= 0) low = middle + 1
    else high = middle
  }
  for (let index = low; index < messages.length; index += 1) {
    const element = messages[index]
    const rect = element.getBoundingClientRect()
    const top = rect.top - viewTop
    if (top >= viewHeight) return
    const id = readMessageRowId(element)
    if (id) yield { id, top, height: rect.height, element }
  }
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
