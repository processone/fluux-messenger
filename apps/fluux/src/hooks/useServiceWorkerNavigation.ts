import { useEffect, useRef } from 'react'
import { useNavigateToTarget } from './useNavigateToTarget'
import { handleNotificationNavigateMessage } from '@/utils/notificationNavigation'

/**
 * Route the app when the user clicks a web-push notification while the app is
 * already running (warm or backgrounded/frozen).
 *
 * The service worker (`sw.ts`) posts a `notification-navigate` message to the
 * focused client; this hook forwards it to `useNavigateToTarget`, which routes
 * via React Router AND hydrates the message cache so the target view never
 * renders empty. Going through the app's own router is reliable on Android,
 * where `WindowClient.navigate()` to a hash route is not.
 *
 * The cold-start case (app was killed, no live client) is handled separately by
 * the URL the service worker opens via `clients.openWindow()`.
 */
export function useServiceWorkerNavigation(): void {
  const nav = useNavigateToTarget()

  // Keep the latest navigation functions in a ref so the message listener is
  // attached once (they are new identities each render).
  const navRef = useRef(nav)
  useEffect(() => {
    navRef.current = nav
  })

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const container = navigator.serviceWorker
    const onMessage = (event: MessageEvent) => {
      handleNotificationNavigateMessage(event.data, {
        navigateToConversation: (jid) => navRef.current.navigateToConversation(jid),
        navigateToRoom: (jid) => navRef.current.navigateToRoom(jid),
      })
    }
    container.addEventListener('message', onMessage)
    return () => container.removeEventListener('message', onMessage)
  }, [])
}
