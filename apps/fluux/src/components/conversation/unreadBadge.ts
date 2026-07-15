/**
 * Scroll-to-bottom FAB badge count.
 *
 * The badge shows how many "new" messages — those from the first-new-message divider to the end of
 * the loaded list — are still BELOW the bottom edge of the viewport, i.e. not yet scrolled into
 * view. It therefore counts DOWN as the reader scrolls toward the present and reaches 0 exactly when
 * the newest message is on screen (at which point the divider anchor clears anyway).
 *
 * This is deliberately viewport-relative, unlike a plain "unread since the divider" total: the FAB
 * is a "jump to what you haven't seen yet" affordance, so the number should track what remains below
 * the fold rather than stay pinned at the total until the very bottom.
 *
 * @param messages          The (deduplicated) rendered message list, in chronological order.
 * @param firstNewMessageId The divider anchor — first unread message. Undefined ⇒ no new block ⇒ 0.
 * @param bottomVisibleId   The bottom-most message whose top is within the viewport (from the scroll
 *                          hook). `null` means no scroll has been observed yet (fresh open scrolled
 *                          up), so the full new-message count is reported until the first scroll.
 */
export function countNewBelowViewport<T extends { id?: string }>(
  messages: readonly T[],
  firstNewMessageId: string | undefined,
  bottomVisibleId: string | null,
): number {
  if (!firstNewMessageId) return 0
  const markerIdx = messages.findIndex((m) => m.id === firstNewMessageId)
  if (markerIdx === -1) return 0

  // Full count of the new-message block (marker → end). Used before any scroll is observed and
  // whenever the viewport bottom sits at or above the divider.
  const total = messages.length - markerIdx
  if (!bottomVisibleId) return total

  const bottomIdx = messages.findIndex((m) => m.id === bottomVisibleId)
  // Bottom-visible row not in the current window (sliding-window DOM trim): fall back to the full
  // count. Transient and rare; matches the pre-scroll behaviour rather than flashing a wrong number.
  if (bottomIdx === -1) return total

  // Messages strictly below the bottom-visible one, clamped to the new-message block. When the
  // bottom-visible message is at or above the divider this is the full count; when the newest
  // message is visible it is 0.
  const belowStart = Math.max(bottomIdx + 1, markerIdx)
  return Math.max(0, messages.length - belowStart)
}
