# Whisper Operation Parity (XEP-0045 §7.5) — Design

- **Date:** 2026-06-24
- **Status:** Approved (design); pending implementation plan
- **Related:** `packages/fluux-sdk/src/core/modules/Chat.ts` (`sendWhisper`, `sendCorrection`, `sendReaction`, `sendRetraction`, `sendChatState`, receive-side `handleMessageInternal`), `apps/fluux/src/components/RoomView.tsx`, `apps/fluux/src/components/conversation/MessageBubble.tsx`, `apps/fluux/src/components/conversation/whisperTarget.ts`. MUC reference-id rules: `memory/project_muc_reference_id_rules.md`.

## Context

A whisper (XEP-0045 §7.5 private message) is sent as `type='chat'` to `room@conf/nick` with an `<x xmlns='http://jabber.org/protocol/muc#user'/>` marker and a `<no-store>` hint (`Chat.ts:957` `sendWhisper`). It is addressed privately to a single occupant and is never archived on the server.

Every other message operation routes through methods that model only **two** wire shapes:

```ts
const recipient = type === 'chat' ? getBareJid(to) : to   // chat → bare JID; groupchat → room JID
```

There is no whisper routing. The room hooks (`useRoomActive.ts:220`, `useRoom.ts`, `useRoomActions.ts`) hardcode `'groupchat'` for corrections, reactions, and retractions, and the room toolbar (`MessageBubble.tsx:397`) gates edit/react/delete on `isOutgoing`/`canModerate` with **no `isPrivate` check**. As a result, any operation on a whisper is re-sent as a **public groupchat message to the room bare JID** — broadcast to everyone in the room.

Locally, the optimistic store update (`room:message-updated`) only patches the body and keeps `isPrivate: true`, so Fluux's own view still renders a private edit. This is the user-reported symptom: *"the message is no longer private once it is edited"* on the wire, while *"in Fluux itself everything looks correct."*

### Audit (what leaks today)

| Operation | XEP | Wire today on a whisper | Leaks |
|---|---|---|---|
| Correction (edit) | 0308 | `type=groupchat` → room JID, corrected body broadcast | Yes (reported) |
| Reaction | 0444 | `type=groupchat` → room JID, `<reactions id=…>` referencing the whisper id | Yes |
| Retraction (delete own) | 0424 | `type=groupchat` → room JID, retract referencing whisper id | Yes |
| Typing while whispering | 0085 | `composing`/`paused` to room JID (`RoomView.tsx:1831`) | Yes (metadata) |
| Moderation (delete incoming as mod) | 0425 | moderation referencing whisper id → room | Edge (server rejects; still wrong) |
| Link preview (fastening) | 0422 | not sent — whisper send returns early (`RoomView.tsx:1766`) before `processLinkPreview` | No today (latent) |
| Reply | 0461 | re-enters whisper mode (`RoomView.tsx:340`) | No (already whisper-aware) |

The **receive side** already declares these sub-features out of scope: `Chat.ts:251-264` short-circuits any incoming whisper to `processRoomWhisper` *before* the reaction/correction/retract handlers, so a peer's whisper-correction renders as a brand-new whisper.

## Goals

- Corrections, reactions, and retractions on a whisper are addressed **privately to the one occupant** (`room@conf/nick`, `type=chat`, `muc#user`, `no-store`), never broadcast to the room — both when sent and when received.
- Typing indicators while composing a whisper are sent **privately to the target**, not the room.
- The leak is **structurally impossible**: a caller cannot re-introduce it by passing the wrong `type`.
- Operations survive a counterpart **nick change** (re-resolved via occupant-id) and are **refused** (never broadcast) when the counterpart has left.
- Own-device **carbon sync**: a whisper operation performed on one device applies correctly (as an edit/reaction/retraction, not a new whisper) on the user's other devices.
- Zero regression to public room operations and 1:1 chat operations.

## Non-goals

