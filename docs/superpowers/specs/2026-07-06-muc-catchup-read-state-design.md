# MUC Catch-up & Read-State Design

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation plan
**Resolves:** [#855](https://github.com/processone/fluux-messenger/issues/855) (preserve read state on launch), [#851](https://github.com/processone/fluux-messenger/issues/851) (Esc marks read), completes [#853](https://github.com/processone/fluux-messenger/issues/853) (two-way cross-client read-state sync)

## Problem

Since 0.17.0, read states work inside Fluux but MUC rooms are treated as
"caught up" on every launch: room activation runs with
`treatDelayedAsNew: false`, so MAM/history-replay messages (flagged
`isDelayed`) never produce an unread marker and never increment unread
counts. Users who rely on small work/focus rooms lose their read position
whenever they restart the client, and until #854 the wrong XEP-0490
payload meant read state never reached other clients either.

The design goal: never destroy read state, and adopt the anchoring
behavior users know from every major client — open at the last-read
position — as a single, predictable rule for all rooms, with no
per-room settings. Calm is preserved through the Esc valve and
jump-to-present, not by discarding read positions.

## Competitive background (verified 2026-07-06)

- **Slack's default** is *"Start me where I left off, and mark the
  channel read"* — it opens channels **at the last-read position** with
  the red NEW line. "Start me at the newest message" variants are
  opt-in preferences, not the default.
- **Discord** does not auto-scroll to newest with a real backlog: it
  keeps a persistent unread indicator, shows a "N new messages since…"
  ribbon (click = jump to divider, X = dismiss), and **Esc marks the
  channel read and jumps to the bottom**.
- Telegram, Matrix, Rocket.Chat likewise preserve read position and
  offer Esc/mark-read affordances. The ecosystem consensus is
  *preserve read state; anchor at or near it; Esc to dismiss*.

## Decisions (from brainstorming)

1. **Standard last-read anchor, one behavior for all rooms** — a room
   with unread opens at the "New messages" divider; a caught-up room
   opens at the bottom. Read state is never destroyed on launch. No
   per-room mode flag, no settings, no distance gating (an earlier
   distance-gated hybrid was rejected as unpredictable; an earlier
   "always bottom, read-on-open" choice was superseded by this one).
2. **Viewport-driven read progress** — the read pointer advances only
   by actually viewing messages (existing IntersectionObserver
   machinery), by Esc, or by mark-all-read. Opening a room does NOT
   mark it read; reading it does. Jumping to present counts as viewing
   the newest message, which advances the pointer (standard semantics —
   Telegram behaves the same).
3. **Derivation approach A** — unify room and chat semantics
   (`treatDelayedAsNew: true` for rooms) rather than a separate
   reconciliation pass or MDS-only boolean badges.
4. **In scope:** Esc-marks-read, live inbound MDS consumption, deep
   last-read anchoring, mark-all-read bulk action.

## Section 1 — Core read-state model

**One rule everywhere:** unread state is derived from the persisted read
pointer (`lastSeenMessageId`, reconciled with the XEP-0490 MDS position
via the existing first-open-per-session entry fold), regardless of how
messages arrived — live or delayed/MAM replay. Room activation switches
to `treatDelayedAsNew: true`, same as 1:1 chats
(`notificationState.onActivate`).

**Fresh-join guard:** a room with *no* prior read state — no local
`lastSeenMessageId` and no MDS position — is caught up: the pointer
snaps to the newest message, no marker, no counts. Joining a large
public room never presents replayed history as unread. Unread only
accumulates relative to a position the user actually established by
reading. On a new device, the MDS fetch on connect seeds read positions
before rooms are first opened.

**Badge hydration:** with the flag flipped, catch-up replay flows
through the existing counting path (`onMessageReceived`) so unopened
rooms regain their badges after launch. Constraint: only messages
strictly *after* the read pointer count — window-overlap refetches must
not double-count. Mentions in the gap increment `mentionsCount` so the
red/grey distinction stays truthful.

**Presentation unchanged:** the rail keeps the two-tier model (grey dot
= ambient unread; red = mentions / notifyAll / DMs; muted = nothing).
No numbers on the rail. No staleness cap — read state is remembered
indefinitely (#855's contract).

## Section 2 — Opening a room

**One anchor rule:** a room with unread messages opens **at the "New
messages" divider**, with the unread below it; a caught-up room opens
at the bottom. Same for 1:1 chats.

- **Anchor resolution:** if the divider is within the loaded window
  (~100 cached messages), it is a plain scroll target. If it is deeper,
  activation loads history *around the pointer* via the existing
  search-jump path (`messageCache.getMessagesAround` →
  `loadMessagesAroundFromCache` → MAM-around fallback, PR #746 infra)
  before anchoring. Cache-first: MAM is only queried when the slice
  isn't cached. If the pointer is unresolvable, anchor at the oldest
  loaded message (Section 5).
- **First activation vs revisit:** the divider anchor applies on the
  first activation of a session — the same moment the divider is
  derived and the MDS entry fold runs. In-session revisits keep the
  existing `ScrollStateManager` restore behavior (saved content anchor,
  or bottom if the user left at the bottom); the freshly re-derived
  divider is then reachable on screen or via the pill.
- The divider is derived once on activation from the read pointer — it
  now lands correctly for MAM-delivered unread. It is already decoupled
  from the pointer: it persists for the visit while the viewport
  advances `lastSeenMessageId` underneath, and clears on deactivation.
  No change to that machinery.
- **Reading, not opening, marks read:** the pointer advances as unread
  messages enter the viewport, each advance feeding the existing
  debounced (1.5 s) MDS publish. **Jump to present** (existing FAB)
  brings the newest message into view, which advances the pointer to
  newest — one tap to skip the backlog, standard semantics.
- **Badges vs pointer:** counts are always (re)derivable from the
  pointer. The active room shows no badge (existing behavior); on
  deactivation and on recompute events (launch hydration, inbound MDS)
  counts reconverge to pointer-derived truth — leaving a backlog
  half-read honestly resurfaces the remainder (see Section 5).
- **Jump pill (secondary affordance):** if the user moves away from the
  divider toward the present without reading (e.g. via the FAB), a
  pill at the top of the message area shows **"N new · Jump to last
  read"** so the reading position stays one click away until the visit
  ends. It hides while the divider is visible. If the count can't be
  derived from cache, it degrades to "You were away · Jump to last
  read".

## Section 2b — History loading (MAM direction)

The existing catch-up is already **forward-first** and stays that way
(`selectCatchUpQuery`): a forward `{start}` cursor from the recorded
gap boundary → newest pre-session cached message → persisted preview
timestamp, paging oldest-first via RSM `after` (50×100 stanzas
background per room, 500 pages manual repair, forward-gap markers +
"Load missing messages" on cap). `before:''` fetch-latest is the
empty-cache last resort only. The separate fast preview path keeps
sidebars current while crawls run.

This is the right shape for the divider anchor: forward filling from
the contiguity edge guarantees the unread slice (pointer → live edge)
is cached, contiguous, and countable. The cursor deliberately stays at
the newest *cached* message (data-completeness state), never the read
pointer (UX state) — the cache persists across sessions, so an ignored
big room fetches only its new delta each launch, regardless of how far
its pointer lags.

Two refinements:

- **MDS pointer as MAM cursor (new device / empty cache):** when a
  read pointer exists but no local cache does, forward-page
  `after=<mds-stanza-id>` instead of `before:''` fetch-latest — the
  XEP-0490 stanza-id (`by` = room JID for MUC, own bare JID for 1:1)
  *is* the archive ID, hence a valid RSM cursor. Bounded by the usual
  page caps; on `item-not-found` (purged ID), fall back to
  fetch-latest with the degraded anchor of Section 5.
- **Forward-gap interplay:** a recorded gap inside the unread slice
  makes the pill count a lower bound ("N+ new"); the existing "Load
  missing messages" action heals crossing it. Divider anchoring is
  unaffected.

## Section 3 — Esc and mark-all-read

**Esc precedence** (one `keydown` listener in the conversation view,
respecting `event.defaultPrevented`; no global shortcut framework):

1. Open overlay (modal, picker, menu) → closes it (existing local
   handlers win).
2. Composer transient state (reply chip, edit mode, mention popup) →
   cancels it.
3. Otherwise → **mark read**: pointer to newest, divider + pill clear,
   re-anchor to bottom, MDS publishes. No-op if already read at bottom.

Identical in 1:1 chats and rooms.

**Mark-all-read:** an action in the rooms sidebar header overflow menu.
Advances every joined room's pointer to its newest cached message,
clears counts; publishes ride the existing MDS debounce. No keyboard
shortcut in v1.

## Section 4 — MDS sync (XEP-0490), both directions

- **Outbound** (works post-#854): pointer advance → 1.5 s debounce →
  publish with room JID in `stanza-id by`. Esc and mark-all-read use
  the same path. Closes #853's original repro.
- **Inbound (new):** when a remote displayed-marker arrives for a
  **non-active** room, `applyRemoteDisplayed` additionally recomputes
  `unreadCount`/`mentionsCount` from cache after the new position, so
  reading on another device clears the badge here in real time.
- **Active room:** entry-fold gating unchanged — a mid-visit remote
  marker never moves the divider (lesson from PR #737 /
  `mdsConsumedThisSession`).

## Section 5 — Edge cases

- **Pointer beyond retention:** if the last-read message resolves in
  neither cache nor a MAM-around-stanza-id fetch, activation anchors at
  the oldest loaded message, places the divider there, and the pill
  drops its count. Opening must degrade gracefully, never error.
- **Own echo:** our MDS publish returns via PEP; the existing
  `lastConsideredSeenId` dedup prevents publish loops (pin with a test).
- **Muted rooms:** unread tracked silently (badge stays `none`); the
  divider still appears on open.
- **Mid-backlog abandonment (resume):** reading half a backlog and
  leaving keeps the pointer where reading stopped. The next activation
  re-derives the divider there and anchors on it, and recompute events
  restore the honest remaining count. Intentional — this is #855's
  contract. Conversely, jumping to present or Esc before quitting
  counts as caught up (standard semantics; the skip was the user's
  choice).
- **Count display:** capped at "99+"; counts come from the cached
  window only — never a MAM crawl to make a number precise.

## Section 6 — Testing

- **SDK unit:** invert room-path tests asserting "delayed history ⇒ no
  marker" (`roomStore.test.ts` ~4657). New tests: fresh-join guard;
  hydration counting incl. no-double-count on window overlap; inbound
  remote-displayed badge recompute; Esc / mark-all-read pointer
  semantics; MDS echo no-loop.
- **Scroll:** gate message-list changes on `npm run test:scroll`; new
  e2e for anchoring (unread opens at divider — both in-window and deep
  load-around cases; caught-up opens at bottom), for jump-to-present
  advancing the pointer, and for the pill returning to the divider
  (fraction anchors are not verifiable in jsdom — e2e only).
- **App:** Esc precedence tests (reply-chip cancel beats mark-read;
  modal Esc untouched). New i18n keys translated into all 33 locales;
  asserted labels added to `test-setup.ts`.

## Out of scope

- Per-room catch-up mode flags (bookmark extension exists if ever
  needed — `notifyAll` pattern in `bookmarkItem.ts`).
- Keyboard shortcut for mark-all-read.
- Any change to rail visuals or notification sounds.
