/**
 * Time-window predicate for post-write settling.
 *
 * Live-list movement attribution is owned by ViewportSession; see
 * docs/2026-07-23-scroll-positioning-contract.md.
 */

/**
 * Grace period, in milliseconds, used by this predicate after a programmatic write.
 */
export const PROGRAMMATIC_SETTLE_MS = 250

/**
 * Whether a reassert loop or its post-write grace period is active. This predicate alone does not
 * establish whether the reader moved.
 */
export function isProgrammaticScroll(
  reassertLoopActive: boolean,
  now: number,
  lastProgrammaticScrollAt: number,
): boolean {
  return reassertLoopActive || now - lastProgrammaticScrollAt < PROGRAMMATIC_SETTLE_MS
}
