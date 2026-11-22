/**
 * Geometry reading of a scroll viewport. Kept apart from `viewportScroller.ts` because the list
 * itself ships this in production builds, while the scroller registry is anomaly-only support
 * code that the build audit requires to be absent from them.
 *
 * @module Utils/ViewportMetrics
 */

/** One independent measurement of a view's scroll viewport. */
export interface ViewportMetrics {
  /** Pixels between the viewport bottom and the content bottom. */
  distFromBottom: number
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

/**
 * Measure a scroll element, right now.
 *
 * @returns `null` when there is no element, or when it has been detached from the
 * document. A detached element reports zeros for every metric, which would read as
 * "pinned to the bottom" — a confident wrong answer, and worse than admitting we cannot see.
 */
export function measureElementViewport(element: HTMLElement | null | undefined): ViewportMetrics | null {
  if (!element || !element.isConnected) return null
  const scrollHeight = element.scrollHeight
  const scrollTop = element.scrollTop
  const clientHeight = element.clientHeight
  return {
    distFromBottom: scrollHeight - scrollTop - clientHeight,
    scrollHeight,
    scrollTop,
    clientHeight,
  }
}
