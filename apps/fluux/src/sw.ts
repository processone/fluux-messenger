/**
 * Service Worker (sw = Service Worker)
 *
 * This file runs as a background script in the browser, separate from the main
 * application thread. It enables two key capabilities:
 *
 * 1. **Offline caching** — Workbox precaches app assets so the PWA loads
 *    without a network connection.
 *
 * 2. **Web Push notifications** — Listens for push events from the browser's
 *    push service (FCM, Mozilla, Apple) and displays OS-level notifications,
 *    even when the Fluux tab is closed or inactive.
 *
 * Built with vite-plugin-pwa's `injectManifest` strategy so that the Workbox
 * precache manifest (`self.__WB_MANIFEST`) is injected at build time.
 */
/// <reference lib="webworker" />

import { precacheAndRoute } from 'workbox-precaching'
import {
  resolveNotificationTarget,
  notificationNavigateMessage,
} from './utils/notificationNavigation'

declare const self: ServiceWorkerGlobalScope

// Workbox precaching - assets are injected at build time by vite-plugin-pwa
precacheAndRoute(self.__WB_MANIFEST)

// ============================================================================
// Web Push Notification Handler
// ============================================================================

self.addEventListener('push', (event) => {
  console.log('[SW Push] Received push event, data:', event.data?.text())
  if (!event.data) return

  let title = 'Fluux Messenger'
  let options: NotificationOptions = {
    body: 'New message',
    icon: './icon-192.png',
    badge: './icon-192.png',
  }

  try {
    const data = event.data.json()
    title = data.title || data.from || title
    options = {
      ...options,
      body: data.body || options.body,
      tag: data.from || 'default',
      data: { from: data.from, type: data.type },
    }
  } catch {
    // Plain text payload
    const text = event.data.text()
    if (text) {
      options.body = text
    }
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

// ============================================================================
// Notification Click Handler
// ============================================================================

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  // Resolve the target conversation/room from the notification's routing data
  // (attached by showWebNotification, or by the push handler above from the
  // server payload). Null when the payload carried no `from` — then we just
  // focus/open the app at its default view instead of deep-linking nowhere.
  const target = resolveNotificationTarget(
    event.notification.data as { from?: string; type?: string } | undefined,
  )
  const deepLink = target?.deepLink ?? './'

  console.log('[SW Click] notification data:', event.notification.data, '-> deepLink:', deepLink)

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          if (target) {
            // Primary path for a live document: hand the route to the running
            // SPA so it navigates through its OWN router (see
            // useServiceWorkerNavigation). This is reliable on Android, where
            // WindowClient.navigate() to a hash route is not.
            client.postMessage(notificationNavigateMessage(target))
            // Fallback for a discarded/frozen document that focus() reloads: set
            // the URL so it boots straight at the deep link. Ignored (harmless
            // fragment nav) when the document is alive.
            void (client as WindowClient).navigate(deepLink).catch(() => {})
          }
          return (client as WindowClient).focus()
        }
      }
      // No live client (app was killed): open a fresh window at the deep link;
      // HashRouter routes to the conversation on boot.
      return self.clients.openWindow(deepLink)
    })
  )
})

// ============================================================================
// Lifecycle
// ============================================================================

// Do NOT skipWaiting on install. A freshly deployed build installs and then
// parks in the `waiting` state instead of seizing control, so the running page
// stays on its current (matching) build until the user opts in. The app detects
// the waiting worker and shows an "update available" button (see
// serviceWorkerUpdate.ts); clicking it posts SKIP_WAITING below.
//
// A first install still activates immediately (there is no active worker to wait
// behind), so offline precaching works on first visit without any prompt.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string })?.type === 'SKIP_WAITING') {
    void self.skipWaiting()
  }
})

// Claim all clients immediately on activation (first install, and after a
// user-approved SKIP_WAITING).
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})
