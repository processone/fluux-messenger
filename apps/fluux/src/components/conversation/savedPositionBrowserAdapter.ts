import type { MessageVirtualizer } from './messageVirtualizer'
import type {
  LiveEdgeExecutor,
  PositionFrameLoop,
  SavedPositionExecutor,
  SavedPositionExecutionLease,
} from './positioningController'
import type { SavedPositionRequest } from './scrollPositionModel'
import type { BottomFractionAnchorBrowserAdapter } from './bottomFractionAnchorBrowserAdapter'
import { deriveReachabilityForDesired } from './scrollPositionFacts'

export interface SavedPositionWindowFacts {
  hasRows: boolean
  windowAtLiveEdge: boolean
  canRecenter: boolean
}

export interface SavedPositionBrowserAdapterOptions {
  getScroller: () => HTMLElement | null
  getVirtualizer: () => MessageVirtualizer | undefined
  getWindowFacts: () => SavedPositionWindowFacts
  beginLoop: (lease: SavedPositionExecutionLease) => PositionFrameLoop | null
  anchorAdapter: BottomFractionAnchorBrowserAdapter
}

export interface SavedPositionBrowserPorts {
  liveEdge: LiveEdgeExecutor
  loadAround?: SavedPositionExecutor['loadAround']
  recenterVersion?: string
  recenterLiveEdge?: SavedPositionExecutor['recenterLiveEdge']
  complete: SavedPositionExecutor['complete']
}

export class SavedPositionBrowserAdapter {
  constructor(private readonly options: SavedPositionBrowserAdapterOptions) {}

  createExecutor(ports: SavedPositionBrowserPorts): SavedPositionExecutor {
    return {
      liveEdge: ports.liveEdge,
      reachability: (desired, loadAround) => {
        const scroller = this.options.getScroller()
        const virtualizer = this.options.getVirtualizer()
        const facts = this.options.getWindowFacts()
        const legacyOffsetViable =
          desired.kind !== 'legacy-offset' ||
          Boolean(
            virtualizer ||
            (
              scroller &&
              scroller.scrollHeight - scroller.clientHeight > 0 &&
              desired.offsetPx >= 0 &&
              desired.offsetPx <= scroller.scrollHeight - scroller.clientHeight
            ),
          )
        return deriveReachabilityForDesired({
          desired,
          hasRows: facts.hasRows,
          windowAtLiveEdge: facts.windowAtLiveEdge,
          virtualizer,
          scroller,
          loadAround,
          canRecenter: facts.canRecenter,
          legacyOffsetViable,
        })
      },
      loadAround: ports.loadAround,
      recenterVersion: ports.recenterVersion,
      recenterLiveEdge: ports.recenterLiveEdge,
      beginLoop: (lease) => this.options.beginLoop(lease),
      positionFrame: (request, lease) => this.positionFrame(request, lease),
      complete: ports.complete,
    }
  }

  positionFrame(
    request: SavedPositionRequest,
    lease: SavedPositionExecutionLease,
  ): ReturnType<SavedPositionExecutor['positionFrame']> {
    if (!lease.isCurrent()) return { kind: 'unavailable' }
    const scroller = this.options.getScroller()
    if (!scroller) return { kind: 'unavailable' }

    let result: ReturnType<SavedPositionExecutor['positionFrame']>
    if (request.desired.kind === 'anchor') {
      result = this.options.anchorAdapter.position({
        messageId: request.desired.messageId,
        fraction: request.desired.placement.fraction,
      })
    } else if (request.desired.kind === 'legacy-offset') {
      const virtualizer = this.options.getVirtualizer()
      if (virtualizer) {
        virtualizer.scrollToOffset(request.desired.offsetPx)
        result = {
          kind: 'positioned',
          scrollTop: scroller.scrollTop,
          reassert: false,
        }
      } else {
        const maxScrollTop = scroller.scrollHeight - scroller.clientHeight
        if (
          maxScrollTop <= 0 ||
          request.desired.offsetPx < 0 ||
          request.desired.offsetPx > maxScrollTop
        ) {
          return { kind: 'unavailable' }
        }
        scroller.scrollTop = request.desired.offsetPx
        result = {
          kind: 'positioned',
          scrollTop: scroller.scrollTop,
          reassert: false,
        }
      }
    } else {
      // Live-edge fallbacks transfer to their dedicated controller execution before this executor
      // is driven. Treat a stale call as unavailable rather than creating another scroll owner.
      return { kind: 'unavailable' }
    }

    return result.kind === 'positioned' && lease.isCurrent()
      ? result
      : { kind: 'unavailable' }
  }
}
