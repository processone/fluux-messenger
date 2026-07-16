# Service Worker Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add media runtime caching, an installed-PWA app badge, and push-notification coalescing to the Fluux PWA service worker.

**Architecture:** All logic that needs tests lives in pure modules under `apps/fluux/src/utils/` shared by the service worker (`sw.ts`) and the app. The SW gains a Workbox runtime route (images), a rewritten push handler (coalescing + badge dot), and the app's existing `useNotificationBadge` hook gains the Badging API alongside the favicon badge. SDK untouched — this is an app-only change.

**Tech Stack:** TypeScript, Workbox (routing/strategies/expiration/cacheable-response — already in node_modules via vite-plugin-pwa), Badging API, `Intl.PluralRules`, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-16-service-worker-quick-wins-design.md`

**Deliberate deviations from the spec (simplifications found during planning):**
1. No new `useAppBadge()` hook — `useNotificationBadge.ts` already computes the exact attention count via `computeBadgeCount` and applies it to the Tauri dock badge / favicon; the Badging API call is added there (same count, same effect).
2. `showWebNotification` does NOT gain a `count` param — callers in `useDesktopNotifications.ts` pass the coalesced body string directly.
3. The "N new messages" string lives ONLY in the shared `swMessages.ts` module (not in the 33 locale JSONs) — both the SW and the app path use it, one translation source, no i18next plumbing into the SW.

## Global Constraints

- Work on branch `mr/fluux-service-worker-features-2a47ac` (current worktree).
- Never include a Claude footer in commit messages.
- Run app-workspace tests from `apps/fluux/` (vitest is per-workspace in this monorepo).
- Before the final commit of the plan: unit tests pass with no stderr, `npm run typecheck` passes, lint passes.
- SW behavior parity: `notification.data` must keep `from` and `type` fields — `resolveNotificationTarget` (click deep-linking) depends on them.
- Cache name is exactly `fluux-media`; entry cap 200; max age 30 days.
- `renotify: true` only when the UA is Android.
- Badge from SW is always the ARGUMENTLESS `setAppBadge()` (dot), and only when no window client exists.

---

### Task 1: Share `webTag` between app and service worker

The push handler must tag notifications identically to the app path (`room-<jid>` for MUCs) so `dismissNotification` can close push-generated room notifications. Move `webTag` into `notificationNavigation.ts` — the module already shared by `sw.ts` and app code.

**Files:**
- Modify: `apps/fluux/src/utils/notificationNavigation.ts`
- Modify: `apps/fluux/src/utils/dismissNotification.ts` (delete local `webTag`, import shared one)
- Test: `apps/fluux/src/utils/notificationNavigation.test.ts` (append)

**Interfaces:**
- Produces: `export type NavType = 'conversation' | 'room'` and `export function webTag(navType: NavType, navTarget: string): string` from `notificationNavigation.ts`. Task 3 consumes `webTag`.
- `dismissNotification.ts` keeps re-exporting `NavType` so existing importers don't break.

- [ ] **Step 1: Write the failing test** — append to `apps/fluux/src/utils/notificationNavigation.test.ts`:

```typescript
import { webTag } from './notificationNavigation'

describe('webTag', () => {
  it('returns the bare JID for conversations', () => {
    expect(webTag('conversation', 'alice@example.com')).toBe('alice@example.com')
  })

  it('prefixes rooms with room-', () => {
    expect(webTag('room', 'dev@conference.example.com')).toBe('room-dev@conference.example.com')
  })
})
```

(Merge the import into the file's existing import from `./notificationNavigation`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/notificationNavigation.test.ts`
Expected: FAIL — `webTag` is not exported.

- [ ] **Step 3: Implement** — in `apps/fluux/src/utils/notificationNavigation.ts`, add after the `NotificationNavData` interface:

```typescript
/** Navigation kind for a notification target. */
export type NavType = 'conversation' | 'room'

/**
 * Tag used by the web Notification API for a conversation/room. Shared by the
 * push handler (sw.ts), the app notification path (useDesktopNotifications),
 * and read-dismissal (dismissNotification) so they always address the same
 * notification. Differs from the macOS native identifier.
 */
export function webTag(navType: NavType, navTarget: string): string {
  return navType === 'room' ? `room-${navTarget}` : navTarget
}
```

