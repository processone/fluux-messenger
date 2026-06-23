import { useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { MessageListItem, MessageVirtualizer } from './messageVirtualizer'

interface Args<T extends { id: string }> {
  items: MessageListItem<T>[]
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
export function useTanstackMessageVirtualizer<T extends { id: string }>({
  items, indexById, scrollRef, estimateSize = 64,
}: Args<T>): MessageVirtualizer {
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
    getOffsetForMessageId,
    ensureMessageMounted,
    measureElement: virtualizer.measureElement,
  }
}
