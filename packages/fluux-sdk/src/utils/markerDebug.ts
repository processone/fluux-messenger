/**
 * Gated MDS / unread-marker debug logging.
 *
 * Shares the SAME runtime flag as the app's scroll trace (`[Scroll]` / `[ScrollStateManager]` /
 * `[Nav]`): enable from the devtools console with `__fluuxScrollDebug(true)`, or persist with
 * `localStorage.setItem('fluux:scroll-debug', '1')`. The SDK runs in the same window as the app, so
 * it can read that flag directly — which lets XEP-0490 (Message Displayed Synchronization) read
 * position syncs and the resulting `lastSeenMessageId` / unread-marker mutations show up INLINE with
 * the scroll/navigation decisions they influence.
 *
 * Why this matters for scroll: a conversation's `firstNewMessageId` divider is derived from
 * `lastSeenMessageId` at activation. XEP-0490 advances `lastSeenMessageId` from OTHER devices'
 * read positions (applyRemoteDisplayed). When a remote read-sync lands at/just-before entry, the
 * divider shrinks or disappears, and the message-list scroll logic switches branch (scroll-to-marker
 * → scroll-to-bottom / restore), which surfaces as a "jumped to the bottom" or "wrong position" on
 * return. Tag: `[MDS]`. Read the unified trace top-to-bottom:
 *   [Nav] → [MDS] → [ScrollStateManager] → [Scroll].
 *
 * No-op (and near-zero cost at call sites that pre-check {@link isMarkerDebugEnabled}) when off.
 */

export function isMarkerDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const w = window as Window & { __fluuxScrollDebugOn?: boolean }
    if (w.__fluuxScrollDebugOn) return true
    return window.localStorage?.getItem('fluux:scroll-debug') === '1'
  } catch {
    return false
  }
}

export function markerDebugLog(action: string, data?: Record<string, unknown>): void {
  if (!isMarkerDebugEnabled()) return
  console.log(`[MDS] ${action}`, data ?? '')
}
