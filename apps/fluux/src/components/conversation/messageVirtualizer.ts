/**
 * MessageVirtualizer — the facts the imperative scroll hook (useMessageListScroll)
 * needs about messages, for mounted AND unmounted rows alike. This interface is the
 * stable boundary: it is implemented with @tanstack/react-virtual today, but can be
 * swapped for a custom implementation without touching the scroll-hook integration.
 *
 * See docs/superpowers/specs/2026-06-23-message-view-virtualization-design.md
 */

export type MessageListItem<T extends { id: string }> =
  | { kind: 'date'; key: string; date: string }
  | {
      kind: 'message'
      key: string
      message: T
      showAvatar: boolean
      isFirstNew: boolean
      /** Index of this message within its date group, and the group's message array —
       *  both needed to call the caller's renderMessage(msg, idx, groupMessages, ...). */
      indexInGroup: number
      groupMessages: T[]
    }

export interface VirtualWindowItem {
  index: number
  start: number
  size: number
  key: string
}

export interface MessageVirtualizer {
  cancelPendingScroll?(): void
  refreshEstimates?(): void
  retainMessage?(id: string | null): void
  /**
   * Watch the virtualizer's own scroll writes. Returning `false` from a `before` phase refuses
   * that write — for a `navigation` or `reconcile` source only.
   *
   * A `measurement` write cannot be refused: it carries the correction for a row that measured
   * taller than its estimate above the reader, and the library counts that correction as applied
   * the moment it asks for the write. Declining one strands the reader below the live edge for
   * good. Suppress adjustments with `setAutomaticScrollAdjustmentEnabled` instead, which stops
   * them before they are counted.
   */
  setScrollWriteObserver?(observer: ((write: {
    phase: 'before-measure' | 'before' | 'after'
    source: 'navigation' | 'measurement' | 'reconcile'
    behavior?: ScrollBehavior
  }) => boolean | void) | undefined): void
  setAutomaticScrollAdjustmentEnabled?(enabled: boolean): void
  /** Rows to render: visible range, overscan, and any retained message, with start offsets. */
  getVirtualItems(): VirtualWindowItem[]
  /** Total content height from measured rows and current estimates. The caller renders the
   *  content wrapper at this height so scrollHeight-based behavior follows recalibration. */
  getTotalSize(): number
  /** Total number of items (including header/footer/dates). Used for scroll-to-last. */
  itemCount: number
  /** Offset (px from content top) of a message by id, whether or not it is mounted.
   *  null when the id is not in the current item set. */
  getOffsetForMessageId(id: string): number | null
  /** Flat virtualizer index of a message by id, or null when the id is not in the current
   *  item set. Lets callers drive the measurement-aware scrollToIndex for a message row. */
  getIndexForMessageId(id: string): number | null
  /** Expand the rendered window so the row for `id` is mounted on the next commit.
   *  Callers that only need the offset should use getOffsetForMessageId and skip this. */
  ensureMessageMounted(id: string): Promise<void>
  /** Ref callback for each mounted row: measures + caches its real height. */
  measureElement: (el: Element | null) => void
  /**
   * Scroll the virtualizer's scroll element to `offset` pixels from the content top.
   * Use instead of writing `scroller.scrollTop` directly — goes through @tanstack's
   * own scroll path so its internal measurement state stays consistent.
   * behavior: 'auto' (default) = instant; 'smooth' = CSS smooth scroll.
   */
  scrollToOffset(offset: number, opts?: { behavior?: 'auto' | 'smooth' }): void
  /**
   * Scroll so that item at `index` is aligned as requested.
   * align: 'start' | 'center' | 'end' | 'auto' (default = 'auto')
   * behavior: 'auto' (instant) | 'smooth'
   */
  scrollToIndex(index: number, opts?: { align?: 'start' | 'center' | 'end' | 'auto'; behavior?: 'auto' | 'smooth' }): void
  /**
   * Start native smooth scrolling to `offset` through the virtualizer's pending-scroll state.
   * Controller-owned animation follows docs/2026-07-23-scroll-positioning-contract.md.
   */
  beginAnimatedScrollToOffset(offset: number): void
}