- **MUC end-to-end encryption** for whispers or their operations. A whisper is a MUC-scoped private message and skips the 1:1 E2EE path today (`sendWhisper` applies no E2EE); whisper operations keep that behaviour. MUC E2EE remains a separate later phase.
- **Server archival** of whispers or their operations. Whispers stay `<no-store>`; durability is local plus carbon sync only.
- **Cross-client guarantees.** A non-Fluux (or older Fluux) client may not apply a whisper correction/reaction/retraction and may render it as a new private message. This is accepted graceful degradation, not a target.
- **Local-only retraction when the counterpart has left.** For the MVP, whisper operations are gated on counterpart-present (consistent with the existing reply gate). Local-only retraction-when-gone is a possible follow-up.
- Read receipts / chat markers in MUC (not sent today; out of scope).

## Architecture

The SDK owns all protocol routing; the app owns UI gating. The design keeps that boundary.

### 1. Send-side routing — auto-detect (the core)

A new private helper on `Chat`:

```ts
interface WhisperRouting {
  recipient: string    // room@conf/<current nick>
  referenceId: string  // originId ?? messageId (never stanza-id)
  targetNick: string   // for optimistic events / diagnostics
}

private resolveWhisperRouting(roomJid: string, messageId: string): WhisperRouting | null
```

