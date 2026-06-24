# Dissolve the Events tab — redistribute events, Archive as a toggle

Date: 2026-06-24
Status: Approved design, pending implementation plan
Companion to: `2026-06-24-conversation-first-contacts-design.md` (Decision 1).
Build that one first — this design assumes subscription requests already live in
the Contacts destination.

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
| Reactions received (`reaction-received`) | **Conversation** › badge on the message + transient in-flow mention |
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

Reactions stop being log entries. Two complementary representations:

- **Badge on the message** — the persistent record (who reacted, counts). Already
  rendered on messages; unchanged.
- **Transient in-flow mention** — shown only when a received reaction targets a
  message that is **not the last** one (so an off-screen reaction is still
  noticed). Rendered distinctly from a message bubble: a centered, muted pill
  ("❤️ Marie reacted to '…' · See") with a jump ("See" scrolls to the target via
  the message's `data-*` id) and a `⋯` menu. It is transient — dismissible and
  not persisted as a message.

**Muting moves to the point of annoyance.** The transient mention's `⋯` offers
two scopes: "Mute reactions for this message" and "Mute reactions for this
conversation". The per-conversation scope is also a **"Reactions" toggle added to
the existing Notifications submenu** in the conversation header
(`HeaderSubmenuButton` / `HeaderOverflowKebab`, the group already holding
"All messages" / "Mentions only"). Muting suppresses the *notification* only —
badges remain visible (the toggle's subtitle says so). The existing reaction-mute
state (`mutedReactionConversations` / `mutedReactionMessages` and the
mute/unmute actions) is retained and drives both the transient mention and the
toggle; only its old UI host (the log) is removed.

### 5. System / connection events → toast + status

- Transient notifications → **`ToastContainer`** (already present).
- Persistent / severe (auth-error, resource-conflict / "replaced") → surfaced in
  the **connection status line** (the bottom user panel / `StatusDisplay`), where
  connection state already lives. No standing list. `systemNotifications` /
  `dismissNotification` storage is reduced to whatever the status line needs;
  the Events list rendering of them is removed.

### 6. Activity log → deleted

Remove `ActivityLogView`, `ActivityContextView`, the `useActivityLog` hook and
its `activityLog` store, `setPreviewEvent`, and the `activityNavigation` helper.
Once each item shows its own resolved state in its own home, a separate
cross-cutting timeline is redundant. (The reaction-mute state in §4 is the one
piece kept and relocated.)

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
- **Conversation message list** — add the transient reaction-mention component
  (render when the reaction targets a non-last message; jump + `⋯` mute menu).
- **`HeaderSubmenuButton` / header Notifications group** — add a "Reactions"
  toggle (per-conversation reaction-notification mute).
- **`ToastContainer` / `StatusDisplay`** — route `systemNotifications` to toasts
  (transient) and the connection status line (persistent).
- **Remove** — `EventsView`, `ActivityLogView`, `ActivityContextView`,
  `useActivityLog` + `activityLog` store, `activityNavigation`, `setPreviewEvent`.
- **`eventsStore`** — keep `subscriptionRequests` (→ Contacts), `mucInvitations`
  (→ Rooms), `strangerConversations` (→ Messages) and their accept/reject/ignore
  actions; retire the `systemNotifications` list UI path; the reaction-mute state
  moves with §4.

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
- **`SidebarView` churn**: removing `'events'`/`'archive'` touches routing and
  tests; sequence after Decision 1's `'directory'`→`'contacts'` rename.
