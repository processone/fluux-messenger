/**
 * Registry for the currently-mounted conversation message list, so code outside the
 * list (message-target helpers and ChatLayout's Escape handler) can reach the active
 * list without threading it through every caller.
 *
 * Why this exists: positioning ownership lives with the active message list. Callers such as reply
 * quotes, poll banners, and find-on-page submit a semantic target through `requestMessageTarget`;
 * they must not start independent DOM/rAF scroll implementations outside the generation-aware
 * positioning controller. `scrollToBottom` is registered for ChatLayout's conversation-level
 * Escape handling.
 *
 * There is a single active conversation list at a time (ChatView / RoomView render one), so a
 * module-level singleton is sufficient. The list clears its registration on unmount (identity-
 * checked, so a fast conversation switch can't clobber the newly mounted list's registration).
 *
 * Static previews (SearchContextView, StrangerRequestPreviewView) deliberately do NOT register:
 * several of them can be mounted at once beside the live list, and this registry holds only one,
 * so registering them would make routing depend on render order. Callers rendered inside any list
 * route by containment through `messageTargetContext` instead.
 */
export interface ActiveMessageListController {
  /** Submit an explicit message target to the active list's positioning controller. */
  requestMessageTarget(id: string): void
  /** Scroll the active list to the newest message (same action as the ⌘/Ctrl+↓ shortcut
   *  and the scroll-to-bottom FAB). */
  scrollToBottom(): void
}

let active: ActiveMessageListController | null = null

export function setActiveMessageListController(controller: ActiveMessageListController | null): void {
  active = controller
}

export function getActiveMessageListController(): ActiveMessageListController | null {
  return active
}
