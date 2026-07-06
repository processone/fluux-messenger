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

The design goal: keep the calm, open-at-bottom philosophy while never
destroying read state — the Slack model, applied uniformly to all rooms,
with no per-room settings.

## Decisions (from brainstorming)

1. **Slack model for all rooms** — open at the bottom; read state is
   never destroyed on launch; a quiet pill offers "jump to last read".
   No per-room mode flag, no Telegram-style open-at-marker.
2. **Read on open** — opening a room clears its badge and (via the
   bottom viewport advancing the read pointer) publishes MDS up to the
   latest message. The divider stays visible for the visit.
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

- **Open at bottom, always.** Scroll behavior unchanged.
- The "New messages" divider (`firstNewMessageId`) is derived once on
  activation from the read pointer — it now lands correctly for
  MAM-delivered unread. It is already decoupled from the pointer: it
  persists for the visit while the viewport advances `lastSeenMessageId`
  underneath, and clears on deactivation. No change to that machinery.
- Opening clears `unreadCount`/`mentionsCount` immediately (existing
  `onActivate` behavior); the bottom viewport advances the pointer to
  newest, which triggers the existing debounced (1.5 s) MDS publish.
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
- **Count display:** capped at "99+"; counts come from the cached
  window only — never a MAM crawl to make a number precise.

## Section 6 — Testing

- **SDK unit:** invert room-path tests asserting "delayed history ⇒ no
  marker" (`roomStore.test.ts` ~4657). New tests: fresh-join guard;
  hydration counting incl. no-double-count on window overlap; inbound
  remote-displayed badge recompute; Esc / mark-all-read pointer
  semantics; MDS echo no-loop.
- **Scroll:** gate message-list changes on `npm run test:scroll`; new
  e2e for pill-jump to a deep divider (fraction anchors are not
  verifiable in jsdom — e2e only).
- **App:** Esc precedence tests (reply-chip cancel beats mark-read;
  modal Esc untouched). New i18n keys translated into all 33 locales;
  asserted labels added to `test-setup.ts`.

## Out of scope

- Per-room catch-up mode flags (bookmark extension exists if ever
  needed — `notifyAll` pattern in `bookmarkItem.ts`).
- Keyboard shortcut for mark-all-read.
- Any change to rail visuals or notification sounds.
