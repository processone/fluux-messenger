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

/**
 * Who a navigation write belongs to: the positioning request that decided it. `isCurrent` is true
 * while that request is still the active one, whether or not its frame loop is running, so a write
 * the library holds for an iOS fling is refused once a newer request owns the list.
 */
export interface ScrollWriteOwner {
  readonly conversationId: string
  readonly generation: number
  isCurrent(): boolean
}

/** Why a write did not happen. `reader`: the reader owns the pixels. `superseded`: a newer request
 *  or write owns the list. `dropped`: the library let go of a held write. `detached`: the list
 *  unmounted or its scroller changed. */
export type ScrollWriteRefusal = 'reader' | 'superseded' | 'dropped' | 'detached'

export type ScrollWriteOutcome =
  | { readonly status: 'applied'; readonly offset: number }
  | { readonly status: 'queued' }
  | { readonly status: 'refused'; readonly reason: ScrollWriteRefusal }

/** What a navigation write returns. A `queued` outcome changes once, to `applied` or `refused`. */
export interface ScrollWrite {
  readonly id: number
  outcome(): ScrollWriteOutcome
}

export interface MessageVirtualizer {
  cancelPendingScroll?(): void
  /** A released touch still has kinetic motion. False while a new finger owns the list. */
  hasPendingFling?(): boolean
  /**
   * Re-derive the estimates of unmeasured rows from the current metrics. Offsets read afterwards
   * use the new estimates either way; `sync` also commits the re-render before returning, which
   * a caller positioning against the rendered content height needs. A batched refresh joins
   * React's next render instead of nesting one inside the current measurement.
   */
  refreshEstimates?(sync: boolean): void
  retainMessage?(id: string | null): void
  /**
   * Watch the virtualizer's own scroll writes. Returning `false` from a `before` phase refuses
   * that write — for a `navigation` or `reconcile` source only.
   *
   * A `measurement` write cannot be refused: it carries resize compensation above the reader,
   * and the library counts that correction as applied the moment it asks for the write.
   * Declining one leaves the library's layout offset out of sync with the DOM. Suppress
   * adjustments with `setAutomaticScrollAdjustmentEnabled` instead, before they are counted.
   */
  setScrollWriteObserver?(observer: ((write: {
    phase: 'before-measure' | 'before' | 'after'
    source: 'navigation' | 'measurement' | 'reconcile'
    behavior?: ScrollBehavior
  }) => boolean | void) | undefined): void
  setAutomaticScrollAdjustmentEnabled?(enabled: boolean): void
  /**
   * Keep the row of `messageId` still on screen while rows resize, instead of the viewport top:
   * every row before it that changes height is compensated, in view or not, and rows after it are
   * not. A history restore holds its anchor so rows measuring between the viewport top and the
   * anchor cannot move what the reader is looking at. `null` returns to the adapter's ordinary
   * fold/direction policy, including shrink compensation during backward scrolling.
   * Disabled automatic adjustment still wins.
   */
  holdAnchor?(messageId: string | null): void
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
  /** Layout start of a message row (px from content top), measured or estimated, mounted or not,
   *  and NOT clamped to the scrollable range like getOffsetForMessageId: a row in the final
   *  viewport keeps its real start. null when the id is not in the current item set. */
  getMessageStart?(id: string): number | null
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
   * releaseGesture: the caller owns the pixels (a history restore after the batch landed), so
   * write now instead of waiting for an iOS drag, fling or bounce to finish.
   * Returns a receipt: `applied` with the offset the browser read back, `queued` while the library
   * holds the write for an iOS fling, or `refused` with the reason. `owner` withdraws a held write
   * whose request is no longer the active one.
   */
  scrollToOffset(offset: number, opts?: { behavior?: 'auto' | 'smooth'; releaseGesture?: boolean; owner?: ScrollWriteOwner }): ScrollWrite
  /**
   * Scroll so that item at `index` is aligned as requested.
   * align: 'start' | 'center' | 'end' | 'auto' (default = 'auto')
   * behavior: 'auto' (instant) | 'smooth'
   */
  scrollToIndex(index: number, opts?: { align?: 'start' | 'center' | 'end' | 'auto'; behavior?: 'auto' | 'smooth'; owner?: ScrollWriteOwner }): ScrollWrite
  /**
   * Start native smooth scrolling to `offset` through the virtualizer's pending-scroll state.
   * Controller-owned animation follows docs/2026-07-23-scroll-positioning-contract.md.
   */
  beginAnimatedScrollToOffset(offset: number): void
}
