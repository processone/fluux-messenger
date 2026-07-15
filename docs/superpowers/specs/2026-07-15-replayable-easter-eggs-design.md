# Replayable easter eggs for inactive conversations

**Date:** 2026-07-15
**Status:** Approved (brainstorming) → ready for implementation plan

## Problem

Easter-egg animations (`/bastille` → fireworks, `/christmas`) only play on receipt
if the recipient has that exact conversation focused. The animation is gated in the
view by `activeAnimation?.conversationId === activeConversation.id`
([ChatView.tsx:575](../../../apps/fluux/src/components/ChatView.tsx), [RoomView.tsx:691](../../../apps/fluux/src/components/RoomView.tsx)).

An egg arrives **bodiless** and **`no-store`** (never archived, never replayed from MAM —
see `sendEasterEgg`, [Chat.ts:1515](../../../packages/fluux-sdk/src/core/modules/Chat.ts)),
so it does **not** bump unread count, last-message preview, or fire a notification.
Result: an egg received while looking at another conversation is silently lost, with
no signal it ever arrived.

We want a received egg to still reach the user when its conversation is inactive: play
it when they open the conversation, let them replay it, and give them a way to discover
it in the first place.

## Decisions (from brainstorming)

- **Timing:** transient marker per conversation; on open, auto-play once **plus** a
  lingering replay control.
- **Persistence:** in-memory only (matches the ephemeral, no-store nature of eggs; a
  reload loses unplayed eggs, which is acceptable since they never arrive offline anyway).
- **Affordance:** a dismissible pill above the composer — realised by **reusing the
  existing reaction-mention chip**.
- **Discovery:** a clickable **toast** when the conversation is inactive (mirrors how
  reactions already surface "you weren't looking" events). No sidebar glyph needed.
- **Code sharing:** **parallel store, shared widget** — a new `easterEggMentionStore`
  alongside `reactionMentionStore`, both feeding one extracted presentational chip.
- **Coalescing:** **latest-egg-wins** — one pending egg per conversation, newest replaces
  older.