Behaviour:
1. `const msg = this.deps.stores?.room.getMessage(roomJid, messageId)`.
2. If `!msg?.isPrivate || !msg.whisperWith` → return `null` (normal public/1:1 path; today's behaviour is untouched).
3. Resolve the **current nick** of the counterpart: find the occupant in `room.occupants` whose `occupantId === msg.whisperWithOccupantId`; fall back to `msg.whisperWith` when the room has no occupant-id support. (Same re-binding logic as `whisperTarget.ts`.)
4. If the counterpart is **not present**, throw `WhisperCounterpartGoneError` (new SDK error, mirroring `E2EEEncryptionRequiredError`). The helper must **never** fall back to the room-broadcast path.
5. Return `{ recipient: ${roomJid}/${currentNick}, referenceId: msg.originId ?? messageId, targetNick: currentNick }`.

`sendCorrection` / `sendReaction` / `sendRetraction` each gain a small branch, taken only when `type === 'groupchat'`:

```ts
const whisper = type === 'groupchat' ? this.resolveWhisperRouting(to, messageId) : null
const isWhisper = whisper !== null
const recipient   = isWhisper ? whisper.recipient : (type === 'chat' ? getBareJid(to) : to)
const wireType    = isWhisper ? 'chat' : type            // muc#user private message
const referenceId = isWhisper ? whisper.referenceId : <existing reference logic>
// when isWhisper: append <x muc#user/> and <no-store/> to children
```

**E2EE gating stays on the *original* `type`, not `wireType`.** The 1:1 E2EE branch in each method must read `type === 'chat' && !isWhisper`, so a whisper (original `type='groupchat'`) never triggers 1:1 encryption against `room@conf` (a wrong, non-1:1 JID). This matches `sendWhisper`, which applies no E2EE.

`sendCorrection` already fetches the original message for the reference-id and optimistic update (`Chat.ts:1246`); the helper reuses that lookup. `sendReaction` and `sendRetraction` add the lookup up-front (replacing/augmenting `getMessageReferenceId` for the whisper case).

**Wire example** — correcting your whisper to bob:

```xml
<message to='room@conf/bob' type='chat' id='new-uuid'>
  <body>fixed text</body>
  <replace xmlns='urn:xmpp:message-correct:0' id='origin-id-of-original-whisper'/>
  <x xmlns='http://jabber.org/protocol/muc#user'/>
  <origin-id xmlns='urn:xmpp:sid:0' id='new-uuid'/>
  <no-store xmlns='urn:xmpp:hints'/>
</message>
```

The **optimistic events are unchanged** (`room:message-updated`, `room:reactions`): they are keyed by message id in the room store, so they update the whisper in place and keep `isPrivate: true`. Only the wire recipient/type/markers change.

### 2. Receive-side matching

Restructure the `isWhisper` branch in `handleMessageInternal` (`Chat.ts:251-264`): before falling through to `processRoomWhisper` (a genuine new-body whisper), inspect the stanza for sub-feature elements and route them to the existing handlers, scoped to the room store:

- `<replace>` present → incoming whisper **correction** → existing correction apply path (matches the stored whisper by `replace.id` against origin-id/id).
- bodiless `<reactions>` → incoming whisper **reaction** → `handleIncomingReaction`.
- `<retract>` → incoming whisper **retraction** → `handleIncomingRetraction`.
- otherwise → `processRoomWhisper` (unchanged).

**Why reuse the existing handlers** (vs. a separate whisper-operation handler): whispers already live in the room store keyed by id/origin-id; the sender-identity check works unchanged (`from = room@conf/bob` on both the correction and the original); and MUC correction matching is already origin-id-based (per `project_muc_reference_id_rules`). One code path, one set of edge cases. The only change is *where* the whisper branch hands off — it must check for these elements instead of unconditionally treating the stanza as a new whisper.

This same path covers **carbon sync** (§4): an unwrapped sent-carbon whisper-correction flows through `handleMessageInternal` and applies as a correction on the second device. (`Chat.whisper.test.ts:189` already exercises the carbon-wrapped new-whisper case.)

### 3. Reference-ids and `no-store`

Whispers are `<no-store>` — no MAM, no server stanza-id. Therefore every whisper operation references the original by **origin-id** (`originId ?? id`), never stanza-id:

- Corrections already use `originId ?? id` (`Chat.ts:1249`) — correct for whispers as-is.
- Reactions and retractions currently use `getMessageReferenceId` = `stanzaId ?? id` (`Chat.ts:1705`). For a whisper there is no `stanzaId`, so the helper overrides this with `originId ?? id` via `WhisperRouting.referenceId`.

Whisper operation stanzas also carry `<no-store>` so the server does not archive them.

### 4. Store updates and carbon sync

- Whispers are already locally durable (`noLocalStore` undefined). The optimistic events from §1 update the stored whisper in place (body + `isEdited` for corrections; reactions map for reactions; `isRetracted` + `retractedAt` for retractions), preserving `isPrivate`.
- Carbon sync relies on §2: the operation stanza is delivered to the user's other devices as a sent-carbon, unwrapped, and routed through the same receive-side matching so it applies as an operation (not a new whisper). No separate carbon code is needed beyond the existing whisper-carbon unwrap.

### 5. UI capabilities (RoomView / MessageBubble)

Whisper bubbles keep their action buttons, now safe, with parity to a 1:1 DM:

| | Own whisper | Incoming whisper |
|---|---|---|
| Edit (correct) | yes | — |
| Delete (retract) | yes | — |
| React | yes | yes |
| Reply | yes (already) | yes (already) |
| Moderate | — | — (gated off) |

Concretely:
- `canDelete` (`MessageBubble.tsx:398`) drops its `canModerate` branch for whispers: `canDelete = message.isOutgoing && !isIrcGateway` when `isPrivate` (you cannot moderate a private message; the server has no archived copy).
- Edit / react / delete gate on **counterpart-present** for whispers, mirroring the existing reply gate (`canReply = ... && !counterpartGone`, `MessageBubble.tsx:396`). The bubble already receives `counterpartPresent` (`RoomView.tsx:1426`), so the gate reuses it.
- The SDK throw from §1 is the backstop: the RoomView operation handlers (`handleCorrection`, `handleReaction`, `handleRetract`) catch `WhisperCounterpartGoneError` and surface the existing `rooms.whisperCounterpartGone` toast rather than crashing.

### 6. Typing indicator (private chat-state)

Typing is composer-driven (there is no stored target message, so §1's auto-detect does not apply). Add a dedicated SDK method:

```ts
async sendWhisperChatState(roomJid: string, nick: string, state: ChatStateNotification): Promise<void>
```

It sends the chat-state as `type='chat'` to `room@conf/nick` with the `muc#user` marker (and `no-store`). Exposed through the room hooks (`useRoomActive`, `useRoom`, `useRoomActions`).

In `RoomView`, while a `whisperTarget` is active:
- `handleTypingState` (`RoomView.tsx:1831`) routes `composing`/`paused` through `sendWhisperChatState(roomJid, whisperTarget.nick, state)` instead of `sendChatState(roomJid, ...)`.
- The post-send `active` for whispers is already carried by the whisper stanza's own `<active>` element; the public-path `active` (`RoomView.tsx:1818`) is not reached because the whisper send returns early.

### 7. Link preview (latent guard)

No behavioural change. The whisper send path returns at `RoomView.tsx:1766` before `processLinkPreview`, so no whisper-URL preview is generated. Add a guard/comment at the `processLinkPreview` call site (and/or in the SDK `sendLinkPreview`) so a future refactor cannot start broadcasting a whisper-URL preview to the room.

## Edge cases

- **Counterpart renamed:** nick re-resolved from `whisperWithOccupantId` against the live occupant list; operation reaches the same person.
- **Counterpart left / nick recycled by someone else:** `whisperTargetPresent` is false → UI gates the action; SDK throws `WhisperCounterpartGoneError` as a backstop. Never broadcast.
- **Room without occupant-id support:** fall back to `msg.whisperWith` nick (best effort, same as the reply path).
- **Poll vote via reactions:** `votePoll` routes through `sendReaction('groupchat')`, but a poll message is not `isPrivate`, so `resolveWhisperRouting` returns `null` → unchanged public path.
- **Incoming whisper correction with a body:** the receive-side must check `<replace>` *before* the new-body whisper branch, otherwise it is mis-handled as a new whisper.
- **Non-Fluux peer:** may render the operation as a new private message (accepted degradation).

## Testing

- **SDK** (`Chat.whisper.test.ts`):
  - `sendCorrection`/`sendReaction`/`sendRetraction` on a private (whisper) message → `type=chat` to `room@conf/nick`, includes `muc#user` + `no-store`, reference uses origin-id, and the stanza `to` is the occupant JID (not the bare room).
  - The same methods on a public room message → unchanged (`type=groupchat` to room JID).
  - Counterpart gone → throws `WhisperCounterpartGoneError`, sends nothing.
  - Nick changed → routed to the current nick resolved via occupant-id.
  - Incoming whisper correction/reaction/retraction → applies to the existing whisper thread; asserts `room:whisper` is **not** emitted for a second (new) message.
  - Whisper-correction sent-carbon → applies as a correction on the second device.
- **App** (`RoomView`/`MessageBubble` memo tests):
  - Whisper bubble exposes edit/react/delete per the capability table; moderation gated off; actions disabled when counterpart gone.
  - `handleTypingState` routes through `sendWhisperChatState` while a whisper target is active, and through `sendChatState` otherwise.

## Files touched (estimate)

- `packages/fluux-sdk/src/core/modules/Chat.ts` — `resolveWhisperRouting`, the three send-method branches, the receive-side `isWhisper` restructure, `sendWhisperChatState`.
- `packages/fluux-sdk/src/core/...` (errors) — `WhisperCounterpartGoneError`.
- `packages/fluux-sdk/src/hooks/{useRoomActive,useRoom,useRoomActions}.ts` — expose `sendWhisperChatState` (correction/reaction/retraction signatures unchanged thanks to auto-detect).
- `apps/fluux/src/components/RoomView.tsx` — typing routing, counterpart-gone catch + toast.
- `apps/fluux/src/components/conversation/MessageBubble.tsx` — capability gating for whispers (drop moderate, gate on counterpart-present).
- `packages/fluux-sdk/src/index.ts` — export the new error (and method via hooks).
- Tests as above.

## Risks

- **Receive-side restructure** touches the hot `handleMessageInternal` path; the `<replace>`/`<reactions>`/`<retract>` checks must be ordered before the new-body whisper fall-through and must not change public-message handling. Mitigated by the existing whisper test suite plus new incoming-operation tests.
- **Auto-detect depends on the target message being in the room store.** For an optimistically-rendered whisper it always is; a corner case is operating on a message that was evicted by memory windowing — the lookup would miss and the operation would take the public path. Mitigation: the windowing keeps the *active* room resident, and operations are only reachable from rendered (resident) bubbles, so the target is present. Worth an assertion/log if the lookup misses on a `groupchat` correction whose id matches no resident message.
