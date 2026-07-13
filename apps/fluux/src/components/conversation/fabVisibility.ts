/**
 * Decide whether the scroll-to-bottom FAB should be shown for the current scroll position.
 *
 * The obvious rule — "show it once we are more than `threshold` px from the bottom" — is not enough
 * on its own. When a conversation opens at the bottom, a pin-to-bottom loop repeatedly re-measures
 * and re-pins as rows lay out. On WebKit (the Tauri desktop app / macOS WKWebView) that late
 * measurement grows scrollHeight and fires 'scroll' events reporting a transiently large
 * distFromBottom BEFORE the loop re-pins. Without a guard the FAB flips on for those frames and then
 * off again — an intermittent, timing-dependent flash on open. While the loop is actively pinning to
 * the bottom the FAB must stay hidden: the loop is settling at the bottom, so a "scroll to bottom"
 * affordance is both wrong and flickery.
 */
export function shouldShowScrollToBottomFab(
  distFromBottom: number,
  threshold: number,
  pinningToBottom: boolean,
): boolean {
  if (pinningToBottom) return false
  return distFromBottom > threshold
}
