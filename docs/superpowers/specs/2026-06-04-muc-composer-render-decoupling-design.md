# MUC composer / RoomView render decoupling

- **Date:** 2026-06-04
- **Status:** Proposed (awaiting review)
- **Area:** `packages/fluux-sdk/src/hooks/`, `packages/fluux-sdk/src/stores/roomSelectors.ts`, `apps/fluux/src/components/RoomView.tsx`, `apps/fluux/src/components/MessageComposer.tsx` (consumer), `apps/fluux/src/components/conversation/whisperTarget.ts`

## Problem

On Linux/WebKitGTK (0.16.0-beta.3), a user reports a half-freeze that
repeatedly kills `WebKitWebProcess` (while `WebKitNetworkProcess` survives),
preceded by:

```
[RenderLoopDetector] Warning: MessageComposer has rendered 30 times in 1000ms.
```

The detector suppresses warnings during sync/wake grace periods
([renderLoopDetector.ts:132](../../../apps/fluux/src/utils/renderLoopDetector.ts),
[:312](../../../apps/fluux/src/utils/renderLoopDetector.ts)), so a warning means
**steady-state churn, not background sync**. The count never reaches the 200
throw threshold — this is **not a runaway loop**; it is sustained re-rendering
of the whole composer subtree, which pegs the WebKitGTK main thread.

**Root cause (a chain, confirmed in code):**

1. `useRoomActive()` rebuilds `activeRoom` by spreading `entity + meta + runtime`
   on every room-store write
   ([useRoomActive.ts:72-79](../../../packages/fluux-sdk/src/hooks/useRoomActive.ts)).
   `RoomRuntime` holds **both `occupants` and `messages`**
   ([room.ts:255-268](../../../packages/fluux-sdk/src/core/types/room.ts)), so
   `activeRoom`'s identity changes on every incoming message, reaction, receipt,
   typing change, and presence/occupant update.
2. **Nothing is memoized** in `RoomView → RoomMessageInput → MessageComposer`, so
   `MessageComposer`'s render count *equals* `RoomView`'s. 30 renders/1000ms = 30
   room-store writes/sec — ordinary presence/message traffic in an active room.
3. The whisper presence-gate added in #444 reads the **whole** `room.occupants`
   ([RoomView.tsx:1497](../../../apps/fluux/src/components/RoomView.tsx)), and the
   composer subscribes to room churn through **two** paths: the `room={activeRoom}`
   prop ([RoomView.tsx:496](../../../apps/fluux/src/components/RoomView.tsx)) and its
   own internal `useRoomActive()` call
   ([RoomView.tsx:1490](../../../apps/fluux/src/components/RoomView.tsx)).

This is a longstanding structural coupling (predates whisper); the whisper
feature raised per-render cost enough to cross the WebKitGTK freeze threshold.

**Not catchable by static analysis** (e.g. `react-doctor`): the `useMemo` deps in
`useRoomActive` are correct, "not wrapped in `React.memo`" is not a lint rule, and
the churn rate is a runtime property of XMPP traffic. A runtime re-render profiler
(React DevTools Profiler, `react-scan`) is the right tool; the app's own
`RenderLoopDetector` already surfaced it.

## Key enabling property (verified)

The store preserves sub-references when spreading a runtime entry. `addMessage`
does `{ ...existingRuntime, messages: newMessages }`
([roomStore.ts:932](../../../packages/fluux-sdk/src/stores/roomStore.ts)), leaving
the `occupants` Map reference **unchanged** on message traffic. Therefore a
selector that returns `runtime.occupants`
(`roomSelectors.runtimeOccupantsFor`,
[roomSelectors.ts:550](../../../packages/fluux-sdk/src/stores/roomSelectors.ts))
yields the same reference across messages — a subscriber re-renders only on real
occupant changes. The same holds for `typingFor` (the `typingUsers` Set is
preserved).

## Goals

- The MUC composer re-renders only when *its own* inputs change (text, whisper
  target, the counterpart's presence, reply/edit/upload state, occupants for
  mentions) — **not** on every message/typing/receipt in the room.
- The whisper presence-gate watches a **single** occupant, **only** in whisper
  mode.
- RoomView re-renders stay cheap: heavy children bail out via memoization.

## Non-goals (YAGNI)

