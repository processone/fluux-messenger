/**
 * Viewport scroller registry.
 *
 * A sibling of `viewportAtBottom.ts`, and deliberately not a field on it: that one
 * registers the at-bottom BOOLEAN maintained by `useMessageListScroll`, which is the
 * right answer for "did the user see the newest message" but the wrong one for any
 * check on the hook's own correctness. A detector reading that boolean cannot
 * disagree with the hook, so it goes silent precisely when the hook is wrong.
 *
 * This registers the list's handle instead, so a caller can measure the viewport
 * itself and reach a verdict the hook had no part in.
 *
 * Same conventions as `viewportAtBottom`: the same key shape, re-registering
 * replaces (view remount), unregistering only drops the slot it still owns, and an
 * unknown id yields nothing rather than a fabricated measurement.
 *
 * The REF OBJECT is registered, not the handle, for the same reason
 * `viewportAtBottom` does it: the handle does not exist when the registering effect
 * first runs if the list mounts later than its view, and keying the effect on
 * something that changes when the element appears would re-register on every
 * message. Reading `.current` at measure time sidesteps both.
 *
 * @module Utils/ViewportScroller
 */
import type { ViewportKind } from './viewportAtBottom'
import type { ViewportMetrics } from './viewportMetrics'

export type { ViewportMetrics }

/** What the registry needs from a list: an independent geometry reading of its viewport. */
interface ViewportMeasurer {
  measureViewport(): ViewportMetrics | null
}

interface MeasurerRef {
  readonly current: ViewportMeasurer | null
}

const scrollers = new Map<string, MeasurerRef>()

function key(kind: ViewportKind, id: string): string {
  return `${kind}:${id}`
}

/**
 * Register a view's message-list handle ref. Returns an unregister function for effect
 * cleanup. Re-registering the same key replaces the previous ref.
 */
export function registerViewportScroller(
  kind: ViewportKind,
  id: string,
  ref: MeasurerRef,
): () => void {
  const k = key(kind, id)
  scrollers.set(k, ref)
  return () => {
    // Only drop it if we still own the slot — a remount may have replaced it.
    if (scrollers.get(k) === ref) scrollers.delete(k)
  }
}

/**
 * Measure a registered view's viewport, right now.
 *
 * @returns `null` when nothing is registered for `id`, or when its list cannot measure.
 */
export function measureViewport(kind: ViewportKind, id: string): ViewportMetrics | null {
  return scrollers.get(key(kind, id))?.current?.measureViewport() ?? null
}

/** Test-only: drop all registrations. */
export function _resetViewportScrollerRegistryForTesting(): void {
  scrollers.clear()
}
