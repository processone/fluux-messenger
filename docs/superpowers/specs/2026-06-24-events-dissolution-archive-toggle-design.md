# Dissolve the Events tab — redistribute events, Archive as a toggle

Date: 2026-06-24 (reactions design resolved 2026-06-30)
Status: Approved design, pending implementation plan
Companion to: `2026-06-24-conversation-first-contacts-design.md` (Decision 1).
Build that one first — this design assumes subscription requests already live in
the Contacts destination.

> **Resolution (2026-06-30).** The reactions sub-design (§4) and the activity-log
> removal (§6) were refined after exploring the codebase. Key changes from the
> 2026-06-24 draft: (a) received reactions are signalled by a new SDK
> `reaction:received` client event consumed by an app side-effect — there is no
> resurrected per-conversation log; (b) **out-of-conversation** reactions show a
> clickable **toast**, **in-conversation off-screen** reactions show a **transient
> in-flow mention**, both **live-only** (never on MAM replay); (c) **reaction
> muting is dropped entirely for now** (no `⋯` mute menu, no header "Reactions"
> toggle) — the mute state is **deleted**, not relocated. The plan is split into
> **2A** (redistribution + Archive) and **2B** (reactions + activity-log deletion).

## Problem

The Events rail destination (`Bell`, `view="events"`) renders two different
things stacked in the narrow sidebar (`Sidebar.tsx` renders `<EventsView />` then
`<ActivityLogView />`):

- **`EventsView`** — *pending, actionable* items: subscription requests, messages
  from strangers (`strangerConversations`), room invitations (`mucInvitations`),
  and system notifications (`systemNotifications`: resource-conflict / "replaced",
  auth-error).
- **`ActivityLogView`** — a *chronological history log* of all of the above plus
  `reaction-received` events, grouped by day, with per-conversation /
  per-message reaction muting and an inline reaction preview
  (`setPreviewEvent` → `ActivityContextView`).

Two problems. First, every item is shown far from where it belongs — a room
invitation in a generic Events list rather than near rooms, a reaction in a log
rather than in the conversation. Second, the whole tab lives in the narrow
sidebar column while 70% of the screen sits empty.

Once each event type is routed to its natural home, the Events destination — and
its rail icon — has no reason to exist. This design removes it.

## Approach

Redistribute every category to the surface it belongs to, then delete the Events
destination, its rail icon and badge, and the unified activity log. Separately,
**Archive** stops being a rail destination and becomes a toggle in the Messages
header (it is a filter over conversations, not a place).

### Redistribution map

| Event category | New home |
| --- | --- |
| Subscription requests | **Contacts** › Requests (Decision 1) |
| Room invitations (`mucInvitations`) | **Rooms** › pinned entry at the top of `RoomsList` |
| Messages from strangers (`strangerConversations`) | **Messages** › "Message requests" pinned entry atop `ConversationList` |
| Reactions received | **Conversation** › badge on the message (persistent) + **toast** when out of conversation + **transient in-flow mention** when in conversation and the target is off-screen |
| System / connection (`systemNotifications`) | **Toast** (transient) + connection status line (persistent) |
| Activity history log | **Deleted** |

## Behavior

### 1. Rail — remove Events and Archive

- Remove the `Bell` (`view="events"`) `IconRailNavLink` and its badge. Drop the
  `pendingCount` computation that fed it.
- Remove the `Archive` (`view="archive"`) `IconRailNavLink`.
- Resulting rail: top cluster = Messages, Rooms, Search; bottom cluster =
  Contacts, Admin (if admin), Settings, avatar.

### 2. Room invitations → top of Rooms

A pending invitation renders as a pinned entry at the top of `RoomsList`
("Invitations · N", expanding to per-invitation Accept / Decline). Accepting
**must keep the existing `useRoomJoinWarning` guard** (issue #37: the join
happens inside `acceptInvitation`, so the non-anonymous-room warning must fire
before joining). The Rooms rail icon's existing badge logic extends to include
pending invitations.

### 3. Stranger messages → Message requests (Messages)

