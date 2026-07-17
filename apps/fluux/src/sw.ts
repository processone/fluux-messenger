/**
 * Service Worker (sw = Service Worker)
 *
 * This file runs as a background script in the browser, separate from the main
 * application thread. It enables three key capabilities:
 *
 * 1. **Offline caching** — Workbox precaches app assets so the PWA loads
 *    without a network connection.
 *
 * 2. **Web Push notifications** — Listens for push events from the browser's
 *    push service (FCM, Mozilla, Apple) and displays OS-level notifications,
 *    even when the Fluux tab is closed or inactive.
 *
 * 3. **Runtime media cache** — Cache-first for cross-origin images (XEP-0363
 *    attachments, link-preview images), cached under `fluux-media`.
 *
 * Built with vite-plugin-pwa's `injectManifest` strategy so that the Workbox
 * precache manifest (`self.__WB_MANIFEST`) is injected at build time.
 */
/// <reference lib="webworker" />

import { precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'
import {
  resolveNotificationTarget,
  notificationNavigateMessage,
} from './utils/notificationNavigation'
import {
  buildPushNotification,
  pushNotificationTag,
  type PushPayloadData,
} from './utils/pushNotificationCoalesce'

declare const self: ServiceWorkerGlobalScope

// Workbox precaching - assets are injected at build time by vite-plugin-pwa
precacheAndRoute(self.__WB_MANIFEST)

// ============================================================================
// Runtime Media Cache
// ============================================================================
// Cross-origin images: XEP-0363 HTTP-upload attachment images and link-preview
// images (often served with `cache-control: max-age=0`, e.g. GitHub OGP — the
// SW cache overrides that). Avatars are PEP-derived `blob:` URLs and never
// reach the network layer; same-origin app assets are precached above.
// Images only — video/audio would need range-request support and eat quota.
// Cross-origin <img> fetches are no-cors -> opaque responses (status 0), which
// Chromium pads heavily in quota accounting: keep maxEntries conservative.
registerRoute(
  ({ request, url }) => request.destination === 'image' && url.origin !== self.location.origin,
  new CacheFirst({
    cacheName: 'fluux-media',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxEntries: 200,
        maxAgeSeconds: 30 * 24 * 60 * 60,
        purgeOnQuotaError: true,
      }),
    ],
  }),
)

// ============================================================================
// Web Push Notification Handler
// ============================================================================

self.addEventListener('push', (event) => {
  console.log('[SW Push] Received push event, data:', event.data?.text())
  if (!event.data) return

  let payload: PushPayloadData
  try {
    payload = event.data.json() as PushPayloadData
  } catch {
    // Plain text payload
    payload = { body: event.data.text() || undefined }
  }

  event.waitUntil(
    (async () => {
      try {
        // Coalesce with the still-displayed notification for this sender, if any.
        const tag = pushNotificationTag(payload)
        const existing = await self.registration.getNotifications({ tag })
        const existingCount =
          (existing[0]?.data as { count?: number } | undefined)?.count ??
          (existing.length > 0 ? 1 : 0)

        const built = buildPushNotification(payload, {
          existingCount,
          isAndroid: /android/i.test(self.navigator.userAgent),
          locale: self.navigator.language,
        })
        await self.registration.showNotification(built.title, built.options as NotificationOptions)

        // Badge: the app owns the exact count while it runs (useNotificationBadge);
        // with no window open the SW can only honestly say "something is waiting" —
        // an argumentless setAppBadge() shows a dot. Best-effort.
        const windowClients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        })
        if (windowClients.length === 0) {
          try {
            await (
              self.navigator as WorkerNavigator & { setAppBadge?: () => Promise<void> }
            ).setAppBadge?.()
          } catch {
            // Badging unsupported on this platform.
          }
        }
      } catch {
        // Anything above (getNotifications, showNotification, …) rejecting means
        // no notification was ever shown for this push — Chromium penalizes the
        // subscription for that. Best-effort a generic fallback so a push always
        // surfaces something; swallow a second failure so waitUntil still resolves.
        await self.registration
          .showNotification('Fluux Messenger', {
            body: 'New message',
            icon: './icon-192.png',
            badge: './icon-192.png',
            tag: pushNotificationTag(payload),
          })
          .catch(() => {})
      }
    })(),
  )
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
