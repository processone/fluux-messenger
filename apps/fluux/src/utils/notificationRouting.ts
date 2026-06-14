/**
 * Route a notification activation to the right view.
 *
 * Shared by every notification click source so routing logic lives in one
 * place: the desktop `notification-activated` Tauri event, the cold-start
 * drain, and the mobile `onAction` path.
 */
export interface NotificationNavigators {
  navigateToConversation: (id: string) => void
  navigateToRoom: (jid: string) => void
}

export function routeNotificationTarget(
  navType: string | undefined,
  navTarget: string | undefined,
  nav: NotificationNavigators,
): void {
  if (!navTarget) return
  if (navType === 'room') {
    nav.navigateToRoom(navTarget)
  } else {
    nav.navigateToConversation(navTarget)
  }
}
