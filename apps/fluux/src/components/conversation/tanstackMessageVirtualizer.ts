import { useCallback } from 'react'
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
  estimateSize?: number
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
  items, indexById, scrollRef, estimateSize = 64,
}: Args): MessageVirtualizer {
  // NOTE: a measured running-average `estimateSize` was tried (to tighten the MAM-prepend
  // immediate restore, whose prepended rows are unmeasured) but REMOVED — it fed back at the
  // bottom (the trailing footer/empty items drag the average down each render) and collapsed
  // getTotalSize, which made scroll-to-bottom (`scrollTop = scrollHeight`) land in the middle
  // of the conversation. A constant estimate keeps getTotalSize stable; the prepend restore
  // stays accurate via getOffsetForMessageId + the scroll hook's per-frame re-assert, which
  // re-reads the offset as the prepended rows measure.
  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    getItemKey: (index) => items[index].key,
    overscan: 12,
    // rAF-polled offset observer so the window keeps advancing during WebKit inertial momentum,
    // when the desktop webview withholds `scroll` events (the "looping rows" bug). See the fn doc.
    observeElementOffset: observeElementOffsetWithRaf,
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
    measureElement: virtualizer.measureElement,
    scrollToOffset: (offset, opts) => {
      virtualizer.scrollToOffset(offset, opts)
      // @tanstack updates its reactive scrollOffset ONLY from the scroll element's
      // 'scroll' DOM event (observeElementOffset). scrollToOffset sets the DOM
      // scrollTop (via _scrollToOffset) but leaves scrollOffset stale until that
      // event fires. The MAM-prepend restore calls this from a useLayoutEffect
      // right after a count change; the browser's pending scroll event does not
      // re-window before paint, so the mounted window keeps the old (top) rows and
      // the viewport renders BLANK until the user scrolls again. Dispatch the event
      // synchronously so the virtualizer re-reads scrollTop and re-windows to match
      // — the same sync a real user scroll performs.
      scrollRef.current?.dispatchEvent(new Event('scroll'))
    },
    scrollToIndex: (index, opts) => virtualizer.scrollToIndex(index, opts),
  }
}
