# Conversation-first navigation — relocate Contacts, redistribute roster

Date: 2026-06-24
Status: Approved design (Decision 1 only), pending implementation plan

## Problem

The sidebar exposes a permanent **Connections / directory** destination in the
top icon-rail cluster (`Sidebar.tsx`, the `Users` `IconRailNavLink` →
`view="directory"`, `pathPrefix="/contacts"`, rendering `<ContactList>`). A
person therefore exists in two co-equal top-level places at once: in **Messages**
(because there is an open conversation) and in **Connections** (because they are
a roster contact).

Feedback from the maintainer: that split doesn't land for either audience. XMPP
users are used to a roster, but a permanent *sidebar list of contacts* feels off
even to them; users coming from mainstream messengers don't have the
roster-vs-conversation mental model at all. The roster concept itself, as a
co-equal browsing destination next to conversations, is the thing that confuses.

The goal of this design (**Decision 1**) is to make **conversations the single
spine** and stop presenting the roster as a permanent peer of conversations —
**without losing roster management** (add / remove / block / approve / verify)
and without losing the "who's online" glance.

## Approach

Collapse the roster as a *browsing destination* and redistribute it across three
surfaces it already mostly has:

1. **Per-person management** stays in the contact profile
   (`ContactProfileView` + `contact-profile/ContactActionsMenu`: rename, block,
   remove, key verification). Unchanged — it is already the right home.
2. **Starting a chat / adding a contact** moves into a **"New message" picker**
   opened by a `+` in the Messages header. The picker is where the roster lives
   day-to-day: search / JID entry, contacts sorted by presence, plus "Add
   contact" and "Manage contacts" entries.
3. **Bulk roster management** becomes an **on-demand Contacts destination** that
   is *relocated*, not removed: it leaves the top conversational cluster of the
   rail and moves to the **bottom utility cluster** alongside Admin / Settings.
   It stays a real rail destination so it highlights when active (the user keeps
   a sense of "where am I").

The key reframe: the rail has two zones. The **top cluster** = conversational
destinations you *live in* (Messages, Rooms, Archive, Events, Search). The
**bottom cluster** = utility destinations you *visit to do a task, then leave*
(Contacts, Admin, Settings). Contacts belongs to the second zone — same pattern
the app already uses for Settings and Admin. This is why it does **not**
reintroduce the "permanent contacts list competing with conversations" problem:
it is a place you go to, not a permanent fixture, and its list renders as the
destination's own master column, not as a standing sidebar.

### Explicitly out of scope (parked, do not build here)

- **Decision 2 — list segmentation (roster groups / folders / presence
  filters).** This is the same organizational axis as **XEP-0503 server-side
  Spaces** (already referenced in `docs/MEP_DESIGN.md`). It must be designed
  *with* Spaces, and **vertically** (a second vertical rail, Discord/Element
  style — never horizontal scrolling tabs, which are poor on desktop). Building
  folder segmentation now risks a collision with Spaces. Parked deliberately.
- **`/events` redesign** (use the wide content area instead of the narrow
  column). Noted as a follow-up; this design only *removes subscription requests*
  from Events (they move to Contacts), it does not restructure Events.

## Behavior

### 1. Icon rail — two zones

Top cluster (conversational): Messages, Rooms, Archive, Events, Search.
Bottom cluster (utility, after the flex spacer): **Contacts**, Admin (if admin),
Settings, then the user avatar.

The `Users` rail link moves out of the top cluster into the bottom cluster. Its
route stays `/contacts`; the `SidebarView` value is renamed `'directory'` →
`'contacts'` for clarity (label already `sidebar.connections` → use a
`sidebar.contacts` key).

### 2. Contacts rail badge — actionable only

A single badge slot on the Contacts rail icon:

- **Pending subscription requests** → **red** badge with the request count.
- **Otherwise** → **no badge**.

No online-contact count badge. A count of online contacts is ambient, not
actionable, and would churn on every presence change (badge fatigue). Presence
stays visible where it is meaningful: the per-avatar status dots (conversations,
picker, Contacts list) and the "Online · N" group header inside the Contacts
screen. `aria-label` reflects the state ("Contacts, 2 pending requests" vs
"Contacts").

### 3. Messages header — `+` opens the picker

The Messages view header gains a single `+` button (matching the Rooms header's
`Plus` glyph; **no** chevron / dropdown — one action). It opens the New message
picker directly. The picker already aggregates "Add contact" and "Manage
contacts", so no header dropdown is needed.

### 4. New message picker

