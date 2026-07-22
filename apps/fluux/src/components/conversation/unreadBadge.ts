/**
 * Scroll-to-bottom FAB badge count.
 *
 * The badge shows how many "new" messages — those from the first-new-message divider to the end of
 * the loaded list — are still BELOW the reader's deepest-read position (the persisted read pointer
 * `readPointerId`). It therefore counts DOWN as the reader reads toward the present and reaches 0
 * once the read pointer reaches the newest message. Because the pointer is forward-only, the count
 * holds when the reader scrolls back up rather than climbing again.
 *
 * This is deliberately read-relative, unlike a plain "unread since the divider" total: the FAB is a
 * "jump to what you haven't read yet" affordance, so the number tracks what remains unread rather
 * than staying pinned at the total until the very bottom.
 *
 * @param messages          The (deduplicated) rendered message list, in chronological order.
 * @param firstNewMessageId The divider anchor — first unread message. Undefined ⇒ no new block ⇒ 0.
 * @param readAnchorId      The deepest message considered read (the read pointer `readPointerId`);
 *                          unread is everything strictly after it. `null` before any read position is
 *                          known, in which case the full new-message count is reported.
 */
export function countNewBelowViewport<T extends { id?: string }>(
  messages: readonly T[],
  firstNewMessageId: string | undefined,
  readAnchorId: string | null,
): number {
  if (!firstNewMessageId) return 0
  const markerIdx = messages.findIndex((m) => m.id === firstNewMessageId)
  if (markerIdx === -1) return 0

  // Full count of the new-message block (marker → end). Used before any read position is known and
  // whenever the read pointer sits at or above the divider.
  const total = messages.length - markerIdx
  if (!readAnchorId) return total

  const anchorIdx = messages.findIndex((m) => m.id === readAnchorId)
  // Read anchor not in the current window (sliding-window DOM trim): fall back to the full count.
  // Transient and rare; matches the pre-read behaviour rather than flashing a wrong number.
  if (anchorIdx === -1) return total

  // Messages strictly below the read anchor, clamped to the new-message block. When the anchor is at
  // or above the divider this is the full count; when the pointer is at the newest message it is 0.
  const belowStart = Math.max(anchorIdx + 1, markerIdx)
  return Math.max(0, messages.length - belowStart)
}
