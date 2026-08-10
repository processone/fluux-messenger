import type { MessageVirtualizer } from './messageVirtualizer'
import type {
  PositionExecutionLease,
  PositionFrameLoop,
  ResidentTopExecutor,
} from './positioningController'
import { deriveReachabilityForDesired } from './scrollPositionFacts'

export interface ResidentTopWindowFacts {
  hasRows: boolean
  windowAtLiveEdge: boolean
}

export interface ResidentTopBrowserAdapterOptions {
  getScroller: () => HTMLElement | null
  getVirtualizer: () => MessageVirtualizer | undefined
  getWindowFacts: () => ResidentTopWindowFacts
  beginLoop: (lease: PositionExecutionLease) => PositionFrameLoop | null
  log?: (action: string, data?: Record<string, unknown>) => void
}

/**
 * Owns the Home/resident-top browser write. One animated command is issued and then only observed:
 * the controller settles it from `readScrollTop`, so the executor never reissues the target.
 */
export class ResidentTopBrowserAdapter {
  constructor(private readonly options: ResidentTopBrowserAdapterOptions) {}

  createExecutor(): ResidentTopExecutor {
    return {
      reachability: () => {
        const facts = this.options.getWindowFacts()
        return deriveReachabilityForDesired({
          desired: { kind: 'resident-top' },
          hasRows: facts.hasRows,
          windowAtLiveEdge: facts.windowAtLiveEdge,
          virtualizer: this.options.getVirtualizer(),
          scroller: this.options.getScroller(),
          loadAround: 'unavailable',
          canRecenter: false,
        })
      },
      beginLoop: (lease) => this.options.beginLoop(lease),
      start: (_request, lease) => {
        const scroller = this.options.getScroller()
        if (!lease.isCurrent() || !scroller) return { kind: 'unavailable' }
        const virtualizer = this.options.getVirtualizer()
        // One smooth write either way — but on the virtualized path it must be issued THROUGH the
        // virtualizer. Cancelling the superseded live-edge execution only retires our own lease and
        // frame loop; @tanstack's pending-scroll reconciler stays armed on the live edge for
        // several more seconds and re-applies it whenever late row measurement moves its target,
        // overriding this animation with no controller event to observe. Issuing the write through
        // the virtualizer retargets that reconciler onto resident top instead of racing it.
        if (virtualizer) virtualizer.beginAnimatedScrollToOffset(0)
        else scroller.scrollTo({ top: 0, behavior: 'smooth' })
        return { kind: 'started' }
      },
      readScrollTop: () => this.options.getScroller()?.scrollTop ?? null,
      complete: (request, outcome) => {
        this.options.log?.('RESIDENT TOP: controller completed', {
          conversationId: request.conversationId,
          generation: request.generation,
          outcome,
        })
      },
    }
  }
}
