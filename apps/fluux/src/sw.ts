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

declare const self: ServiceWorkerGlobalScope

// Workbox precaching - assets are injected at build time by vite-plugin-pwa
precacheAndRoute(self.__WB_MANIFEST)

// ============================================================================
// Web Push Notification Handler
// ============================================================================

self.addEventListener('push', (event) => {
  if (!event.data) return

  let title = 'Fluux Messenger'
  let options: NotificationOptions = {
    body: 'New message',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
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

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing window if available
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus()
        }
      }
      // Open new window if none found
      return self.clients.openWindow('/')
    })
  )
})

// ============================================================================
// Lifecycle
// ============================================================================

// Skip waiting on install for immediate activation
self.addEventListener('install', () => {
  self.skipWaiting()
})

// Claim all clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})
