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

The design goal: keep the calm philosophy while never destroying read
state — a distance-gated anchor, applied uniformly to all rooms, with
no per-room settings.

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

1. **Distance-gated anchor, uniform for all rooms** — read state is
   never destroyed on launch; where a room opens depends on backlog
   size (see Section 2). No per-room mode flag, no settings.
2. **Viewport-driven read progress** — the read pointer advances only
   by actually viewing messages (existing IntersectionObserver
   machinery), by Esc, or by mark-all-read. Opening a big-backlog room
   anchors at the bottom, so its pointer advances to newest on open
   (Slack-style read-on-open emerges naturally); opening a small
   backlog anchors at the divider and marks read as the user scrolls
   (Telegram-grade fidelity). One rule, two emergent behaviors.
3. **Derivation approach A** — unify room and chat semantics
   (`treatDelayedAsNew: true` for rooms) rather than a separate
   reconciliation pass or MDS-only boolean badges.
4. **In scope:** Esc-marks-read, live inbound MDS consumption, deep
   jump-to-last-read, mark-all-read bulk action.

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

**Distance-gated anchor:**

- If the divider (`firstNewMessageId`) falls **within the loaded
  window** (~100 messages from cache), open **at the divider** — the
  unread messages sit below it, and the pointer advances as they are
  actually viewed. This covers virtually every small work/family room,
  the catch-up-critical case. No deep-history load is needed: the
  anchor target is already in the window.
- If the backlog is **larger than the loaded window**, open **at the
  bottom** with the jump pill — calm wins where calm matters. The
  bottom viewport advances the pointer to newest (read-on-open), which
  triggers the existing debounced (1.5 s) MDS publish.

Both behaviors are the same viewport rule; only the anchor differs.
The deep load-around path is exercised only by explicit pill clicks,
never by merely opening a room.

- The divider is derived once on activation from the read pointer — it
  now lands correctly for MAM-delivered unread. It is already decoupled
  from the pointer: it persists for the visit while the viewport
  advances `lastSeenMessageId` underneath, and clears on deactivation.
  No change to that machinery.
- **Badges vs pointer:** counts are always (re)derivable from the
  pointer. Activation zeroes them for in-session calm (existing
  behavior), but recompute events (launch hydration, inbound MDS)
  reconverge to pointer-derived truth — abandoning a backlog mid-way
  honestly resurfaces the remainder later (see Section 5).
- **Jump pill:** when a divider exists above the viewport (or beyond the
  loaded window), a pill at the top of the message area shows
  **"N new · Jump to last read"**. Clicking scrolls to the divider via
  the search-jump path (`scrollToMessage` →
  `loadMessagesAroundFromCache` → MAM-around fallback, PR #746 infra),
  so it works arbitrarily deep. If the count can't be derived from
  cache, the pill degrades to "You were away · Jump to last read". The
  pill hides when the divider is visible; the existing "jump to newest"
  FAB returns the user to the bottom.

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
  neither cache nor the MAM window, the divider anchors at the oldest
  loaded message and the pill drops its count. Jump attempts a
  MAM-around-stanza-id fetch; on failure it lands at oldest-loaded.
- **Own echo:** our MDS publish returns via PEP; the existing
  `lastConsideredSeenId` dedup prevents publish loops (pin with a test).
- **Muted rooms:** unread tracked silently (badge stays `none`); the
  divider still appears on open.
- **Mid-backlog abandonment:** opening a small-backlog room at the
  divider, reading half, and leaving keeps the pointer where reading
  stopped. The next activation re-derives the divider there, and
  recompute events restore the honest remaining count. Intentional —
  this is #855's contract.
- **Count display:** capped at "99+"; counts come from the cached
  window only — never a MAM crawl to make a number precise.

## Section 6 — Testing

- **SDK unit:** invert room-path tests asserting "delayed history ⇒ no
  marker" (`roomStore.test.ts` ~4657). New tests: fresh-join guard;
  hydration counting incl. no-double-count on window overlap; inbound
  remote-displayed badge recompute; Esc / mark-all-read pointer
  semantics; MDS echo no-loop.
- **Scroll:** gate message-list changes on `npm run test:scroll`; new
  e2e for the anchor gate (divider-in-window opens at divider;
  beyond-window opens at bottom with pill) and for pill-jump to a deep
  divider (fraction anchors are not verifiable in jsdom — e2e only).
- **App:** Esc precedence tests (reply-chip cancel beats mark-read;
  modal Esc untouched). New i18n keys translated into all 33 locales;
  asserted labels added to `test-setup.ts`.

## Out of scope

- Per-room catch-up mode flags (bookmark extension exists if ever
  needed — `notifyAll` pattern in `bookmarkItem.ts`).
- Keyboard shortcut for mark-all-read.
- Any change to rail visuals or notification sounds.
