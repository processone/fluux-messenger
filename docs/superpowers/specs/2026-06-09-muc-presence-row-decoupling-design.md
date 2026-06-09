# MUC presence-churn row decoupling (half-freeze #2)

Date: 2026-06-09
Status: Approved (design)
Branch: `fix/muc-presence-row-decoupling`

## Problem

In an active MUC, every presence stanza (join/leave, show/status flapping during
netsplits or presence probes) re-renders the **entire** room message list, not
just the affected rows. The work is real per row — sender re-resolution,
`MessageBody` re-tokenization, `Avatar` recompute — and because `MessageList` is
not virtualized, the mounted-row count (and therefore the per-stanza cost) grows
as history accumulates. This is the sustained sub-threshold render storm behind
the reported "half-freeze" (it stays under the `renderLoopDetector` 200/1000ms
throw and the rows are un-instrumented, so it produces no log). It is the second
of two root causes; the first (an avatar blob-URL memory leak) is fixed
separately on `fix/avatar-blob-url-leak-sm-resume`.

## Root cause

`renderMessage` passes the whole `room` object into the memoized
`RoomMessageBubbleWrapper` (`apps/fluux/src/components/RoomView.tsx:968`), and the
wrapper resolves each sender **internally** from `room.occupants` /
`room.nickToJidCache` / `room.nickToAvatarCache`. `roomStore.addOccupant` replaces
the `occupants` Map (and, for non-anonymous rooms, the two cache Maps) on every
presence stanza (`packages/fluux-sdk/src/stores/roomStore.ts:603`), so the `room`
reference fed to the rows changes every stanza and the wrapper's shallow memo
busts for **every** row.

Two facts make a targeted fix possible:

1. **Rows display live presence.** `RoomView.tsx:1357` passes
   `avatarPresence={... getPresenceFromShow(occupant.show) ...}`, so we cannot
   simply ignore presence churn (unlike the 1:1 `ChatView`, which passes no
   presence and gets away with the identity-only `useContactIdentities`). The fix
   must be **per-row granular**: when occupant X's presence changes, only X's
   rows re-render.
2. **The store already preserves per-occupant object refs.** `addOccupant` does
   `new Map(existing.occupants)` then sets only the one changed occupant
   (`roomStore.ts:609-610`), so `occupants.get(nick)` returns a **stable
   reference** for every unchanged occupant. This is what enables per-row
   granularity without a manual memo cache.

## Goal / non-goals

**Goal:** A presence change for occupant X re-renders only the rows authored by X;
all other rows' memo bails. No behavioral change to what rows display (the
presence dot still updates for the changed occupant).

**Non-goals (explicitly out of scope):**
- Virtualizing `MessageList` (caps blast radius but touches the delicate
  WebKitGTK scroll-correction / ResizeObserver path; deferred unless A proves
  insufficient).
- Instrumentation / detector changes (the separate EWMA sustained-rate detector
  and row instrumentation tracked in `project_halffreeze_audit`).
- The 1:1 `ChatView` path (already decoupled via `useContactIdentities`).

## Approach: invert sender resolution (resolve in the list, pass results down)

Move the per-message sender resolution **out** of `RoomMessageBubbleWrapper` and
**into** `renderMessage` (the list layer, which already re-runs per stanza
cheaply — Map lookups, not React re-renders). The wrapper stops referencing
`room` and receives only the resolved values.

```
RoomMessageList                       (re-renders ~1×/stanza — under threshold)
  └─ selfOccupant = selectSelfOccupant(occupants, myNick)    (memoized once)
  └─ renderMessage(msg)                                       (cheap, per message)
       └─ resolveRoomSender(msg, room, contactsByJid, selfOccupant) → SenderSlice
       └─ <RoomMessageBubbleWrapper  ...sliceProps,  NO `room`  />   (memo bails per-row)
```

### Why the memo now bails per-row (the crux)

React's shallow memo compares **objects by reference, primitives by value**. The
wrapper receives only:

- `occupant`, `selfOccupant` — **object refs**, kept stable for unchanged
  occupants by `addOccupant`;
- everything else — **primitives** (`avatarPresence`, `senderAvatar`,
  `resolvedSenderName`, `senderRole`, `senderAffiliation`, `senderBareJidForBan`,
  `canModerate`, `canBan`, `counterpartPresent`) plus stable scalars
  (`roomJid`, `myNick`, `joined`, `supportsReactions`).

So for an unchanged sender, every prop is reference-equal (objects) or
value-equal (primitives) → the default shallow memo bails. No manual per-row memo
cache is needed.

