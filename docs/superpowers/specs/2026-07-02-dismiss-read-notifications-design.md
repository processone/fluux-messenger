# Dismiss a conversation's notification when it is read (macOS)

**Date:** 2026-07-02
**Status:** Approved design, pending implementation plan

## Problem

When a message arrives while the app is backgrounded, macOS shows a banner and
keeps an entry in Notification Center. When the user later reads that
conversation, the entry should disappear. Today it does not.

### Why it's broken today

- macOS notifications are posted through a **custom Rust path**
  (`UNUserNotificationCenter` in `notifications/macos.rs::post`), keyed by an
  identifier `"<navType>:<navTarget>"` — e.g. `conversation:alice@example.com`
  or `room:team@conf.example.com`. Because every message for a conversation
  reuses the same identifier, macOS coalesces them into **one** delivered entry
  per conversation (latest message wins).
- The existing "clear on read" logic, `clearAllNotifications()` in
  `apps/fluux/src/hooks/useNavigateToTarget.ts`, calls the **Tauri notification
  plugin's** `removeAllActive()`. The plugin never posted the macOS
  notifications, so it cannot see or remove them. The Notification Center entry
  survives the read.

## Goal

Reading a conversation removes **only that conversation's** delivered
notification from Notification Center; other conversations' unread
notifications remain. "Read" fires on two paths:

1. **Open/navigate** — user opens/activates a conversation or room.
2. **Window focus** — the window regains focus while a conversation/room is
   already the active one (the app already marks it read here).

## Approach (chosen: A)

Add a native macOS command to remove *delivered* notifications by identifier,
plus a small cross-platform JS helper that dismisses a single conversation's
notification. Wire it into both read paths.

Rejected alternatives:
- **B — pure JS via plugin `removeActive({ tag })`:** the plugin cannot see the
  natively-posted macOS notifications. This is the current bug.
- **C — "remove all delivered" on any read:** reading one conversation would
  wipe every other conversation's unread notification. Defeats the purpose.

## Components

### 1. Rust: `remove_delivered_notifications` command (macOS only)

- **`notifications/mod.rs`** — new `#[tauri::command]`
  `remove_delivered_notifications(identifiers: Vec<String>)`, gated
  `#[cfg(target_os = "macos")]`, delegating to `macos::remove_delivered`.
- **`notifications/macos.rs`** — new `remove_delivered(identifiers: Vec<String>)`:
  - Resolve the notification center via the existing `current_center()`
    (returns `None` when the process is not app-bundled — degrade to no-op).
  - Build an `NSArray<NSString>` from the identifiers and call
    `center.removeDeliveredNotificationsWithIdentifiers(&array)`.
  - No return value needed beyond `()`; removal is best-effort.
- **`main.rs`** — register the command in the existing
  `tauri::generate_handler![...]` block (next to `notifications::post_notification`
  at ~line 1424).
- Non-macOS builds do not get this command; the JS helper's plugin/web branches
  handle those platforms.

### 2. JS: `dismissNotification` helper — and removal of the broken plugin call

**The bug this also fixes:** `clearAllNotifications()` in
`apps/fluux/src/hooks/useNavigateToTarget.ts` calls the Tauri plugin's
`removeAllActive()`. This is wrong on two counts: (a) on macOS it targets the
plugin, which never posted the native `UNUserNotificationCenter` notifications,
so it removes nothing; (b) even where it works (Windows/Linux/web) it is
all-or-nothing — reading one conversation clears every conversation's
notification. `clearAllNotifications()` and its `removeAllActive()` call are
**deleted entirely** (it is the only `removeAllActive` caller in the app) and
replaced by the scoped, per-platform helper below. No remove-all call remains.

The helper mirrors the **posting** path, which already branches per platform
(`isMacOSDesktop()` → native command; else plugin; web → service worker). The
`(navType, navTarget)` pair maps to a different token per mechanism:

| Platform / mechanism | Removal token | Source of the scheme |
| --- | --- | --- |
| macOS Tauri — native | identifier `` `${navType}:${navTarget}` `` — e.g. `conversation:alice@x`, `room:team@x` | `macos.rs::encode_identifier` |
| Windows/Linux Tauri — plugin | tag: `navTarget` (conversation) / `` `room-${navTarget}` `` (room) | `useDesktopNotifications.ts:182,238` |
| Web (PWA) — service worker | same tag as the plugin row | `useDesktopNotifications.ts:182,238` |