- **Playback binding:** guard the store binding so `triggerAnimation` fires only for the
  active conversation (removes the current fragile "stale `activeAnimation` replays on
  switch" behavior; the robust on-open path replaces it).

## Reuse basis (existing reaction-mention system)

The reaction system already implements the exact "transient mention" pattern:

- [`reactionMentionStore.ts`](../../../apps/fluux/src/stores/reactionMentionStore.ts) —
  in-memory `Map<conversationId, ReactionMention[]>` with `addMention` / `dismissMention`
  / `clearConversation`.
- [`ReactionMentions.tsx`](../../../apps/fluux/src/components/conversation/ReactionMentions.tsx) —
  pill chip above the composer with an action link ("See") and an `×` dismiss.
- [`useReactionNotifications.ts`](../../../apps/fluux/src/hooks/useReactionNotifications.ts) —
  a `decideReactionNotification` router with outcomes `toast` (inactive → clickable toast
  that navigates), `mention` (active but off-screen → chip), `none`.

The egg maps onto this with one deliberate difference: the egg stores its chip **even in
the inactive case** (reactions don't), so a missed 6-second toast still leaves a Replay
affordance when the user next opens the chat.

| | Reaction | Easter egg |
|---|---|---|
| Inactive conversation | toast only (ephemeral) | toast **+** stored chip |
| Chip action | "See" → jump to message | "Replay" → trigger animation |
| On open | clears the chip | auto-play once, keep chip as Replay |
| Store lifetime | in-memory | in-memory |

## Components

### 1. SDK — enrich the animation events

Add `senderName` and `isOwn` to `chat:animation` / `room:animation`
([sdk-events.ts:178](../../../packages/fluux-sdk/src/core/types/sdk-events.ts)), populated
at the three `emitSDK` sites in [Chat.ts](../../../packages/fluux-sdk/src/core/modules/Chat.ts):
receive-chat (~387), receive-room (~385), send (~1538). Mirrors how `chat:reactions`
already carries `reactorJid` + `isLive`.

- `senderName`: local part / room nick of the sender, for the toast label.
- `isOwn`: true for the local send echo, so the app hook can skip it (the sender already
  saw the animation play).

Requires `npm run build:sdk` before app typecheck.

### 2. App — `easterEggMentionStore`

New Zustand store parallel to `reactionMentionStore`, in-memory only:

```ts
interface PendingEasterEgg {
  id: string            // conversationId (one egg per conversation, latest wins)
  conversationId: string
  animation: string
  senderName: string
}
// Map<conversationId, PendingEasterEgg>  — add (replace) / dismiss / clearConversation
```

`add` replaces any existing egg for that conversation (latest-egg-wins). Unlike
`reactionMentionStore`, the egg store is **not** cleared on conversation open — only by
explicit dismiss.

### 3. App — shared `MentionChip`

Extract the presentational pill out of `ReactionMentions.tsx` into a reusable
`MentionChip` with props `{ icon?, label, actionLabel, onAction, onDismiss }`. Preserve
the current styling (`bg-fluux-hover/60 rounded-full`, brand action link, `X` dismiss).

- `ReactionMentions` refactors to render `MentionChip` per mention with "See".
- New `EasterEggMentions` renders `MentionChip` for a pending egg with "Replay".

Both mount above the composer in ChatView and RoomView (next to the existing
`ReactionMentions` mount points).

### 4. App — `useEasterEggNotifications` hook

Mirrors `useReactionNotifications`, registered once in GlobalEffects. Subscribes to the
enriched `chat:animation` / `room:animation` events and routes via a **pure**
`decideEasterEggNotification({ isOwn, isActive })`:

- **own send** → `none` (already played on send).
- **active conversation** → `play` (unchanged from today; the binding handles it).
- **inactive** → `notify`: add a clickable toast (`easterEgg.mention` label → navigate to
  the conversation, where the on-open path plays it) **and** `easterEggMentionStore.add`.

Keeping the decision pure and unit-testable follows the `reactionNotificationDecision`
precedent.

### 5. Playback lifecycle

- **Binding guard** ([storeBindings.ts:220/409](../../../packages/fluux-sdk/src/bindings/storeBindings.ts)):
  `triggerAnimation` fires only when the target conversation is the active one. This covers
  the send echo and active-receive playback (today's behavior) while removing the fragile
  global-slot "stale `activeAnimation` replays on switch" quirk.
- **On open:** in the ChatView / RoomView activation effect (alongside the existing
  `reactionMentionStore.clearConversation` call), if a pending egg exists for the
  conversation, call `triggerAnimation` once and **keep** the chip as a Replay control.
- **Replay button** → `triggerAnimation(activeConversationId, animation)` again.
- **Dismiss** → `easterEggMentionStore.dismiss`.

### 6. i18n

New keys, translated across all 33 locales:

- `easterEgg.mention` — e.g. "{{name}} sent fireworks" (generic across animations; keep
  copy animation-agnostic or key per animation if wording must differ).
- `easterEgg.replay` — "Replay".

Reuse `common.dismiss` for the `×` aria-label.

### 7. Tests

- `easterEggMentionStore.test.ts` — add/replace (latest-wins)/dismiss/clear.
- `easterEggNotificationDecision.test.ts` — pure decision matrix (own / active / inactive).
- `MentionChip.test.tsx` — renders label + action + dismiss, fires callbacks.
- Update reaction tests if the `MentionChip` extraction changes their render tree.

## Out of scope

- Persisting unplayed eggs across reload/restart.
- A dedicated sidebar glyph for pending eggs (toast covers discovery).
- Queuing multiple distinct eggs per conversation (latest-wins).
- Native OS notifications for eggs.

## Risk notes

- The **binding guard** (§5) is the only behavior change to existing playback; verify the
  send echo and active-receive still play. Everything else is additive.
- SDK type change → run `npm run build:sdk` before app typecheck; the new SDK event fields
  used by the app must be reflected in the app's SDK mock (`test-setup.ts`) if asserted.
