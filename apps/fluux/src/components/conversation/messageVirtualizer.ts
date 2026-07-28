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
  /** The slice to render: visible range + overscan, each with its start offset. */
  getVirtualItems(): VirtualWindowItem[]
  /** Stable estimated total content height. Equals the scroll container's scrollHeight
   *  (the content wrapper is rendered at this height), so scrollHeight-based behaviors
   *  keep working unchanged. */
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
   * Start an ANIMATED scroll to `offset` and hand the virtualizer's own pending-scroll state
   * over to it. Use this — never a raw `scroller.scrollTo({ behavior: 'smooth' })` — for any
   * animated position the app owns on the virtualized path.
   *
   * Why it exists: @tanstack keeps a pending-scroll reconciler alive for several seconds after
   * every scrollToIndex/scrollToOffset and re-applies ITS target on every frame that
   * measurement moves it. That reconciler is invisible to the positioning controller's
   * generations, so a superseded live-edge pin can still snap the list back to the bottom in
   * the middle of a newer animation (worst on a slow engine, where rows are still measuring for
   * the first time). Retargeting the reconciler is what makes the animation survive; it also
   * suppresses @tanstack's own size-change scroll adjustments for the animation's duration.
   *
   * Distinct from `scrollToOffset(offset, { behavior: 'smooth' })`: that variant additionally
   * pushes the target into @tanstack's offset callback so the window re-renders before paint,
   * which is right for an instant write but wrong for an animation — it would claim the
   * scroller had already arrived, re-windowing to the destination while the view is still at
   * the origin (and retiring the reconciler immediately). Here the offset is left to be
   * observed as the animation runs.
   */
  beginAnimatedScrollToOffset(offset: number): void
}
