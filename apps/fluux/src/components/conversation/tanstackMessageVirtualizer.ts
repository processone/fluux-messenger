import { useCallback, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { MessageVirtualizer } from './messageVirtualizer'

// Frames the offset must hold steady before we declare scrolling settled and stop polling
// (~100ms at 60fps — close to @tanstack's default 150ms isScrollingResetDelay).
const OFFSET_POLL_IDLE_FRAMES = 6

/**
 * Drop-in replacement for @tanstack/react-virtual's `observeElementOffset` that re-windows from a
 * requestAnimationFrame poll of `scrollTop`, not only from the element's `scroll` event.
 *
 * WHY: the default observer updates the virtualizer's offset (and thus the mounted window) ONLY
 * when the scroll element fires a `scroll` event. WebKit — the Tauri desktop webview — coalesces
 * or withholds `scroll` events during INERTIAL ("kinetic") momentum scrolling: the layer scrolls
 * on the compositor while JS sees no event. With the default observer the mounted window then
 * freezes mid-fling, so the same rows render as the user scrolls (the "looping images" report).
 * Chromium fires `scroll` promptly during inertia, so it never shows the bug — and the headless
 * preview/Playwright harness can't reproduce momentum at all.
 *
 * HOW: keep the `scroll` listener (so the Chromium path is unchanged) but, once a gesture starts
 * (scroll / wheel / touch), poll `scrollTop` every frame and push each change into the virtualizer.
 * The poll stops after the offset is stable for OFFSET_POLL_IDLE_FRAMES, so it runs only during an
 * active scroll. It is strictly READ-ONLY (never writes scrollTop) so it cannot feed back into the
 * scroll-correction loops. Same `(instance, cb) => cleanup` contract as the @tanstack default.
 */
export function observeElementOffsetWithRaf(
  instance: { scrollElement: HTMLElement | null },
  cb: (offset: number, isScrolling: boolean) => void,
): void | (() => void) {
  const el = instance.scrollElement
  if (!el) return

  let rafId: number | null = null
  let lastOffset = el.scrollTop
  let idleFrames = 0

  const tick = () => {
    const offset = el.scrollTop
    if (offset !== lastOffset) {
      lastOffset = offset
      idleFrames = 0
      cb(offset, true)
    } else if (++idleFrames >= OFFSET_POLL_IDLE_FRAMES) {
      rafId = null
      cb(offset, false) // scrolling settled — resume measurement adjustments
      return
    }
    rafId = requestAnimationFrame(tick)
  }

  const startPolling = () => {
    if (rafId === null) {
      idleFrames = 0
      rafId = requestAnimationFrame(tick)
    }
  }

  const onScroll = () => {
    lastOffset = el.scrollTop
    cb(lastOffset, true)
    startPolling()
  }

  el.addEventListener('scroll', onScroll, { passive: true })
  // Momentum initiators: WebKit may suppress the `scroll` event during the inertial phase, so
  // begin polling the moment the gesture starts rather than waiting for a `scroll` that won't come.
  el.addEventListener('wheel', startPolling, { passive: true })
  el.addEventListener('touchmove', startPolling, { passive: true })

  return () => {
    el.removeEventListener('scroll', onScroll)
    el.removeEventListener('wheel', startPolling)
    el.removeEventListener('touchmove', startPolling)
    if (rafId !== null) cancelAnimationFrame(rafId)
  }
}

interface Args {
  /** Only the stable `key` per row is needed — the adapter is agnostic to item kind
   *  (date/message/header/footer all window uniformly). The caller renders by kind. */
  items: readonly { key: string }[]
  indexById: Map<string, number>
  scrollRef: React.RefObject<HTMLElement | null>
  /** Flat constant (px) or a per-index function. Default: 64. A fresh closure each render would
   *  invalidate @tanstack's size cache — the adapter wraps it in a stable ref+useCallback. */
  estimateSize?: number | ((index: number) => number)
  /**
   * Pre-seeded measured heights from a previous mount of this conversation.
   * Keys are item keys (= message ids). Passed as @tanstack's `initialMeasurementsCache` so
   * resident rows start at their real height rather than snapping from estimates on re-entry.
   */
  initialMeasurements?: ReadonlyMap<string, number>
  /**
   * Called after each row measurement with its key and measured size (px > 0 only).
   * Used to write back to the persistent height cache.
   */
  onMeasured?: (key: string, size: number) => void
}

/**
 * MessageVirtualizer backed by @tanstack/react-virtual (v3). Spike-gated: if prepend
 * anchoring can't be made pixel-accurate (Task 5), this is swapped for a custom impl
 * behind the same interface, leaving the scroll-hook integration untouched.
 *
 * `getItemKey = items[i].key` (the message id) binds the measurement cache to the message,
 * not the index, so it survives MAM prepend (which shifts every index).
 */
export function useTanstackMessageVirtualizer({
  items, indexById, scrollRef, estimateSize = 64, initialMeasurements, onMeasured,
}: Args): MessageVirtualizer {
  // NOTE: a measured running-average `estimateSize` was tried (to tighten the MAM-prepend
  // immediate restore, whose prepended rows are unmeasured) but REMOVED — it fed back at the
  // bottom (the trailing footer/empty items drag the average down each render) and collapsed
  // getTotalSize, which made scroll-to-bottom (`scrollTop = scrollHeight`) land in the middle
  // of the conversation. A constant estimate keeps getTotalSize stable; the prepend restore
  // stays accurate via getOffsetForMessageId + the scroll hook's per-frame re-assert, which
  // re-reads the offset as the prepended rows measure.
  // @tanstack hands its offset callback to `observeElementOffset` on (re)mount; we stash it so a
  // PROGRAMMATIC scroll (scrollToOffset) can re-window by pushing the new offset straight into it
  // with isScrolling=false — a non-sync notify that routes through the adapter's plain rerender()
  // instead of flushSync. A synthetic `scroll` DOM event would instead drive isScrolling=true →
  // flushSync, which explodes ("flushSync from inside a lifecycle method") when scrollToOffset is
  // called from the MAM-prepend restore useLayoutEffect, spamming a render-loop storm. See scrollToOffset.
  const offsetCbRef = useRef<((offset: number, isScrolling: boolean) => void) | null>(null)
  const observeOffset = useCallback(
    (instance: { scrollElement: HTMLElement | null }, cb: (offset: number, isScrolling: boolean) => void) => {
      offsetCbRef.current = cb
      const cleanup = observeElementOffsetWithRaf(instance, cb)
      return () => {
        offsetCbRef.current = null
        cleanup?.()
      }
    },
    [],
  )

  // Keep a stable estimateSize callback identity; @tanstack re-reads it, and a fresh closure each
  // render would invalidate its size cache. The ref always points at the latest caller value.
  const estimateRef = useRef(estimateSize)
  estimateRef.current = estimateSize
  const estimateFn = useCallback(
    (index: number) => {
      const e = estimateRef.current
      return typeof e === 'function' ? e(index) : e
    },
    [],
  )

  // Build @tanstack's `initialMeasurementsCache` once at mount from the caller-supplied map.
  // VirtualItem shape: { key, index, start, end, size, lane }
  // start/end/lane can be 0 — @tanstack recomputes layout offsets from scratch; size is all that
  // matters for the seed. Only build if initialMeasurements is non-empty (additive; empty cache
  // leaves behavior byte-identical to the pre-feature state).
  // Use a ref so it is evaluated once (at mount) without needing eslint-disable on empty deps.
  const initialMeasurementsCacheRef = useRef<Array<{ key: string | number; index: number; start: number; end: number; size: number; lane: number }> | undefined>(undefined)
  if (initialMeasurementsCacheRef.current === undefined && initialMeasurements && initialMeasurements.size > 0) {
    const result: Array<{ key: string | number; index: number; start: number; end: number; size: number; lane: number }> = []
    for (let i = 0; i < items.length; i++) {
      const key = items[i].key
      const size = initialMeasurements.get(key)
      if (size !== undefined && size > 0) {
        result.push({ key, index: i, start: 0, end: 0, size, lane: 0 })
      }
    }
    if (result.length > 0) initialMeasurementsCacheRef.current = result
  }

  // Keep a stable ref to onMeasured so the measureElement wrapper never changes identity.
  const onMeasuredRef = useRef(onMeasured)
  onMeasuredRef.current = onMeasured

  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateFn,
    getItemKey: (index) => items[index].key,
    overscan: 12,
    // rAF-polled offset observer so the window keeps advancing during WebKit inertial momentum,
    // when the desktop webview withholds `scroll` events (the "looping rows" bug). See the fn doc.
    observeElementOffset: observeOffset,
    ...(initialMeasurementsCacheRef.current !== undefined ? { initialMeasurementsCache: initialMeasurementsCacheRef.current } : {}),
  })

  const getOffsetForMessageId = useCallback((id: string): number | null => {
    const index = indexById.get(id)
    if (index == null) return null
    // getOffsetForIndex(.., 'start') returns the row's start offset from the content top,
    // covering measured AND estimated rows (the private getMeasurements is not exposed). It
    // is clamped to the scrollable range, which only diverges from the raw start for rows in
    // the final viewport — the bottom-anchor path reads getVirtualItems() directly instead.
    return virtualizer.getOffsetForIndex(index, 'start')?.[0] ?? null
  }, [indexById, virtualizer])

  const ensureMessageMounted = useCallback((id: string): Promise<void> => {
    const index = indexById.get(id)
    if (index == null) return Promise.resolve()
    virtualizer.scrollToIndex(index, { align: 'center' })
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
  }, [indexById, virtualizer])

  return {
    getVirtualItems: () =>
      virtualizer.getVirtualItems().map((v) => ({ index: v.index, start: v.start, size: v.size, key: String(v.key) })),
    getTotalSize: () => virtualizer.getTotalSize(),
    itemCount: items.length,
    getOffsetForMessageId,
    ensureMessageMounted,
    // Wrap measureElement to intercept sizes measured by @tanstack's ResizeObserver and report
    // them to the persistent height cache via onMeasured. After @tanstack measures the element it
    // updates measurementsCache synchronously; we read the entry keyed by the element's index.
    // Only sizes > 0 are forwarded (matches recordMeasuredHeight's guard).
    measureElement: (element: Element | null) => {
      virtualizer.measureElement(element)
      if (!element || !onMeasuredRef.current) return
      const index = virtualizer.indexFromElement(element as HTMLElement)
      if (index < 0 || index >= items.length) return
      // Read the post-measure size from @tanstack's measurementsCache. This is synchronously
      // updated by measureElement when called from the ResizeObserver path, and available as
      // `virtualizer.measurementsCache[index].size`. Use getVirtualItems() snapshot to avoid
      // relying on a private field — but measurementsCache IS public (declared on the class).
      const cached = virtualizer.measurementsCache[index]
      if (cached && cached.size > 0) {
        onMeasuredRef.current(String(items[index].key), cached.size)
      }
    },
    scrollToOffset: (offset, opts) => {
      virtualizer.scrollToOffset(offset, opts)
      // @tanstack updates its reactive scrollOffset ONLY from the scroll element's 'scroll' DOM
      // event (observeElementOffset). scrollToOffset sets the DOM scrollTop (via _scrollToOffset)
      // but leaves scrollOffset stale until that event fires. The MAM-prepend restore calls this
      // from a useLayoutEffect right after a count change; the browser's pending scroll event does
      // not re-window before paint, so the mounted window keeps the old (top) rows and the viewport
      // renders BLANK until the user scrolls again. Push the restored offset straight into
      // @tanstack's offset callback with isScrolling=false: this updates scrollOffset and
      // recalculates the window synchronously (re-windowed before paint, same as the old synthetic
      // scroll dispatch) BUT routes through the adapter's plain rerender() rather than flushSync.
      // A synthetic `scroll` event would hardcode isScrolling=true → flushSync → "flushSync from
      // inside a lifecycle method" + a render-loop storm when called during the layout-effect commit.
      offsetCbRef.current?.(offset, false)
    },
    scrollToIndex: (index, opts) => {
      virtualizer.scrollToIndex(index, opts)
      // Same scrollOffset-desync guard as scrollToOffset above, on the stick-to-bottom path.
      // @tanstack's scrollToIndex sets the DOM scrollTop (via _scrollToOffset → scrollToFn) but
      // leaves its reactive scrollOffset stale until the scroll element's native 'scroll' event
      // fires. On Tauri WebKit that event is withheld/coalesced for a programmatic scroll, so the
      // mounted window never re-windows and a just-appended bottom row (new message — send OR
      // receive, via pinVirtualizedBottom) is never windowed in: the view fails to stick to the
      // bottom. Push the landed scrollTop straight into @tanstack's offset callback with
      // isScrolling=false (non-sync, plain rerender — NOT a synthetic scroll event, which would
      // flushSync mid-commit) to re-window before paint. Chromium fires the native event promptly
      // so this is a redundant no-op there; the bug is WebKit-only (not reproducible in Playwright).
      const el = scrollRef.current
      if (el) offsetCbRef.current?.(el.scrollTop, false)
    },
  }
}
