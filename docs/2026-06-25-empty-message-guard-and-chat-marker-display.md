# Empty-message guard + chat-marker display follow-up

**Date:** 2026-06-25
**Status:** Part 1 (empty-message guard) — DONE this branch. Part 2 (display markers) — PLANNED, separate code run.

---

## Background — the "empty Cynthia row"

In the XSF room (`xsf@muc.xmpp.org`) a message attributed to *Cynthia* rendered as a
blank bubble. Investigation of an XMPP trace showed:

- Cynthia sent **no message body** to the room in the captured session — only presence
  flapping (repeated `status code="333"` "recipient unavailable" kicks + rejoins as her
  server connection dropped).
- The blank row was a **pre-existing cached message**: the room's MAM catch-up `start`
  (`2026-06-25T17:15:14.214Z`) matched the row's timestamp exactly, and the catch-up
  cursor is derived from the newest cached message (`selectCatchUpQuery`).
- The only body-less *message-shaped* stanzas the room delivers are **XEP-0333 `<displayed>`
  chat markers** (singpolyma's, captured live). These were always correctly dropped.

### Root cause (Part 1)

The store-write gates accepted a message when its **raw `<body>`** was non-empty, but the
message was then stored with **`processedBody`** — the body *after* XEP-0428 fallback
stripping. A message whose body is entirely a fallback (e.g. a XEP-0461 reply quote with no
new text, or a whole-body `<fallback><body/></fallback>`) strips to `''` and was stored as a
blank row. Nothing guarded `processedBody` emptiness.

### Fix shipped (Part 1)

- `hasRenderableContent()` in `core/modules/messagingUtils.ts` — post-parse gate: a message
  with empty `processedBody` and no attachment / poll / poll-closed / encrypted payload is
  **dropped** instead of stored. Wired into all four store-write paths: `parseRoomArchiveMessage`,
  `parseArchiveMessage` (MAM), `processRoomMessage`, `processChatMessage` (live).
- `isRenderableStoredMessage()` in `utils/messageRenderability.ts` — read-side complement:
  `messageCache.getMessages` / `getRoomMessages` skip legacy blank rows already on disk, so the
  existing stale artifact disappears and can no longer seed a catch-up cursor as the newest row.
  Retraction tombstones, polls, attachments and encrypted placeholders are explicitly kept.

Tests: `messagingUtils.test.ts` (`hasRenderableContent`), `MAM.e2ee.test.ts` (room + 1:1
archive drop + positive control), `Chat.test.ts` (live 1:1 drop), `messageRenderability.test.ts`
+ `messageCache.test.ts` (read-side prune + tombstone kept).

---

## Part 2 — Display chat markers as read indicators (FUTURE, separate run)

Today incoming XEP-0333 `<displayed>` markers from **other** participants are *dropped* (they
carry no body, so the gate filters them). The only marker plumbing that exists is
`mdsSideEffects.ts`, which publishes **our own** read position via XEP-0490 (MDS) — it does not
surface anyone else's read state.

We may want to **consume** those markers and display read indicators the way Conversations /
monocles do — e.g. "seen by" / read avatars at the last-read message — rather than silently
discarding them.

### Why it's deferred

It is a feature, not a correctness fix. It needs its own design pass (UI + data model + perf),
and Part 1 must land first so markers are cleanly separated from renderable messages.

### Design sketch / open questions for the next run

- **Capture point.** Add an explicit `<displayed>` (and optionally `<received>`) handler in
  `Chat.handleMessageInternal` *before* the body-presence gate, so markers become first-class
  read-state signals instead of being dropped. Mirror it on the MAM archive path so read state
  survives catch-up.
- **Data model.** Per-conversation read state keyed by occupant. For rooms map the marker's
  XEP-0421 `occupant-id` → display name; for 1:1 it's just the peer. Store the highest
  acknowledged stanza-id per reader; never move it backwards.
- **UI.** 1:1: a single "seen" tick / timestamp on the last outgoing read message. Rooms:
  aggregated "seen by N" with an avatar row at the last-read message (don't render a marker per
  occupant inline).
- **Scale & privacy.** Large public rooms (XSF ≈ 169 occupants) can emit a high volume of
  markers — coalesce, cap the displayed set, and consider not tracking read state for very large
  rooms. Respect that some users disable read receipts.
- **Reuse.** The read-position resolution in `mdsSideEffects.ts` (stanza-id mapping, room-vs-1:1
  routing, seed-time stash/self-heal) is a good reference for resolving inbound markers too.
- **Guard interaction.** Whatever consumes markers must `return { handled: true }` so they never
  fall through to the renderable-message path that Part 1 now also guards.
