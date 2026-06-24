import { useCallback, useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { MessageVirtualizer } from './messageVirtualizer'

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
  // Adaptive row-height estimate: seeded at `estimateSize`, then tracks a running average
  // of measured (mounted) rows. A constant estimate makes a large mostly-UNMEASURED array
  // drift — and MAM prepend is the worst case: it inserts rows above the viewport that are
  // never mounted (so never measured), so getTotalSize and the anchor offset are off by the
  // estimate error of every prepended row. An average that matches real rows keeps both close.
  const avgSizeRef = useRef(estimateSize)
  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => avgSizeRef.current,
    getItemKey: (index) => items[index].key,
    overscan: 12,
  })

  // Recompute the running average from the measured sizes of the mounted window after each
  // commit. Ref-only (no setState) so it never itself triggers a render; the updated estimate
  // applies to unmeasured rows on the next natural render (scroll / items change / prepend).
  useEffect(() => {
    const mounted = virtualizer.getVirtualItems()
    if (mounted.length === 0) return
    const avg = mounted.reduce((sum, it) => sum + it.size, 0) / mounted.length
    if (avg > 0) avgSizeRef.current = Math.round(avgSizeRef.current * 0.7 + avg * 0.3)
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
    getOffsetForMessageId,
    ensureMessageMounted,
    measureElement: virtualizer.measureElement,
  }
}
