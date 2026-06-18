# Notifications for delayed 1:1 messages on reconnect

**Date:** 2026-06-18
**Status:** Design — approved, pending spec review

## Problem

When the client reconnects after sleep/wake — especially with the window hidden to
tray (red close button) on macOS — 1:1 messages that arrived during the disconnect do
**not** fire native notifications. The unread badge updates, but no banner appears.

Root cause: the notification gate `shouldNotifyConversation()`
(`packages/fluux-sdk/src/stores/shared/notificationState.ts`) hard-blocks any message
flagged `isDelayed`, and separately drops anything older than a 5-minute freshness
window:

```ts
if (msg.isOutgoing || msg.isDelayed) return false
if (Date.now() - msg.timestamp.getTime() > FRESHNESS_THRESHOLD_MS) return false
```

Messages delivered on reconnect carry an XEP-0203 `<delay/>` stamp, so `isDelayed` is
`true` and the message is suppressed before the window-visibility logic ever runs.

This is inconsistent with the unread-count path, which already treats a delayed 1:1
message as genuine new offline delivery via the `treatDelayedAsNew: true` flag that
`chatStore.addMessage` passes. So today the badge increments but the notification does
not fire.

### Delivery paths (and why "live paths only" is complete here)

- **Short sleep (< SM session timeout, ~10 min):** the server resumes the stream
  (XEP-0198) and replays undelivered stanzas as live `<message>` stanzas. These reach
  the notify gate.
- **Long sleep (SM session expired):** the server reroutes the undelivered stanzas
  through offline storage (`mod_offline`), and they are flushed as live `<message>` +
  `<delay/>` stanzas on the next fresh session. These reach the notify gate.
- **MAM catch-up** runs on fresh sessions but is **history/archive sync** — by the time
  it runs, genuinely-missed messages already arrived via offline storage. MAM merges go
  through `mergeMAMMessages()`, which bypasses the notify path entirely, and must stay
  notification-free.

Both real delivery paths (SM replay, offline flush) are "live paths" that reach the
gate. Fixing the gate fixes both at once.

**Caveat (recorded, out of scope):** this completeness assumes server-side offline
storage is enabled. A MAM-only deployment with `mod_offline` disabled would route
missed messages only through MAM; that case is explicitly out of scope for this change.

## Goals

- Delayed 1:1 messages that the user has **not yet seen** fire a native notification on
  reconnect, in all relevant delivery paths (SM replay, offline flush), with the window
  hidden or the app inactive.
- No notification storm: an offline backlog collapses to **one notification per
  conversation** (newest message as the body, unread count surfaced).
- MAM history backfill, scroll-back, and re-synced duplicates stay silent.
- Room (MUC) notification behavior is unchanged.

## Non-goals

- Notifying from the MAM catch-up path (`mergeMAMMessages`).
- Per-message notifications for an offline backlog.
- Summary-style "N messages in M chats" aggregation across conversations.
- MAM-only deployments without offline storage.

## Design

### Core principle: notify-worthiness mirrors unread-worthiness

Today the notify decision and the unread decision diverge. The unread path uses
`treatDelayedAsNew` + `lastSeenMessageId` and correctly counts a delayed offline message
as new. The notify path uses a cruder `isDelayed` + freshness block. The fix makes the
notify decision ask the same question the unread logic already answers: **is this an
incoming message the user has not seen yet?**

Delivery mechanism (`isDelayed`) and message age stop being discriminators. **Unseen**
becomes the discriminator. This keeps MAM history backfill and re-synced duplicates
silent (they do not leave an unseen incoming `lastMessage` with `unreadCount > 0`), and
it fixes every live delivery path simultaneously.

### Part 1 — Gate change (SDK)

**File:** `packages/fluux-sdk/src/stores/shared/notificationState.ts`

Extend `EntityContext` with two **optional** fields (optional so the room path and
existing callers are unaffected):

```ts
interface EntityContext {
  isActive: boolean
  windowVisible: boolean
  unreadCount?: number
  lastSeenMessageId?: string
}
```

Rewrite `shouldNotifyConversation()`:

```ts
export function shouldNotifyConversation(
  msg: NotificationMessage,
  ctx: EntityContext
): boolean {
  if (msg.isOutgoing) return false
  if (ctx.isActive && ctx.windowVisible) return false   // user can see it
  if ((ctx.unreadCount ?? 0) <= 0) return false          // nothing unseen
  if (msg.id === ctx.lastSeenMessageId) return false     // already seen
  return true                                            // unseen incoming → notify
}
```

Notes:
- The `isDelayed` block and the `FRESHNESS_THRESHOLD_MS` block are **removed**.
  "Unseen" is self-limiting: once the user sees a message, `lastSeenMessageId` advances
  and it never re-notifies; the reconnect burst is bounded by coalescing (Part 2).
- `shouldNotifyRoom()` is **not changed** — it keeps its `isDelayed` block, since a MUC
  `<delay/>` means history replay.

**File:** `packages/fluux-sdk/src/hooks/useNotificationEvents.ts`

The conversation notify call site already has `conv` in hand. Pass the new context
fields:

```ts
const notify = shouldNotifyConversation(
  { id: conv.lastMessage.id, timestamp: conv.lastMessage.timestamp,
    isOutgoing: conv.lastMessage.isOutgoing, isDelayed: conv.lastMessage.isDelayed },
  { isActive, windowVisible,
    unreadCount: conv.unreadCount, lastSeenMessageId: conv.lastSeenMessageId },
)
```

### Part 2 — Coalescing + catch-up window (app)

**Files:** `apps/fluux/src/hooks/useDesktopNotifications.ts` + new
`apps/fluux/src/hooks/notificationCoalescer.ts` (pure, unit-testable module).

`notificationCoalescer.ts` — a pure buffer keyed by conversation id:

- `open()` — begin coalescing (called when the catch-up window opens).
- `add(id, payload)` — while a window is open, buffer the latest payload per id
  (latest-wins). While closed, the caller dispatches immediately instead.
- `flush()` — emit one entry per buffered id (newest payload), clear the buffer.
- `drop()` — clear without emitting (used on disconnect/unmount).

`useDesktopNotifications.ts` wraps `showConversationNotification`:

- **Catch-up window** opens on each transition of the connection into `online` /
  `resumed` from a non-online state (covers fresh login, short-sleep SM resume, and
  long-sleep offline flush). It lasts a fixed `CATCHUP_WINDOW_MS` (~3000 ms) — long
  enough for the offline-flush burst, short enough not to delay the first live message.
- **During the window:** `onConversationMessage` routes into the coalescer (`add`).
- **At window close:** `flush()` calls the real `showConversationNotification` once per
  conversation. The body is the newest message; the title surfaces the unread count read
  from the conversation at flush time (e.g. `"Alice (3)"`).
- **Outside the window:** live messages call `showConversationNotification` immediately,
  exactly as today.
- **On disconnect / unmount:** `drop()` — never fire stale notifications after the
  connection drops.

Coalescing lives entirely in the app (presentation/batching concern). The SDK only
decides "notify-worthy."

### Edge cases & boundaries

- **Rooms unchanged.** Only `shouldNotifyConversation` changes; `EntityContext`'s new
  fields are optional.
- **Dedup is free.** The unseen check keys on `lastSeenMessageId` + message id, and the
  notify hook fires only on `lastMessage` id change — so offline-flush and SM-replay of
  the same id cannot double-notify, and a later MAM re-merge of already-seen history
  stays silent.
- **DND / permission** checks stay inside `showConversationNotification`, which the
  coalescer calls once at flush — so flush-time state wins.
- **Active + visible** conversation returns `false` in the gate (never buffered).
- **Count semantics:** the "(N)" suffix reads the conversation's `unreadCount` at flush
  time, not the buffered message count (they can differ if some were already seen).

## Testing

Infrastructure already exists (mock stores in the SDK; app hook test files such as
`useDesktopNotifications.posting.test.tsx`, `useNotificationEvents.test.tsx`). The gap is
**cases**, plus several existing `shouldNotifyConversation` tests that assert the *old*
behavior and must be rewritten. The coalescer and the window trigger are net-new code
with no coverage today.