**Invariant the implementation must hold:** never pass a freshly-built
object/array/function *per message*. Role + affiliation go as two primitives, not
a `{role, affiliation}` object. `contactsByJid` is already identity-stable (PR
#468) and is passed through unchanged.

## New module + interface

New pure, unit-testable file `apps/fluux/src/components/conversation/roomSenderResolution.ts`,
lifting the resolution logic verbatim out of the wrapper:

```ts
export interface ResolvedRoomSender {
  occupant: Occupant | undefined          // stable ref from the store
  occupantIdMatchNick: string | undefined
  avatarPresence: 'online' | 'away' | 'dnd' | 'offline' | undefined
  senderAvatar: string | undefined
  resolvedSenderName: string
  senderRole: Role | undefined
  senderAffiliation: Affiliation | undefined
  senderBareJidForBan: string | undefined
  canModerate: boolean
  canBan: boolean
  counterpartPresent: boolean             // whisper rows only; true otherwise
}

export function selectSelfOccupant(
  occupants: ReadonlyMap<string, Occupant>,
  myNick: string | undefined,
): Occupant | undefined

export function resolveRoomSender(
  message: RoomMessage,
  room: Room,                              // read-only; not forwarded to the row
  contactsByJid: ReadonlyMap<string, ContactIdentity>,
  selfOccupant: Occupant | undefined,
): ResolvedRoomSender
```

`RoomMessageBubbleWrapper`'s prop interface loses `room` and gains the
`ResolvedRoomSender` fields as discrete props. `knownNicks` stays as a prop but
must be **stabilized** so its ref changes only when the nick set actually changes
(today it is `useMemo`'d on `room.occupants`, whose ref is replaced on every show
flap, so it returns a new `Set` and busts every row — see Edge cases).

## Edge cases (residual re-render is correct and rare)

- **Self role change** (I am promoted/demoted/modded): `selfOccupant` ref changes
  → `canModerate`/`canBan` recompute for all rows → all rows re-render once.
  Correct (moderation affordances genuinely change globally) and rare.
- **Nick change:** occupant re-keyed; occupant-id fallback still resolves; that
  sender's rows re-render once.
- **Occupant leaves:** rows fall back to `nickToAvatarCache`; `avatarPresence`
  → `offline`; that sender's rows re-render once.
- **`knownNicks`:** must not re-bust the memo on a plain show flap. It is derived
  from `room.occupants.keys()`; a show change does not change the key set, but it
  *does* replace the `occupants` Map ref, so the `useMemo([room.occupants])`
  recomputes and returns a new `Set` ref. Mitigation: key `knownNicks`'s memo on
  a stable nick-set signal, or pass it as it is today only if measurement shows it
  doesn't dominate (it is a single shared prop across all rows; a new ref busts
  every row). **Decision: stabilize `knownNicks` so its ref changes only when the
  nick set actually changes.** This is part of the fix, not optional.

## Testing

- **Unit:** `roomSenderResolution.test.ts` — `resolveRoomSender` covers
  nick-match, occupant-id fallback, leave→cache fallback, contact-name fallback,
  moderation/ban permission matrix, whisper `counterpartPresent`.
- **Render-count guard** (mirrors `messageRowMemo.test.tsx` /
  `packages/fluux-sdk/src/stores/RENDER_PERF_TESTS.md`): render a room with N
  messages from several distinct occupants, flap one occupant's `show`, assert
  only that occupant's rows re-render (count == that occupant's message count,
  not N). A second assertion: a plain message append still re-renders ~0 existing
  rows (no regression of the existing stableRoom behavior).
- **Correctness:** the flapped occupant's `avatarPresence` prop reflects the new
  show value (granular, not dropped).

## Risks

- **Completeness:** every `room.*` read currently in the wrapper must be lifted,
  or the memo still busts. Enumerated set is small: `occupants` (sender +
  self-occupant + occupant-id loop + `whisperCounterpartPresent`),
  `nickToJidCache`, `nickToAvatarCache`, `nickname`, `jid`, `joined`,
  `supportsReactions`. The render-count guard catches a miss.
- **React Compiler:** keep the resolution as a plain pure function called in
  render; do not introduce render-phase ref writes that call functions (a known
  compiler-bail trap, per `project_message_row_render_perf`).
- No scroll/virtualization code is touched, so the WebKitGTK scroll-correction
  path is unaffected.

## Out of scope / follow-ups

Virtualization, the EWMA sustained-rate detector, row instrumentation, and the
lower-priority cleanups remain tracked in `project_halffreeze_audit` and are not
part of this change.
