/**
 * Route a notification activation to the right view.
 *
 * Shared by every notification click source so routing logic lives in one
 * place: the desktop `notification-activated` Tauri event, the pending-target
 * drain, the mobile `onAction` path, and the service worker's message to a
 * running page.
 */
export interface NotificationNavigators {
  navigateToConversation: (id: string, messageId?: string) => void
  navigateToRoom: (jid: string, messageId?: string) => void
  navigateToContactRequests?: () => void
  navigateToRoomInvitations?: () => void
}

/** The room JID of a voice-request target `room@service/nick`. */
export function voiceRequestRoom(occupantJid: string): string {
  const slash = occupantJid.indexOf('/')
  return slash === -1 ? occupantJid : occupantJid.slice(0, slash)
}

export function routeNotificationTarget(
  navType: string | undefined,
  navTarget: string | undefined,
  nav: NotificationNavigators,
  messageId?: string,
): void {
  if (!navTarget) return
  switch (navType) {
    case 'room':
      nav.navigateToRoom(navTarget, messageId)
      return
    case 'contact-request':
      nav.navigateToContactRequests?.()
      return
    case 'room-invitation':
      nav.navigateToRoomInvitations?.()
      return
    case 'voice-request':
      nav.navigateToRoom(voiceRequestRoom(navTarget), messageId)
      return
    default:
      nav.navigateToConversation(navTarget, messageId)
  }
}