### Rewrite (existing tests that encode removed behavior)

`packages/fluux-sdk/src/stores/shared/notificationState.test.ts`, `shouldNotifyConversation` block:
- Invert/replace `returns false for delayed messages` (currently asserts suppression).
- Remove/replace `returns false for stale messages (>5 minutes old)` and
  `returns true for fresh messages (<5 minutes old)` — freshness is no longer a gate.
- Update the shared `EntityContext` fixtures (`INACTIVE_HIDDEN`, `ACTIVE_VISIBLE`, etc.)
  to include `unreadCount` / `lastSeenMessageId`.

### New — pure (high confidence)

`notificationState.test.ts`:
- delayed + unseen (`unreadCount > 0`, `id !== lastSeenMessageId`) → **notify**.
- delayed + already-seen (`id === lastSeenMessageId`) → no.
- `unreadCount === 0` → no.
- old-but-unseen offline message (timestamp hours ago, unseen) → **notify** (proves
  freshness removal is intentional).
- outgoing → no; active + visible → no.

New `apps/fluux/src/hooks/notificationCoalescer.test.ts`:
- burst across M conversations inside an open window → exactly M flushed entries, each
  the newest payload.
- "(N)" suffix reads `unreadCount` at flush time.
- `add` outside an open window → caller dispatches immediately (no buffering).
- `drop()` clears without emitting.

### New — timer / wiring (weakest spot, deliberate attention)

`useDesktopNotifications` tests (mirror existing `.posting`/`.routing` test files), using
`vi.useFakeTimers()`:
- connection transition into `online` / `resumed` opens the window; messages during the
  window coalesce; window close (timer) flushes one-per-conversation.
- a message arriving just after window close notifies immediately.
- disconnect during an open window drops the buffer (no notification).
- DND active at flush time suppresses the flushed notification.

`useNotificationEvents.test.tsx`:
- hook passes `unreadCount` / `lastSeenMessageId` into the context.
- same message id observed twice → only one notification (hook-level dedup).

### Integration / manual (cannot be a pure unit test)

Offline-flush burst end-to-end: multiple `isDelayed` `addMessage` calls during the
catch-up window produce exactly one notification per conversation. Validate with the
demo / `emitSDK` harness, or the live sleep/wake procedure below. Recorded as the
integration verification step, not claimed as unit coverage.

## Manual verification (window hidden)

1. Connect; hide the window to tray (red button).
2. Sleep the Mac > 12 min (forces SM expiry → offline-flush path). From another client,
   send 1:1 messages to the account during the sleep.
3. Wake **without** opening the window. Expect: one native notification per conversation,
   with the unread count; badge consistent.
4. Repeat with a ~3-min sleep (SM-resume path) for the same expectation.

## Files touched

- `packages/fluux-sdk/src/stores/shared/notificationState.ts` — gate + `EntityContext`.
- `packages/fluux-sdk/src/hooks/useNotificationEvents.ts` — pass new ctx fields.
- `packages/fluux-sdk/src/stores/shared/notificationState.test.ts` — rewrite + add cases.
- `apps/fluux/src/hooks/useDesktopNotifications.ts` — window + coalescing wiring.
- `apps/fluux/src/hooks/notificationCoalescer.ts` (new) + `notificationCoalescer.test.ts` (new).
- `apps/fluux/src/hooks/useNotificationEvents.test.tsx` — ctx wiring + dedup.
- `apps/fluux/src/hooks/useDesktopNotifications.*.test.tsx` — window/flush/drop/DND.

## Build / dev gotcha

This changes the SDK `EntityContext` type. In a worktree the app typecheck resolves
`@fluux/sdk` to the **root** repo's built `dist`. After editing SDK source, run
`npm run build:sdk` and sync the built dist to the root's
`packages/fluux-sdk/dist` (and ensure the `node_modules/@fluux/sdk` symlink) so the app
typecheck/tests see the new shape. If notification-state exports change, update the
`@fluux/sdk` `vi.mock` in `test-setup.ts` and `ChatLayout.test.tsx`.