Then in `apps/fluux/src/utils/dismissNotification.ts`:
- Delete the local `webTag` function (lines 11–15) and the local `export type NavType = 'conversation' | 'room'` line.
- Add at the top: `import { webTag, type NavType } from './notificationNavigation'` and keep the public re-export: `export type { NavType }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/utils/notificationNavigation.test.ts src/utils/dismissNotification.test.ts`
Expected: PASS (both files — dismissal behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/notificationNavigation.ts apps/fluux/src/utils/notificationNavigation.test.ts apps/fluux/src/utils/dismissNotification.ts
git commit -m "refactor(notifications): share webTag between app and service worker"
```

---

### Task 2: `swMessages.ts` — localized "N new messages"

A small self-contained module with the plural string for all 33 app locales, selected via `Intl.PluralRules`. Used by the SW (browser locale) and by `useDesktopNotifications` (app locale). No i18next dependency — the SW bundle must stay lean.

**Files:**
- Create: `apps/fluux/src/utils/swMessages.ts`
- Test: `apps/fluux/src/utils/swMessages.test.ts`

**Interfaces:**
- Produces: `export function newMessagesText(locale: string, count: number): string`. Tasks 3 and 7 consume it.

- [ ] **Step 1: Write the failing test** — create `apps/fluux/src/utils/swMessages.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { newMessagesText } from './swMessages'

describe('newMessagesText', () => {
  it('formats English plurals', () => {
    expect(newMessagesText('en', 2)).toBe('2 new messages')
    expect(newMessagesText('en-US', 5)).toBe('5 new messages')
  })

  it('formats French', () => {
    expect(newMessagesText('fr', 3)).toBe('3 nouveaux messages')
  })

  it('applies Slavic plural categories', () => {
    expect(newMessagesText('ru', 2)).toBe('2 новых сообщения') // few
    expect(newMessagesText('ru', 5)).toBe('5 новых сообщений') // many
    expect(newMessagesText('ru', 21)).toBe('21 новое сообщение') // one
  })

  it('matches base language for regional variants', () => {
    expect(newMessagesText('de-AT', 4)).toBe('4 neue Nachrichten')
  })

  it('handles zh-CN (no plural forms)', () => {
    expect(newMessagesText('zh-CN', 9)).toBe('9条新消息')
  })

  it('falls back to English for unknown locales', () => {
    expect(newMessagesText('tlh', 2)).toBe('2 new messages')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/swMessages.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — create `apps/fluux/src/utils/swMessages.ts`:

```typescript
/**
 * Minimal localized strings for service-worker notifications.
 *
 * The SW cannot run the app's i18next stack (bundle weight, no React), so the
 * one string it needs — the coalesced "N new messages" body — lives here for
 * every app locale, selected with Intl.PluralRules. The app notification path
 * (useDesktopNotifications) reuses this module with the app locale so both
 * paths render identical text. Keys are base languages (lowercase).
 */

type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }

const FORMS: Record<string, PluralForms> = {
  ar: {
    one: 'رسالة جديدة واحدة',
    two: 'رسالتان جديدتان',
    few: '{count} رسائل جديدة',
    many: '{count} رسالة جديدة',
    other: '{count} رسالة جديدة',
  },
  be: {
    one: '{count} новае паведамленне',
    few: '{count} новыя паведамленні',
    many: '{count} новых паведамленняў',
    other: '{count} новых паведамленняў',
  },
  bg: { one: '{count} ново съобщение', other: '{count} нови съобщения' },
  ca: { one: '{count} missatge nou', other: '{count} missatges nous' },
  cs: {
    one: '{count} nová zpráva',
    few: '{count} nové zprávy',
    other: '{count} nových zpráv',
  },
  da: { one: '{count} ny besked', other: '{count} nye beskeder' },
  de: { one: '{count} neue Nachricht', other: '{count} neue Nachrichten' },
  el: { one: '{count} νέο μήνυμα', other: '{count} νέα μηνύματα' },
  en: { one: '{count} new message', other: '{count} new messages' },
  es: {
    one: '{count} mensaje nuevo',
    many: '{count} mensajes nuevos',
    other: '{count} mensajes nuevos',
  },
  et: { one: '{count} uus sõnum', other: '{count} uut sõnumit' },
  fi: { one: '{count} uusi viesti', other: '{count} uutta viestiä' },
  fr: {
    one: '{count} nouveau message',
    many: '{count} nouveaux messages',
    other: '{count} nouveaux messages',
  },
  ga: {
    one: '{count} teachtaireacht nua',
    two: '{count} theachtaireacht nua',
    few: '{count} theachtaireacht nua',
    many: '{count} dteachtaireacht nua',
    other: '{count} teachtaireacht nua',
  },
  he: {
    one: 'הודעה חדשה אחת',
    two: '{count} הודעות חדשות',
    many: '{count} הודעות חדשות',
    other: '{count} הודעות חדשות',
  },
  hr: {
    one: '{count} nova poruka',
    few: '{count} nove poruke',
    other: '{count} novih poruka',
  },
  hu: { one: '{count} új üzenet', other: '{count} új üzenet' },
  is: { one: '{count} ný skilaboð', other: '{count} ný skilaboð' },
  it: {
    one: '{count} nuovo messaggio',
    many: '{count} nuovi messaggi',
    other: '{count} nuovi messaggi',
  },
  lt: {
    one: '{count} nauja žinutė',
    few: '{count} naujos žinutės',
    many: '{count} naujos žinutės',
    other: '{count} naujų žinučių',
  },
  lv: {
    zero: '{count} jaunu ziņu',
    one: '{count} jauna ziņa',
    other: '{count} jaunas ziņas',
  },
  mt: {
    one: '{count} messaġġ ġdid',
    few: '{count} messaġġi ġodda',
    many: '{count}-il messaġġ ġdid',
    other: '{count} messaġġ ġdid',
  },
  nb: { one: '{count} ny melding', other: '{count} nye meldinger' },
  nl: { one: '{count} nieuw bericht', other: '{count} nieuwe berichten' },
  pl: {
    one: '{count} nowa wiadomość',
    few: '{count} nowe wiadomości',
    many: '{count} nowych wiadomości',
    other: '{count} nowych wiadomości',
  },
  pt: {
    one: '{count} nova mensagem',
    many: '{count} novas mensagens',
    other: '{count} novas mensagens',
  },
  ro: {
    one: '{count} mesaj nou',
    few: '{count} mesaje noi',
    other: '{count} de mesaje noi',
  },
  ru: {
    one: '{count} новое сообщение',
    few: '{count} новых сообщения',
    many: '{count} новых сообщений',
    other: '{count} новых сообщений',
  },
  sk: {
    one: '{count} nová správa',
    few: '{count} nové správy',
    other: '{count} nových správ',
  },
  sl: {
    one: '{count} novo sporočilo',
    two: '{count} novi sporočili',
    few: '{count} nova sporočila',
    other: '{count} novih sporočil',
  },
  sv: { one: '{count} nytt meddelande', other: '{count} nya meddelanden' },
  uk: {
    one: '{count} нове повідомлення',
    few: '{count} нові повідомлення',
    many: '{count} нових повідомлень',
    other: '{count} нових повідомлень',
  },
  zh: { other: '{count}条新消息' },
}

/** Localized "N new messages" for a coalesced notification body. */
export function newMessagesText(locale: string, count: number): string {
  const base = locale.toLowerCase().split('-')[0]
  const forms = FORMS[base] ?? FORMS.en
  let rule: Intl.LDMLPluralRule = 'other'
  try {
    rule = new Intl.PluralRules(locale).select(count)
  } catch {
    // Invalid locale tag — keep 'other'.
  }
  const template = forms[rule] ?? forms.other
  return template.replace('{count}', String(count))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/swMessages.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/swMessages.ts apps/fluux/src/utils/swMessages.test.ts
git commit -m "feat(notifications): localized new-messages text shared with the service worker"
```

---

### Task 3: `pushNotificationCoalesce.ts` — pure coalescing builder

The decision logic of the SW push handler, extracted so it is unit-testable without a service-worker runtime (same pattern as `notificationNavigation.ts`).

**Files:**
- Create: `apps/fluux/src/utils/pushNotificationCoalesce.ts`
- Test: `apps/fluux/src/utils/pushNotificationCoalesce.test.ts`

**Interfaces:**
- Consumes: `webTag` (Task 1), `newMessagesText` (Task 2).
- Produces (Task 4 consumes all three):

```typescript
export interface PushPayloadData { title?: string; body?: string; from?: string; type?: string }
export interface CoalesceContext { existingCount: number; isAndroid: boolean; locale: string }
export function pushNotificationTag(payload: PushPayloadData): string
export function buildPushNotification(payload: PushPayloadData, ctx: CoalesceContext): BuiltPushNotification
// BuiltPushNotification = { title: string; options: { body, icon, badge, tag, renotify?, data: { from?, type?, count } } }
```

- [ ] **Step 1: Write the failing test** — create `apps/fluux/src/utils/pushNotificationCoalesce.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildPushNotification, pushNotificationTag } from './pushNotificationCoalesce'

const ctx = { existingCount: 0, isAndroid: false, locale: 'en' }

describe('pushNotificationTag', () => {
  it('uses the bare JID for conversations', () => {
    expect(pushNotificationTag({ from: 'alice@example.com' })).toBe('alice@example.com')
  })

  it('uses the room- prefixed tag for rooms (matches dismissNotification)', () => {
    expect(pushNotificationTag({ from: 'dev@conference.example.com', type: 'room' })).toBe(
      'room-dev@conference.example.com',
    )
  })

  it('falls back to default without a from', () => {
    expect(pushNotificationTag({})).toBe('default')
  })
})

describe('buildPushNotification', () => {
  it('keeps the payload body for the first message and counts 1', () => {
    const built = buildPushNotification({ from: 'alice@example.com', body: 'hello' }, ctx)
    expect(built.title).toBe('alice@example.com')
    expect(built.options.body).toBe('hello')
    expect(built.options.tag).toBe('alice@example.com')
    expect(built.options.data).toEqual({ from: 'alice@example.com', type: undefined, count: 1 })
    expect(built.options.renotify).toBeUndefined()
  })

  it('prefers an explicit payload title', () => {
    const built = buildPushNotification({ title: 'Alice', from: 'alice@example.com', body: 'hi' }, ctx)
    expect(built.title).toBe('Alice')
  })

  it('coalesces subsequent messages into a localized count body', () => {
    const built = buildPushNotification(
      { from: 'alice@example.com', body: 'hi again' },
      { ...ctx, existingCount: 1 },
    )
    expect(built.options.body).toBe('2 new messages')
    expect(built.options.data.count).toBe(2)
  })

  it('localizes the coalesced body', () => {
    const built = buildPushNotification(
      { from: 'alice@example.com', body: 'x' },
      { existingCount: 2, isAndroid: false, locale: 'fr' },
    )
    expect(built.options.body).toBe('3 nouveaux messages')
  })

  it('sets renotify only on Android', () => {
    const android = buildPushNotification({ from: 'a@b.c', body: 'x' }, { ...ctx, isAndroid: true })
    expect(android.options.renotify).toBe(true)
    const desktop = buildPushNotification({ from: 'a@b.c', body: 'x' }, ctx)
    expect(desktop.options.renotify).toBeUndefined()
  })

  it('uses generic defaults for an empty payload', () => {
    const built = buildPushNotification({}, ctx)
    expect(built.title).toBe('Fluux Messenger')
    expect(built.options.body).toBe('New message')
    expect(built.options.tag).toBe('default')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/pushNotificationCoalesce.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — create `apps/fluux/src/utils/pushNotificationCoalesce.ts`:

```typescript
/**
 * Pure decision logic for the service worker's push handler: tag scheme,
 * message coalescing ("N new messages"), and platform alert behavior.
 * Extracted from sw.ts so it is unit-testable without a SW runtime
 * (same pattern as notificationNavigation.ts).
 */

import { webTag } from './notificationNavigation'
import { newMessagesText } from './swMessages'

/** Parsed push payload (server JSON, or `{ body }` from a plain-text push). */
export interface PushPayloadData {
  title?: string
  body?: string
  from?: string
  type?: string
}

export interface CoalesceContext {
  /** `count` carried by the displayed notification for this tag; 0 when none. */
  existingCount: number
  /** Android Chrome supports `renotify`; each message should buzz there. */
  isAndroid: boolean
  /** BCP-47 tag for the coalesced body (SW: navigator.language). */
  locale: string
}

export interface BuiltPushNotificationOptions {
  body: string
  icon: string
  badge: string
  tag: string
  renotify?: boolean
  /** `from`/`type` feed resolveNotificationTarget on click; `count` feeds coalescing. */
  data: { from?: string; type?: string; count: number }
}

export interface BuiltPushNotification {
  title: string
  options: BuiltPushNotificationOptions
}

const DEFAULT_TITLE = 'Fluux Messenger'
const DEFAULT_BODY = 'New message'

/**
 * Notification tag for a push payload. MUST match the app-side scheme
 * (webTag) so dismissNotification closes push-generated notifications too.
 */
export function pushNotificationTag(payload: PushPayloadData): string {
  if (!payload.from) return 'default'
  return webTag(payload.type === 'room' ? 'room' : 'conversation', payload.from)
}

/**
 * Build the notification for a push. First message for a tag shows the payload
 * body; while an unread notification for the same tag is still displayed,
 * subsequent messages replace it with a localized "N new messages" body.
 * `renotify` (re-alert on replacement) is Android-only: phones should buzz per
 * message, desktop stays calm, Safari/Firefox ignore the flag anyway.
 */
export function buildPushNotification(
  payload: PushPayloadData,
  ctx: CoalesceContext,
): BuiltPushNotification {
  const count = ctx.existingCount + 1
  const body = count > 1 ? newMessagesText(ctx.locale, count) : (payload.body ?? DEFAULT_BODY)
  return {
    title: payload.title || payload.from || DEFAULT_TITLE,
    options: {
      body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: pushNotificationTag(payload),
      ...(ctx.isAndroid ? { renotify: true } : {}),
      data: { from: payload.from, type: payload.type, count },
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/pushNotificationCoalesce.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/pushNotificationCoalesce.ts apps/fluux/src/utils/pushNotificationCoalesce.test.ts
git commit -m "feat(sw): pure push-notification coalescing builder"
```

---

### Task 4: Rewire the SW push handler (coalescing + badge dot)

Replace the inline payload/notification logic in `sw.ts` with the tested builder, and set the argumentless badge dot when no window client exists.

**Files:**
- Modify: `apps/fluux/src/sw.ts` (the `push` listener, lines 30–63 of the current file)

**Interfaces:**
- Consumes: `buildPushNotification`, `pushNotificationTag`, `PushPayloadData` (Task 3).
- Produces: unchanged `notification.data.from`/`.type` contract for the existing `notificationclick` handler.

- [ ] **Step 1: Replace the push handler** — in `apps/fluux/src/sw.ts`, add to the imports:

```typescript
import {
  buildPushNotification,
  pushNotificationTag,
  type PushPayloadData,
} from './utils/pushNotificationCoalesce'
```

Replace the whole `self.addEventListener('push', ...)` block with:

```typescript
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
      const windowClients = await self.clients.matchAll({ type: 'window' })
      if (windowClients.length === 0) {
        try {
          await (
            self.navigator as WorkerNavigator & { setAppBadge?: () => Promise<void> }
          ).setAppBadge?.()
        } catch {
          // Badging unsupported on this platform.
        }
      }
    })(),
  )
})
```

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both pass; `apps/fluux/dist/sw.js` is emitted.

(If `built.options as NotificationOptions` errors because the TS lib lacks `renotify`, cast via `as unknown as NotificationOptions` and note it — `renotify` is a real runtime option Chromium honors.)

- [ ] **Step 3: Run the app test suite (guard against regressions)**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS, no stderr.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/sw.ts
git commit -m "feat(sw): coalesce push notifications and show badge dot when app is closed"
```

---

### Task 5: Media runtime caching route

Cache cross-origin images (XEP-0363 attachment images, link-preview images) with CacheFirst + expiration. Avatars are `blob:` URLs and never hit the route; same-origin assets are precached.

**Files:**
- Modify: `apps/fluux/src/sw.ts` (imports + one block after `precacheAndRoute`)

**Interfaces:**
- Produces: runtime cache named `fluux-media` (verifiable in DevTools → Application → Cache Storage).

- [ ] **Step 1: Add the route** — in `apps/fluux/src/sw.ts`, add imports:

```typescript
import { registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'
```

After the `precacheAndRoute(self.__WB_MANIFEST)` line, add:

```typescript
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
```

- [ ] **Step 2: Typecheck and build; verify the route is in the bundle**

Run: `npm run typecheck && npm run build && grep -c "fluux-media" apps/fluux/dist/sw.js`
Expected: typecheck/build pass; grep prints ≥ 1.

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/sw.ts
git commit -m "feat(sw): runtime cache for attachment and link-preview images"
```

---

### Task 6: App badge from the unread count (app running)

Add the Badging API next to the existing favicon badge in `useNotificationBadge`. Extract the call into a testable util.

**Files:**
- Create: `apps/fluux/src/utils/appBadge.ts`
- Modify: `apps/fluux/src/hooks/useNotificationBadge.ts` (browser branch of the update effect, currently line ~161)
- Test: `apps/fluux/src/utils/appBadge.test.ts`

**Interfaces:**
- Produces: `export function setWebAppBadge(count: number): Promise<void>`.
- Consumes: `totalCount` already computed in `useNotificationBadge` via `computeBadgeCount`.

- [ ] **Step 1: Write the failing test** — create `apps/fluux/src/utils/appBadge.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { setWebAppBadge } from './appBadge'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setWebAppBadge', () => {
  it('sets the badge for positive counts', async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined)
    const clearAppBadge = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge })
    await setWebAppBadge(3)
    expect(setAppBadge).toHaveBeenCalledWith(3)
    expect(clearAppBadge).not.toHaveBeenCalled()
  })

  it('clears the badge at zero', async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined)
    const clearAppBadge = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge })
    await setWebAppBadge(0)
    expect(clearAppBadge).toHaveBeenCalled()
    expect(setAppBadge).not.toHaveBeenCalled()
  })

  it('no-ops when the Badging API is missing', async () => {
    vi.stubGlobal('navigator', {})
    await expect(setWebAppBadge(2)).resolves.toBeUndefined()
  })

  it('swallows rejections (unsupported platforms)', async () => {
    vi.stubGlobal('navigator', {
      setAppBadge: vi.fn().mockRejectedValue(new Error('nope')),
    })
    await expect(setWebAppBadge(2)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/appBadge.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — create `apps/fluux/src/utils/appBadge.ts`:

```typescript
/**
 * Badging API wrapper for the installed PWA icon (complements the favicon
 * badge, which only covers a visible browser tab). Feature-detected and
 * best-effort: unsupported platforms silently no-op.
 *
 * Counterpart when the app is CLOSED: sw.ts sets an argumentless
 * setAppBadge() dot on push, since only the running app knows the real count.
 */
export async function setWebAppBadge(count: number): Promise<void> {
  const nav = navigator as Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  if (!nav.setAppBadge) return
  try {
    if (count > 0) await nav.setAppBadge(count)
    else await nav.clearAppBadge?.()
  } catch {
    // Best-effort — the favicon badge remains as fallback.
  }
}
```

Then in `apps/fluux/src/hooks/useNotificationBadge.ts`:
- Add import: `import { setWebAppBadge } from '@/utils/appBadge'`
- In the update effect, extend the browser branch:

```typescript
    if (isTauri()) {
      void setTauriBadge(totalCount)
    } else {
      faviconBadgeRef.current?.setBadge(totalCount)
      // Installed-PWA icon badge (Badging API): exact count while the app runs.
      void setWebAppBadge(totalCount)
    }
```

(Note this replaces the `else if (faviconBadgeRef.current)` guard with an optional call so the app badge is set even before the favicon canvas is ready.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/utils/appBadge.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/appBadge.ts apps/fluux/src/utils/appBadge.test.ts apps/fluux/src/hooks/useNotificationBadge.ts
git commit -m "feat(badge): exact unread count on the installed PWA icon"
```

---

### Task 7: Coalesced bodies for app-generated web notifications

When the tab is open-but-unfocused the APP posts notifications (`useDesktopNotifications`), replacing by tag just like the SW. The app knows the true per-conversation unread count, so it passes the localized "N new messages" body itself. Presentation matches the SW path: count in body, plain title. Tauri branches keep their existing "(N)" title style — native notification centers stack instead of replacing, so body coalescing doesn't apply there.

**Files:**
- Modify: `apps/fluux/src/hooks/useDesktopNotifications.ts` (web branches of `showConversationNotification` ~line 177 and `showRoomNotification` ~line 233)

**Interfaces:**
- Consumes: `newMessagesText` (Task 2), `conv.unreadCount`, `room.unreadCount`, `i18n.language` from the existing `useTranslation()`.

- [ ] **Step 1: Implement** — in `apps/fluux/src/hooks/useDesktopNotifications.ts`:

Add import: `import { newMessagesText } from '@/utils/swMessages'`

Change `const { t } = useTranslation()` to `const { t, i18n } = useTranslation()`.

In `showConversationNotification`, replace the web branch (the `else` with `showWebNotification`):

```typescript
    } else {
      // Same-tag replacement swallows earlier messages, so surface the count in
      // the body (matches the SW push path; the title stays the plain name).
      const coalesced = conv.unreadCount > 1
      await showWebNotification(
        baseTitle,
        {
          body: coalesced ? newMessagesText(i18n.language, conv.unreadCount) : body,
          icon: avatarUrl || './icon-512.png',
          tag: conv.id,
          onClick: () => navigateToConversation(conv.id),
        },
        { from: conv.id, type: 'conversation' },
      )
    }
```

In `showRoomNotification`, replace the web branch:

```typescript
    } else {
      // Coalesced room notifications drop the per-message nick: the messages
      // may come from several senders, so the room name is the honest title.
      const coalesced = room.unreadCount > 1
      await showWebNotification(
        coalesced ? room.name : title,
        {
          body: coalesced ? newMessagesText(i18n.language, room.unreadCount) : body,
          icon: avatarUrl || './icon-512.png',
          tag: `room-${room.jid}`,
          onClick: () => navigateToRoom(room.jid),
        },
        { from: room.jid, type: 'room' },
      )
    }
```

- [ ] **Step 2: Typecheck and run the app suite**

Run: `npm run typecheck && cd apps/fluux && npx vitest run`
Expected: PASS, no stderr.

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/hooks/useDesktopNotifications.ts
git commit -m "feat(notifications): coalesced web notification bodies from unread counts"
```

---

### Task 8: Full verification

- [ ] **Step 1: Full test suite, typecheck, lint, build**

Run from the repo root:

```bash
npm run typecheck && npm test && npm run lint && npm run build
```

Expected: all pass, no stderr from tests. (If there is no root `lint` script, run the app workspace lint: `cd apps/fluux && npm run lint`.)

- [ ] **Step 2: Bundle sanity checks**

```bash
grep -c "fluux-media" apps/fluux/dist/sw.js        # expect >= 1 (media route)
grep -c "setAppBadge" apps/fluux/dist/sw.js        # expect >= 1 (badge dot)
grep -c "nouveaux messages" apps/fluux/dist/sw.js  # expect >= 1 (swMessages bundled)
```

- [ ] **Step 3: Manual PWA verification (browser, built app)**

The SW is only generated on build (no `devOptions` in vite config). Serve the build: `cd apps/fluux && npx vite preview`, open the printed URL in Chromium, connect to an XMPP account.

1. DevTools → Application → Service Workers: worker activated.
2. Open a conversation containing image attachments or link previews → Application → Cache Storage → `fluux-media` has entries; reload offline (Network → Offline) → images still render.
3. DevTools → Application → Service Workers → Push twice with `{"title":"Alice","body":"hi","from":"alice@example.com"}` → first notification shows "hi", second shows "2 new messages".
4. Notification click still deep-links to the conversation (regression check for the tag change).

Badge dot and Android renotify are only observable on an installed PWA (deployed origin) — note in the PR that they're verified after deploy on demo.fluux.io.

- [ ] **Step 4: Final commit / PR**

If any fixes were needed, commit them. Then push the branch and open a PR to `main` with a concise summary (no test plan, no Claude footer):

```bash
git push -u origin mr/fluux-service-worker-features-2a47ac
gh pr create --title "PWA service worker: media cache, app badge, notification coalescing" --body "Three additive PWA improvements (spec: docs/superpowers/specs/2026-07-16-service-worker-quick-wins-design.md):

- **Media cache**: Workbox CacheFirst for cross-origin images (attachments, link previews — fixes the max-age=0 OGP reload refetch). Images only, 200 entries / 30 days.
- **App badge**: exact unread count via the Badging API while the app runs (folded into useNotificationBadge); argumentless dot from the SW push handler when no window is open.
- **Notification coalescing**: repeated pushes from one sender become 'N new messages' (localized via a small shared swMessages module; renotify on Android only). Push tags now use the shared webTag scheme so read-dismissal also closes push-generated room notifications.

Badge dot + Android renotify verified on the deployed PWA after merge."
```