A modal opened by `+`:
- Search field: "Search a person or enter a JID".
- "Add contact" and "Manage contacts" rows (the latter navigates to the Contacts
  destination).
- Recents, then contacts grouped **Online** / **Offline**, each row with a
  presence dot.
- Selecting a person opens/starts the 1:1 conversation.

### 5. Contacts destination (master-detail)

Selecting Contacts renders the existing **list-in-sidebar-slot + detail-in-main**
master-detail pattern (same shape as `directory`/`settings` today), enriched:

- **List column**: a top **"Requests"** section (subscription requests, moved
  from Events) with Accept / Decline, then the roster grouped **Online · N** /
  **Offline · N**. A "Filter" affordance and an "Add" (`user-plus`) action in the
  list header.
- **Detail (main pane)**: the selected contact's `ContactProfileView` (Profile /
  Security tabs, presence, groups, subscription, primary **Message** button,
  rename / block / remove actions). On desktop the detail is a right panel; its
  `✕` collapses back to list-only (it is **not** a modal overlay).
- Entering Contacts replaces the conversation list with the Contacts experience,
  exactly as Settings does today. This is the one accepted trade-off: you don't
  see conversations *while managing contacts*; you leave and come back. The rail
  icon stays lit so position is unambiguous.

### 6. Responsive

On narrow / mobile, the master-detail unfolds into a **navigation stack** (the
app's existing responsive pattern): Contacts list full-screen → tap a person →
profile full-screen with a back arrow. No side panel, no centered modal.

### 7. Subscription requests move out of Events

Subscription requests (`useEventsStore` `subscriptionRequests`) stop feeding the
Events/Bell badge and the `EventsView` list; they feed the **Contacts** badge and
the Contacts "Requests" section instead. The Bell keeps the rest
(`mucInvitations`, `strangerMessages`, `systemNotifications`). This avoids the
same request signalling in two places.

## Components & changes

### `Sidebar.tsx` — rail zones, badge, header `+`
- Move the `Users` `IconRailNavLink` from the top cluster to the bottom cluster
  (after the `flex-1` spacer, before Admin/Settings).
- Drive its `showBadge` from pending subscription-request count only, styled red
  (not the generic brand badge). Drop any online-count.
- Replace the `directory`-only contact dropdown with a `+` button in the
  **messages** view header that opens the New message picker
  (`modalActions.open('newMessage')` or equivalent).
- `pendingCount` (currently sums `subscriptionRequests` into the Events badge)
  drops `subscriptionRequests`; that count moves to the Contacts badge.

### `sidebar-components/types.tsx` — view id
- Rename `SidebarView` `'directory'` → `'contacts'` (route stays `/contacts`).
  Update `useRouteSync` / route mapping and the `Sidebar.tsx` title switch.

### New message picker — new modal on `ContactSelector`
- New `NewMessageModal` (modal shell + `ContactSelector` core, sorted by
  presence) with "Add contact" / "Manage contacts" rows. Reuses
  `ContactSelector.tsx` rather than duplicating roster rendering. `AddContactModal`
  stays as the add-contact step the picker links to.

### Contacts destination — enrich the list
- The `contacts` view's list (currently `<ContactList>`) gains a top **Requests**
  section sourced from `useEventsStore` `subscriptionRequests`, and presence
  grouping (Online / Offline). Detail pane unchanged (`ContactProfileView`).

### `EventsView` / events badge — drop requests
- `EventsView` no longer renders `subscriptionRequests`. The Events rail badge
  (`Bell`) no longer counts them.

### `ContactProfileView` + `ContactActionsMenu` — unchanged
- Per-person management already lives here; reused as the detail pane.

## What is NOT changing

- Per-contact management actions and the profile UI (`ContactProfileView`,
  `ContactActionsMenu`) — reused as-is.
- The master-detail mechanism itself — the Contacts destination reuses the
  existing sidebar-list + main-detail pattern; no new layout engine.
- Rooms, Archive, Search, Admin, Settings destinations.
- List segmentation by roster group / folders (parked with Spaces).
- The `/events` content layout (only its data source for requests changes).

## Open items

- **Picker vs `directory` "Manage contacts" wiring**: confirm the picker's
  "Manage contacts" simply navigates to the `contacts` route (no separate state).
- **Requests source of truth**: requests render in Contacts; confirm no residual
  surfacing in Events beyond removal (no duplicate accept/decline path).
- **`SidebarView` rename**: assess churn across `useRouteSync`, tests, and any
  persisted route before renaming `'directory'` → `'contacts'`; keeping the old
  value is acceptable if the rename is costly.
