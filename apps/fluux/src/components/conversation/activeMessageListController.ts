/**
 * Registry for the currently-mounted conversation message list, so DOM-based jump helpers
 * (notably `scrollToMessage` in messageGrouping.ts — reply-quote taps, find-on-page, poll and
 * reaction jumps) can reach the active virtualizer without threading it through every caller.
 *
 * Why this exists: under virtualization the target row of an in-conversation jump may be OUTSIDE
 * the mounted DOM window, so a raw `querySelector('[data-message-id]')` finds nothing and the jump
 * silently no-ops. The active list registers a tiny controller here; the helper asks it to window
 * the row in first, then the DOM read + scrollIntoView succeed. Non-virtualized lists keep every
 * row mounted, so they register no controller and the helper's plain DOM path works unchanged.
 *
 * There is a single active conversation list at a time (ChatView / RoomView render one), so a
 * module-level singleton is sufficient. The list clears its registration on unmount (identity-
 * checked, so a fast conversation switch can't clobber the newly mounted list's registration).
 */
export interface ActiveMessageListController {
  /** True when `id` is in the loaded item set (resolvable by the virtualizer index), whether or
   *  not its row is currently mounted. */
  hasMessage(id: string): boolean
  /** Window the (possibly unmounted) row for `id` into the virtualizer's mounted set so a
   *  subsequent DOM query can find it. No-op when `id` isn't in the item set. */
  ensureMessageMounted(id: string): void
}

let active: ActiveMessageListController | null = null

export function setActiveMessageListController(controller: ActiveMessageListController | null): void {
  active = controller
}

export function getActiveMessageListController(): ActiveMessageListController | null {
  return active
}
