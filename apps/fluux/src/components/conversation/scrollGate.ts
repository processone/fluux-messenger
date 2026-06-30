/**
 * scrollGate - discriminating a genuine user scroll from a programmatic / measurement-settle one.
 *
 * The save gate (userHasScrolledSinceEntryRef) opens on a "genuine user scroll", detected as
 * `!programmatic && content-height-unchanged` (a wheel/touch/scrollbar-drag leaves the height
 * unchanged; a media/measurement shift changes it). Marking programmatic only as "a re-assert loop
 * is currently running" left a hole: the virtualizer's measurement settle fires a scroll event a few
 * frames AFTER a one-shot restore, or just after the re-pin loop ends — no loop running, height
 * unchanged — so it looked exactly like a scrollbar drag and wrongly opened the gate. The drifted
 * settle position was then persisted and restored next time, creeping older on every re-open.
 */

/**
 * Window after a programmatic scroll write during which subsequent scroll events are still treated
 * as programmatic — long enough to cover the post-write measurement settle, short enough not to
 * swallow a genuine scroll the user makes shortly after entering a conversation.
 */
export const PROGRAMMATIC_SETTLE_MS = 250

/**
 * Whether a scroll event should be treated as programmatic (NOT a genuine user scroll): a re-assert
 * loop currently owns scrollTop, OR a programmatic scroll write happened within the last
 * PROGRAMMATIC_SETTLE_MS (so this is its settle, not the user).
 */
export function isProgrammaticScroll(
  reassertLoopActive: boolean,
  now: number,
  lastProgrammaticScrollAt: number,
): boolean {
  return reassertLoopActive || now - lastProgrammaticScrollAt < PROGRAMMATIC_SETTLE_MS
}
