import { createScrollAnimation } from './scrollAnimationStep'
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
  recordProgrammaticWrite: () => void
  observeGeometry: () => void
  log?: (action: string, data?: Record<string, unknown>) => void
}

export class ResidentTopBrowserAdapter {
  constructor(private readonly options: ResidentTopBrowserAdapterOptions) {}

  /**
   * Controller rejection must degrade to progress, not a dead Home key. This write is instant on
   * purpose: an unleased smooth animation has no loop to mark its intermediate scroll events as
   * programmatic and can otherwise re-arm resident-top pagination while travelling.
   */
  emergencyWrite(): boolean {
    const scroller = this.options.getScroller()
    if (!scroller) return false
    const virtualizer = this.options.getVirtualizer()
    if (virtualizer) virtualizer.scrollToOffset(0)
    else scroller.scrollTop = 0
    this.options.recordProgrammaticWrite()
    this.options.log?.('RESIDENT TOP: emergency write')
    return true
  }

  createExecutor(): ResidentTopExecutor {
    const animate = createScrollAnimation()
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
        this.positionFrame(lease, animate)
        return lease.isCurrent() ? { kind: 'started' } : { kind: 'unavailable' }
      },
      positionFrame: (lease) => this.positionFrame(lease, animate),
      complete: (request, outcome) => {
        this.options.log?.('RESIDENT TOP: controller completed', {
          conversationId: request.conversationId,
          generation: request.generation,
          outcome,
        })
      },
    }
  }

  private positionFrame(lease: PositionExecutionLease, animate: ReturnType<typeof createScrollAnimation>): number | null {
    if (!lease.isCurrent()) return null
    const scroller = this.options.getScroller()
    if (!scroller) return null
    this.options.observeGeometry()
    if (!lease.isCurrent()) return null
    const top = animate(scroller.scrollTop, 0)
    const virtualizer = this.options.getVirtualizer()
    if (virtualizer) virtualizer.scrollToOffset(top)
    else scroller.scrollTop = top
    this.options.recordProgrammaticWrite()
    return scroller.scrollTop
  }

}
