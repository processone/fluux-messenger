/**
 * Viewport scroller registry.
 *
 * A sibling of `viewportAtBottom.ts`, and deliberately not a field on it: that one
 * registers the at-bottom BOOLEAN maintained by `useMessageListScroll`, which is the
 * right answer for "did the user see the newest message" but the wrong one for any
 * check on the hook's own correctness. A detector reading that boolean cannot
 * disagree with the hook, so it goes silent precisely when the hook is wrong.
 *
 * This registers the scroll ELEMENT instead, so a caller can measure the viewport
 * itself and reach a verdict the hook had no part in.
 *
 * Same conventions as `viewportAtBottom`: the same key shape, re-registering
 * replaces (view remount), unregistering only drops the slot it still owns, and an
 * unknown id yields nothing rather than a fabricated measurement.
 *
 * The REF OBJECT is registered, not the element, for the same reason
 * `viewportAtBottom` does it: the element does not exist when the registering effect
 * first runs if the list mounts later than its view, and keying the effect on
 * something that changes when the element appears would re-register on every
 * message. Reading `.current` at measure time sidesteps both.
 *
 * @module Utils/ViewportScroller
 */
import type { ViewportKind } from './viewportAtBottom'

interface ElementRef {
  current: HTMLElement | null
}

const scrollers = new Map<string, ElementRef>()

function key(kind: ViewportKind, id: string): string {
  return `${kind}:${id}`
}

/**
 * Register a view's scroll-element ref. Returns an unregister function for effect
 * cleanup. Re-registering the same key replaces the previous ref.
 */
export function registerViewportScroller(
  kind: ViewportKind,
  id: string,
  ref: ElementRef,
): () => void {
  const k = key(kind, id)
  scrollers.set(k, ref)
  return () => {
    // Only drop it if we still own the slot — a remount may have replaced it.
    if (scrollers.get(k) === ref) scrollers.delete(k)
  }
}

/** One independent measurement of a view's scroll viewport. */
export interface ViewportMetrics {
  /** Pixels between the viewport bottom and the content bottom. */
  distFromBottom: number
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

/**
 * Measure a registered viewport, right now.
 *
 * @returns `null` when nothing is registered for `id`, or when the element has been
 * detached from the document. A detached element reports zeros for every metric,
 * which would read as "pinned to the bottom" — a confident wrong answer, and worse
 * than admitting we cannot see.
 */
export function measureViewport(kind: ViewportKind, id: string): ViewportMetrics | null {
  const element = scrollers.get(key(kind, id))?.current
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

/** Test-only: drop all registrations. */
export function _resetViewportScrollerRegistryForTesting(): void {
  scrollers.clear()
}
