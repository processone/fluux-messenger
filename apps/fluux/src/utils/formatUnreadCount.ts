/**
 * The ONE shared formatter every numeric unread surface renders
 * through — the sidebar counter (`ConversationList`), the "New messages" divider
 * (`NewMessageMarker`), the floating marker pill (`JumpToLastReadPill`), the scroll-to-bottom
 * FAB badge (`MessageList`), the room row tooltip (`utils/roomTooltip.ts`), and the coalesced
 * conversation notification title (`useDesktopNotifications`). Routing every surface through
 * this single function is what guarantees they render the canonical count identically — a
 * per-surface literal (e.g. a stray `> 99 ? '99+' : n`) is exactly the drift this design
 * removes.
 *
 * The store caps the persisted count at 999 (see chatStore/roomStore's recount + on-arrival
 * paths, both `Math.min(999, ...)`) and never reaches 1000. The threshold is therefore
 * `n >= 999`, NOT `n > 999`: with `>`, a genuinely saturated count of exactly 999 (which could
 * mean "999 or far more") would render as the exact number "999" instead of "999+".
 */
export function formatUnreadCount(n: number): string {
  return n >= 999 ? '999+' : String(n)
}