Behaviour — three branches matching the posting logic (reuse the existing
`isMacOSDesktop()` from `@/utils/tauriPlatform` and the module-local `isTauri`):
- **macOS Tauri:** `invoke('remove_delivered_notifications', { identifiers: [\`${navType}:${navTarget}\`] })`.
- **Windows/Linux Tauri:** plugin — `active()` → filter to entries whose `tag`
  matches the mapped tag → `removeActive(matches)`. (`removeActive` takes
  `{ id, tag }[]`; the entries from `active()` carry real ids. No-op if none match.)
- **Web (`!isTauri`):** `navigator.serviceWorker.ready` →
  `registration.getNotifications({ tag }).then(ns => ns.forEach(n => n.close()))`.

Wrapped in try/catch, best-effort — matching the "silently ignore, nice-to-have"
posture of the code it replaces.

Signature: `dismissNotification(navType: 'conversation' | 'room', navTarget: string): Promise<void>`.

### 3. Call sites (the two read paths)

1. **Open/navigate — `useNavigateToTarget.ts`:**
   - `navigateToConversation` → `void dismissNotification('conversation', conversationId)`
     (replaces `clearAllNotifications()`).
   - `navigateToRoom` → `void dismissNotification('room', roomJid)` (replaces
     `clearAllNotifications()`).
   - `navigateToContact` → **drop** the `clearAllNotifications()` call. Opening a
     contact profile is not a conversation read, so there is no specific
     notification to dismiss. (Decision: do not invent behaviour here.)
   - `clearAllNotifications()` is removed once it has no callers.

2. **Window focus — `useWindowVisibility.ts`:** in the `!wasFocused && isFocused`
   branch, after each `markAsRead(...)`, also dismiss that entity's
   notification:
   - active conversation → `void dismissNotification('conversation', activeConversationId)`
   - active room → `void dismissNotification('room', activeRoomJid)`

## Data flow

```
message arrives (backgrounded)
  → post_notification  → UNUserNotificationCenter entry  [id: conversation:<jid>]

user reads conversation
  ├─ opens it            (useNavigateToTarget.navigateToConversation)
  └─ or refocuses window (useWindowVisibility, active conversation)
       → dismissNotification('conversation', <jid>)
            ├─ macOS Tauri → invoke remove_delivered_notifications([conversation:<jid>])
            │                  → center.removeDeliveredNotificationsWithIdentifiers([...])
            ├─ Win/Linux   → plugin active() → filter tag=<jid> → removeActive(matches)
            └─ web         → registration.getNotifications({tag:<jid>}) → n.close()
  → only that conversation's entry is removed; others remain
```

## Error handling

- Native removal is best-effort: unbundled process (`current_center() == None`)
  or a non-macOS Tauri target → no-op, no error surfaced.
- JS helper wraps platform calls in try/catch and swallows errors (consistent
  with the removed `clearAllNotifications`, which was explicitly "nice to have").
- Passing an identifier that has no delivered notification is a harmless no-op
  on both platforms.

## Testing

- **JS helper (unit, vitest):**
  - macOS Tauri branch: mock `isMacOSDesktop → true` + `invoke`, assert it is
    called with `{ identifiers: ['conversation:alice@x'] }` for a conversation
    and `['room:team@x']` for a room.
  - Win/Linux Tauri branch: mock `isMacOSDesktop → false` + `isTauri` + plugin
    `active`/`removeActive`; assert it filters by the correct tag
    (`conv.id` vs `room-<jid>`) and passes the matching entries to `removeActive`.
  - Web branch: mock `navigator.serviceWorker.ready` / `getNotifications`,
    assert it queries the correct tag and calls `close()` on the returned
    notifications.
  - Assert errors from any branch are swallowed.
- **Call sites:** assert `navigateToConversation`/`navigateToRoom` invoke the
  helper with the right `(navType, navTarget)`; assert `navigateToContact` no
  longer clears notifications.
- **Rust command:** thin FFI over a system API — not unit tested. Verified
  manually via `npm run tauri:dev` on macOS: post a notification for two
  conversations, open one, confirm its Notification Center entry disappears and
  the other remains; repeat for the refocus path.

## Out of scope

- Server-initiated push notifications (local notifications only).
- Windows / Linux native removal beyond what the web/service-worker path and the
  Tauri plugin already provide.
- Changing the identifier/tag schemes themselves.