A "Message requests · N" pinned entry sits at the top of `ConversationList`
(above conversations), opening the list of stranger conversations with the
existing Accept / Ignore / Block actions (`acceptStranger` navigates into the
new conversation; `ignoreStranger`; block). This is a pinned entry, **not** list
segmentation (that remains parked with Spaces).

### 4. Reactions → in the conversation

Reactions stop being log entries. The on-message badge stays the only persistent
record; everything else is ephemeral *attention*, dispatched at receive time.

**Signal source.** Where the SDK applies an incoming reaction to
`message.reactions` (the point that used to also write an activity-log event), it
emits a new client event `reaction:received` carrying
`{ conversationId, messageId, reactor, emojis, isLastMessage, isLive }`. An app
side-effect subscribes and dispatches. Only **live** reactions notify — reactions
arriving via MAM catch-up / history replay (`isLive === false`) are ignored, so
returning online does not produce a burst of toasts/mentions.

- **Badge on the message** — the persistent record (who reacted, counts). Already
  rendered on messages; unchanged.
- **Toast (out of conversation)** — when the reaction's conversation is **not** the
  active one, a clickable `ToastContainer` toast ("❤️ Marie reacted to '…'");
  clicking opens the conversation and scrolls to the target message
  (`scrollToMessage`, via the message's `data-message-id`). Transient, auto-dismiss.
- **Transient in-flow mention (in conversation)** — when the reaction's conversation
  **is** active and the target is **not the last message** (off-screen), a centered,
  muted pill rendered in the message flow (distinct from a bubble): "❤️ Marie
  reacted to '…' · See", with a "See" jump and a dismiss (✕). It is held in a small
  **app-side ephemeral store** (`reactionMentionStore`, keyed by conversation, not
  persisted, auto-pruned), not as a message. When the target **is** the last
  (visible) message, neither toast nor mention fires — the on-message badge suffices.

**No muting (for now).** There is no per-message/per-conversation reaction mute, no
`⋯` mute menu, and no "Reactions" header toggle. The existing reaction-mute state
(`mutedReactionConversations` / `mutedReactionMessages`, the mute/unmute actions,
`isReactionMuted`) is **deleted** with the activity log (§6), not relocated. (A mute
control can be revisited later if needed.)

### 5. System / connection events → toast + status

- Transient notifications → **`ToastContainer`** (already present).
- Persistent / severe (auth-error, resource-conflict / "replaced") → surfaced in
  the **connection status line** (the bottom user panel / `StatusDisplay`), where
  connection state already lives. No standing list. `systemNotifications` /
  `dismissNotification` storage is reduced to whatever the status line needs;
  the Events list rendering of them is removed.

### 6. Activity log → deleted

Remove `ActivityLogView`, `ActivityContextView`, the `useActivityLog` hook, its
`useActivityLogStore` react wrapper and the `activityLogStore` vanilla store,
`setPreviewEvent` / `previewEvent`, the `activityNavigation` helper, and the
`reaction-received` activity-event emission in the SDK. Once each item shows its
own resolved state in its own home, a separate cross-cutting timeline is
redundant. The reaction-mute state that lived in `activityLogStore`
(`mutedReactionConversations` / `mutedReactionMessages` + actions +
`isReactionMuted`) is **deleted with it** (§4: no mute for now), so nothing is
relocated. The SDK's reaction handler emits the new `reaction:received` event
(§4) instead of writing an activity event.

### 7. Archive → header toggle

Archive becomes an on/off toggle in the **Messages header, to the left of the
`+`** (an `archive` icon). Off = active conversations; on = archived
conversations (the existing `ArchiveList` logic, surfaced as a toggled mode of
`ConversationList` rather than a separate rail view). The header title reflects
the mode when on (e.g. "Archived"). Remove `'archive'` from `SidebarView`.

## Components & changes

- **`Sidebar.tsx`** — remove the Events and Archive `IconRailNavLink`s and the
  `pendingCount` / events-badge logic; remove the `events`/`archive` branches of
  the content switch and title switch.
- **`sidebar-components/types.tsx`** — drop `'events'` and `'archive'` from
  `SidebarView`; update routing (`useRouteSync`).
- **`RoomsList`** — add a pinned "Invitations" entry sourced from
  `mucInvitations`, reusing the `EventsView` invitation actions + the
  `useRoomJoinWarning` guard.
- **`ConversationList`** — add a pinned "Message requests" entry sourced from
  `strangerConversations`, reusing the stranger Accept/Ignore/Block actions; add
  the Archive toggle handling (active vs archived mode), absorbing `ArchiveList`.
- **Messages header** — add the Archive toggle left of the `+` (the `+` opens the
  New message picker from Decision 1).
- **SDK reaction handler** — emit a `reaction:received` client event
  (`{ conversationId, messageId, reactor, emojis, isLastMessage, isLive }`) where it
  applies an incoming reaction, in place of the deleted activity-log write.
- **`reactionMentionStore` (new, app)** — small ephemeral store of in-flow reaction
  mentions keyed by conversation (not persisted; auto-pruned on dismiss / view
  change). Fed by the reaction side-effect; read by the active conversation view.
- **Reaction notification side-effect (new, app)** — subscribes to
  `reaction:received`; for live reactions, pushes a toast when the conversation is
  inactive, or a `reactionMentionStore` entry when it is active and the target is a
  non-last message.
- **Conversation message list** — render the transient reaction-mention pill from
  `reactionMentionStore` (jump via `scrollToMessage` + dismiss ✕). No mute menu.
- **`ToastContainer` / `StatusDisplay`** — route `systemNotifications` to toasts
  (transient) and the connection status line (persistent); add the clickable
  reaction toast path.
- **Remove** — `EventsView`, `ActivityLogView`, `ActivityContextView`,
  `useActivityLog`, `useActivityLogStore`, `activityLogStore`, `activityNavigation`,
  `setPreviewEvent`, and the reaction-mute state therein.
- **`eventsStore`** — keep `subscriptionRequests` (→ Contacts), `mucInvitations`
  (→ Rooms), `strangerConversations` (→ Messages) and their accept/reject/ignore
  actions; retire the `systemNotifications` list UI path.

## What is NOT changing

- Reaction *sending/receiving* protocol and the on-message reaction badge.
- The accept/reject/ignore/block actions themselves (relocated, not rewritten).
- The `useRoomJoinWarning` non-anonymous guard (preserved on invitation accept).
- List segmentation by roster group / folders — still parked with XEP-0503 Spaces.

## Open items

- **Stranger handling vs message requests**: confirm "Message requests" reuses
  `strangerConversations` as-is (accept → conversation) with no new store.
- **System-event persistence**: decide how long a persistent connection alert
  stays in the status line and whether any need a dismiss affordance, now that
  there is no Events list to hold them.
- **Archive toggle vs future segmentation**: the toggle is a binary filter; if
  Decision 2 later introduces conversation filters/folders, fold Archive into
  that vocabulary rather than keeping a separate toggle.
- **`SidebarView` churn**: removing `'events'`/`'archive'` touches routing,
  `useViewNavigation`, `useKeyboardShortcuts`, `useSessionPersistence` (persisted
  view values), and tests. Decision 1 kept the `'directory'` value (did **not**
  rename to `'contacts'`), so there is no rename to sequence against; treat the
  `'archive'` removal (2A) and `'events'` removal (2B) as the churn points, each
  with a persisted-value fallback so a stored `'archive'`/`'events'` degrades to
  `'messages'` rather than breaking restore.
- **Plan split**: this design is implemented as two plans — **2A** (room
  invitations → Rooms, stranger messages → Messages, system → toast/status, empty
  then remove `EventsView`, Archive → header toggle, remove the Archive rail icon)
  and **2B** (reactions toast + in-flow mention via the new SDK event, then delete
  the activity log and remove the Events rail icon). 2A leaves the `'events'`
  destination temporarily hosting only `ActivityLogView`; 2B removes it.
