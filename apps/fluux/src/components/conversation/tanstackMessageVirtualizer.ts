import { useCallback } from 'react'
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
    scrollToOffset: (offset, opts) => virtualizer.scrollToOffset(offset, opts),
    scrollToIndex: (index, opts) => virtualizer.scrollToIndex(index, opts),
  }
}
