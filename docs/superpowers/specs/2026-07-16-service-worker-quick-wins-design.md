# Service Worker Quick Wins: Media Caching, App Badge, Notification Coalescing

**Date:** 2026-07-16
**Status:** Approved

## Overview

Three additive improvements to the PWA service worker (`apps/fluux/src/sw.ts`)
and its app-side companions. Each is independently shippable, requires no
server changes, and builds on the existing `injectManifest` Workbox setup.

1. **Media runtime caching** — cache attachment and link-preview images.
2. **App badge** — unread count on the installed PWA icon; dot when app closed.
3. **Notification coalescing** — "N new messages" instead of silent replacement.

## Background

The current service worker does three things: Workbox precache (offline app
shell), Web Push → OS notification, and notification-click deep-linking, plus
the user-controlled update flow (waiting worker + `SKIP_WAITING`).

Findings that shaped the design:

- **Avatars are `blob:` URLs** (PEP binary → `createObjectURL`), never
  HTTP-fetched. SW caching cannot help them; they are out of scope.
- **Link-preview images often ship `cache-control: max-age=0`** (e.g. GitHub
  OGP images, noted in `LinkPreviewCard.tsx`), so every reload re-fetches
  them. A SW cache overrides that.
- **The push payload carries no unread count** (title/body/from only), which
  constrains what the badge can honestly display when the app is closed.
- **Tag scheme mismatch:** the push handler tags notifications with raw
  `data.from`, but the app path uses `room-<jid>` for MUCs (`webTag` in
  `dismissNotification.ts`). Read-dismissal therefore misses push-generated
  room notifications today.

## 1. Media Runtime Caching

A Workbox runtime route registered in `sw.ts` after `precacheAndRoute`:

- **Match:** `request.destination === 'image'` AND `url.origin !==
  self.location.origin`. This covers XEP-0363 attachment images and
  link-preview images. Avatars (`blob:`) and precached same-origin assets
  never match.
- **Strategy:** `CacheFirst`, cache name `fluux-media`, plugins:
  - `CacheableResponsePlugin({ statuses: [0, 200] })` — status 0 admits
    opaque cross-origin responses (link-preview `<img>` fetches are no-cors).
  - `ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 30 * 24 * 3600,
    purgeOnQuotaError: true })`.
- **Images only.** Video/audio attachments are excluded: they need
  range-request support and consume quota quickly. Possible follow-up.
- `maxEntries` stays conservative because Chromium pads opaque responses
  heavily in quota accounting.

Privacy trade-off (decided): attachment images persist unencrypted in Cache
Storage. Accepted — future E2EE attachments will not hit this cache (they are
decrypted in-app, not fetched as plain `https:` images).

## 2. App Badge

Two independent halves; the app is authoritative whenever it runs.

### App running

New `useAppBadge()` hook in `apps/fluux/src`:

- Subscribes to the same unread-attention count the rail badge uses
  (conversations needing attention, red tier — see the two-tier badge model).
- Calls `navigator.setAppBadge(n)`; `clearAppBadge()` when the count is 0.
- Guards: web only (skip under Tauri), feature-detect `setAppBadge`.
- Self-corrects on every store change; clears when everything is read.

### App closed

In the SW push handler, after showing the notification:

- Check `clients.matchAll({ type: 'window' })`; if any window client exists,
  do nothing (the app owns the badge).
- Otherwise call `self.navigator.setAppBadge()` with no argument → a dot.
  The SW never displays a number it cannot know (no dismiss-push exists, so
  any counter would drift on read-elsewhere).
- Best-effort `try/catch`; supported in SW scope on Chromium and iOS 16.4+.

No explicit clear from the SW: the app recomputes on next boot/focus, the
only moment the true count is knowable.

## 3. Notification Coalescing

### Push path (SW)

Today a second push from the same sender silently replaces the first (same
`tag`), losing any hint there were more messages. New behavior in the push
handler:

- Look up the existing notification: `registration.getNotifications({ tag })`.
- Carry `count` in `notification.data`. First message: `count = 1`, body =
  payload body (or the generic text for encrypted payloads). Subsequent:
  `count = previous + 1`, body = localized **"N new messages"**.
- `renotify: true` so each coalesced update still alerts.
- The coalescing decision lives in a pure function
  `buildPushNotification(existingData, payload)` so it is unit-testable.

### Localization

The SW cannot run the app's i18n stack. A small generated module
(`swMessages.ts`) contains only the "N new messages" plural string for all 33
locales, selected by `navigator.language` with English fallback. App-locale
plumbing through IndexedDB was considered and rejected as disproportionate
for one string.

### App-generated path

`showWebNotification` (`webNotification.ts`) gains an optional `count`. The
caller knows the true per-conversation unread count and passes its own
app-localized "N new messages" body when count > 1. Same presentation, exact
numbers.

### Tag consistency fix

The push handler adopts the `webTag` scheme (`room-<jid>` for MUCs, bare JID
otherwise) so `dismissNotification` closes push-generated room notifications
too. `webTag` moves to a shared location importable by both `sw.ts` and
`dismissNotification.ts`.

## Testing

- `buildPushNotification` — vitest unit tests (pattern:
  `serviceWorkerUpdate.test.ts`): first message, increment, encrypted body,
  tag scheme, renotify flag.
- `useAppBadge` — hook test with mocked `navigator.setAppBadge` /
  `clearAppBadge`: count changes, zero → clear, missing API → no-op.
- `swMessages` — locale selection and plural fallback.
- Media route is declarative Workbox config; verified manually on a built
  PWA: DevTools push simulation, offline toggle, Cache Storage inspection.

## Out of Scope

- Video/audio caching (range requests, quota).
- Notification action buttons, Share Target, Background Sync (future tiers).
- Dismiss-on-read-elsewhere push (needs a server-side dismiss payload).
- Decrypting push payloads in the SW (explicitly avoided for the E2EE
  roadmap; encrypted pushes degrade to a generic body).
