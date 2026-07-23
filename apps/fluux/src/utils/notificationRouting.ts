/**
 * Route a notification activation to the right view.
 *
 * Shared by every notification click source so routing logic lives in one
 * place: the desktop `notification-activated` Tauri event, the pending-target
 * drain, and the mobile `onAction` path.
 */
export interface NotificationNavigators {
  navigateToConversation: (id: string, messageId?: string) => void
  navigateToRoom: (jid: string, messageId?: string) => void
}

export function routeNotificationTarget(
  navType: string | undefined,
  navTarget: string | undefined,
  nav: NotificationNavigators,
  messageId?: string,
): void {
  if (!navTarget) return
  if (navType === 'room') {
    nav.navigateToRoom(navTarget, messageId)
  } else {
    nav.navigateToConversation(navTarget, messageId)
  }
}