- Eliminating RoomView's own function re-run. A cheap parent re-render whose
  heavy children bail out is acceptable.
- The 1:1 `ChatView` analog (same shape) — deferred to a fast-follow.
- The unrelated beta-3 reports (notification ACL, dynamic-import probe,
  DMABUF/EGL) — tracked separately.

## Design

### 1. SDK — two focused hooks + one selector

New, thin wrappers over selectors that already exist:

- **`useRoomOccupants(roomJid: string): Map<string, RoomOccupant>`** —
  `useRoomStore(roomSelectors.runtimeOccupantsFor(roomJid))`. Reference-stable
  across message/typing churn; re-renders only on occupant change.
- **`selectWhisperCounterpartPresent(state, roomJid, target): boolean`** — pure
  selector: O(1) read of the single counterpart occupant (occupant-id aware,
  nick fallback — reuses `whisperTargetPresent`). Returns `false` when `target`
  is null.
- **`useWhisperCounterpartPresent(roomJid, target): boolean`** —
  `useRoomStore((s) => selectWhisperCounterpartPresent(s, roomJid, target))`.
  Runs cheaply on each store write but re-renders the consumer **only when the
  boolean flips**.

Exported from `index.ts` + `react/index.ts`. The app's `@fluux/sdk` test mock
(`apps/fluux/src/test-setup.ts`) must export them too (parity).

### 2. Composer (`RoomMessageInput`) — memoize + narrow

- Wrap `RoomMessageInput` in `React.memo`.
- **Remove `room={activeRoom}`**; pass stable primitives: `roomJid`, `roomName`,
  `roomNickname`.
- Obtain occupants internally via `useRoomOccupants(roomJid)` (re-renders on
  occupant change only) for **mention autocomplete** and to derive
  `shouldSendTypingNotifications` (`occupants.size < MAX_ROOM_SIZE_FOR_TYPING`) —
  so the typing flag is not a churn-dependent prop.
- Replace the whisper gate's `room.occupants` read with
  `useWhisperCounterpartPresent(roomJid, whisperTarget)`.
- Replace the internal **`useRoomActive()`** with non-subscribing action access
  (draft ops / `clearFirstNewMessageId` are stable store methods).
- In RoomView, stabilize the callbacks/objects passed to the now-memoized
  composer: `scrollToBottom`, `handleInputResize` (`useCallback`),
  `uploadStateObj` (`useMemo`), and the existing reply/edit/whisper handlers.

`MessageComposer` itself is unchanged (still presentational); memoizing
`RoomMessageInput` is the boundary because the composer's many derived props
(`replyInfo`, `renderMentionInput`, `mentionDropdown`, `sendBadge`) originate
there.

### 3. RoomView — cheapen re-renders (don't eliminate them)

- `React.memo` the heavy children with stabilized props: `RoomMessageInput`,
  `RoomMessageList`, `RoomHeader`, `PollBanner`, occupant panel. (MessageList
  still re-renders on new messages — correct; the composer no longer does.)
- `useMemo` the per-render computations that currently re-run on every churn:
  `messagesById = createMessageLookup(activeMessages)` and the `displayMessages`
  filtering.

### 4. Testing

- **Render-count regression test** (the proof — WebKitGTK can't be reproduced in
  CI): mount the composer against a real `roomStore`; fire `addMessage` N times →
  assert the composer's render count does **not** increase; fire an occupant
  join → assert exactly one re-render; toggle the counterpart's presence → assert
  the gate boolean flips.
- Unit-test `selectWhisperCounterpartPresent`: present / left / nick recycled by a
  different occupant-id / room without occupant-id support (nick fallback).
- Existing whisper, mention-autocomplete, and draft suites stay green; update the
  app SDK mock with the new exports.
- Gate before commit: `npm test` (no stderr), `npm run typecheck`, `npm run lint`.

## Risks

- **Memo prop-stability regressions:** if any prop passed to a memoized child is
  still recreated each render, the memo silently no-ops (no error, just no win).
  The render-count test guards the composer specifically.
- **Mention autocomplete** depends on occupants; `useRoomOccupants` keeps that
  correct while still re-rendering on occupant change (acceptable — bounded).
- **Sensitive area:** whisper send-gate and draft-discard behavior shipped in
  #443/#444; their existing tests must remain green to prove no behavior change.
