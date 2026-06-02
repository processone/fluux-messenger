# MUC Whispers (Private Messages in Rooms) — Design Spec

- **Date:** 2026-06-02
- **Status:** Approved (design), pending implementation plan
- **Scope:** SDK (`@fluux/sdk`) + app (`@xmpp/fluux`)
- **Feature flavor:** v1 "simple" — inline, ephemeral. Explicitly *not* a full private-conversation experience.

## 1. Goal

Let a user exchange XEP-0045 §7.5 private messages ("whispers") with another
occupant of a MUC room, without building a full separate private-conversation
subsystem. Whispers appear **inline** in the room timeline with a clear
"private" treatment and are **ephemeral** (in-memory only, never persisted).

## 2. Context & non-goals

### What "simple" means here

The reference client *Conversations* implements whispers as a **separate
conversation keyed by the full occupant JID** (`room@conf/nick`): it shows up in
the conversation list, with its own history and persistence. That duplicates the
entire 1:1 machinery (conversation entity, sidebar navigation, persistence) for
an address that is inherently volatile. We deliberately avoid that.

### Non-goals (v1)

- No separate conversation entity, no sidebar entry, no dedicated navigation.
- No persistence, no MAM, no carbons reconciliation — whispers are ephemeral.
- No E2EE on whispers (MUC encryption is a separate roadmap item).
- No reactions / corrections / retractions / chat-states *within* whispers.
  v1 handles plain whisper body messages (text + optional OOB attachment URL).
- No cross-nick identity tracking via XEP-0421 occupant-id (captured but unused).

## 3. Protocol background (XEP-0045 §7.5)

A whisper is a directed message:

```xml
<message type='chat' to='room@conf/nick' id='...'>
  <body>...</body>
  <x xmlns='http://jabber.org/protocol/muc#user'/>   <!-- marks it as a MUC PM -->
</message>
```

The destination `room@conf/nick` is **only valid while that occupant is present
under that nick**. There is no reliable archive (MAM) and no guaranteed carbons.
This volatility is the core justification for the ephemeral design: persisting
whispers would create false promises (re-displaying a "reply"-able thread whose
address is dead).

## 4. Key finding: whispers are currently mishandled on receive

Today an incoming whisper is misrouted by `handleMessageInternal`
([`Chat.ts:171`](../../../packages/fluux-sdk/src/core/modules/Chat.ts#L171)):

- [`Chat.ts:221`](../../../packages/fluux-sdk/src/core/modules/Chat.ts#L221)
  reclassifies `type='chat'` + `<x muc#user>` into `groupchat` → a private
  message would be processed as a **public** room message.
- Without that marker, the message falls through to `processChatMessage` →
  creates a **phantom 1:1 conversation** with `conversationId = room@conf`
  (the bare room JID).

So the heart of this feature, regardless of UI, is a **dedicated whisper
detection branch on receive** that takes precedence over the `muc#user →
groupchat` reclassification.

The pivot already exists: the Chat module can look a room up via
`this.deps.stores?.room.getRoom(bareFrom)` — see
[`Chat.ts:1883`](../../../packages/fluux-sdk/src/core/modules/Chat.ts#L1883)
in `processRoomMessage`.

## 5. Locked design decisions

| Decision | Choice |
|----------|--------|
| Placement | **Inline** in the room timeline, badged "private". |
| Lifetime | **Ephemeral** — in `roomRuntime` messages array, excluded from persistence. |
| Send entry points | **Occupant menu** ("Private message") + **message action** ("Reply privately"). No slash command in v1. |
| Composer mode | **Sticky** whisper mode (persists until `Esc`). A silent one-shot revert-to-public is a worse footgun than a persistent, clearly-badged mode. |
| Incoming notification | Treated **like a mention** (notify + increment). |
| Send path | **Dedicated `sendWhisper` method**, not `sendMessage` (which strips the resource and emits `chat:message`). |

## 6. Data model

Extend `RoomMessage`
([`room.ts:117`](../../../packages/fluux-sdk/src/core/types/room.ts#L117)) with
two optional fields (named to match existing `isMention` / `isOutgoing`):

```ts
/** True when this message is a MUC private message (whisper). */
isPrivate?: boolean
/** Nick of the other party: the recipient if outgoing, the sender if incoming. */
whisperWith?: string
```

`whisperWith` always identifies the *remote* occupant, so the UI can badge
"Private → @whisperWith" uniformly and, if desired later, filter a thread by
occupant. The sender's own nick remains in the existing `nick` field; `occupantId`
is captured on incoming whispers when present (for future anonymous-room use).

### Storage

Whispers are appended to the **same `messages` array** in the room runtime as
public messages — so inline rendering is free and ordering is by timestamp. They
are **filtered out of the IndexedDB persistence layer** (`!m.isPrivate`) so they
never survive a reload. `room.reset()` already clears runtime, which clears them.

## 7. SDK — sending (`sendWhisper`)

New method on the Chat module. We do **not** reuse `sendMessage`, because
[`Chat.ts:710`](../../../packages/fluux-sdk/src/core/modules/Chat.ts#L710)
forces `getBareJid(to)` for `type='chat'` (stripping the `/nick` resource) and
[`Chat.ts:865`](../../../packages/fluux-sdk/src/core/modules/Chat.ts#L865)
emits a `chat:message` event that would spawn a phantom 1:1 conversation.

```ts
/**
 * XEP-0045 §7.5: send a private message ("whisper") to a single room occupant.
 * @param roomJid bare room JID (e.g. 'room@conference.example.com')
 * @param nick    target occupant's nickname
 * @param body    message text
 * @returns the generated stanza/message id
 */
async sendWhisper(roomJid: string, nick: string, body: string): Promise<string>
```

Builds:

```xml
<message to='roomJid/nick' type='chat' id='<uuid>'>
  <body>...</body>
  <active xmlns='http://jabber.org/protocol/chatstates'/>
  <x xmlns='http://jabber.org/protocol/muc#user'/>
  <origin-id xmlns='urn:xmpp:sid:0' id='<uuid>'/>
</message>
```

Sends via `this.deps.sendStanza`, then emits a **dedicated SDK event**
`room:whisper` `{ roomJid, message }` (not `chat:message`) where `message` is a
`RoomMessage` with `isPrivate: true`, `isOutgoing: true`, `whisperWith: nick`,
`nick: <our nick>`.

The thin hook layer (`useRoomActive`) exposes `sendWhisper(roomJid, nick, body)`.

## 8. SDK — receiving

Add a whisper-detection branch to `handleMessageInternal` that **takes
precedence over** the `muc#user → groupchat` reclassification at
[`Chat.ts:221`](../../../packages/fluux-sdk/src/core/modules/Chat.ts#L221).

Detection predicate (most specific wins):

```ts
type === 'chat'
  && getResource(from)                              // has a /nick
  && this.deps.stores?.room.getRoom(bareFrom)?.joined === true
```

This is precise enough to avoid false positives:

- Mediated invitations come from the **bare** room JID (no resource) → not matched
  → existing `handleMucInvitation` path is untouched.
- Regular 1:1 chats are not from a joined room → fall through to
  `processChatMessage` (no regression).

Because the reclassification at line 221 currently runs **before** `bareFrom` is
computed (line 226), the implementation computes the room lookup early (or hoists
`bareFrom`) and sets an `isWhisper` flag that both suppresses the reclassification
and short-circuits to a new `processRoomWhisper`. For a whisper carrying a body
(or OOB attachment), the handler returns immediately, **bypassing the public
sub-feature handlers** (reactions, corrections, retractions, moderation) which
are out of scope for whispers in v1. Once detected as a whisper the stanza is
claimed (`handled: true`) regardless; a bodyless whisper stanza (e.g. a stray
chat-state) is dropped in v1 rather than leaking into the 1:1 chat-state handler.

`processRoomWhisper(stanza, from, bareFrom, body, isCarbonCopy, isSentCarbon)`
reuses the `processRoomMessage` core (nick = `getResource(from)`, body parsing,
`occupantId` capture) but sets `isPrivate: true`, `whisperWith: nick`, and
`isOutgoing = isSentCarbon`, then emits `room:whisper`.

## 9. Store binding

`storeBindings.ts` subscribes to `room:whisper` and calls a room-store action
that appends the message to the active room's runtime `messages` array (same
insertion/dedup-by-id path as public messages). Incoming (`!isOutgoing`) whispers
route through the mention branch of `notificationState` so they notify and
increment the room's mention/unread counters.

## 10. UI

- **`MessageBubble`**
  ([`MessageBubble.tsx`](../../../apps/fluux/src/components/conversation/MessageBubble.tsx)):
  when `message.isPrivate`, render a badge ("🔒 Private → @whisperWith" outgoing /
  "🔒 Private from @nick" incoming) plus a subtle tinted background. Reuses the
  existing sender-label / avatar rendering.
- **Occupant menu** (`onNickContextMenu`, already wired in `MessageBubble`):
  add a **"Private message"** action → enters composer whisper mode for that nick.
- **Message action menu**: add **"Reply privately"** → enters whisper mode
  targeting `message.nick`.
- **`RoomMessageInput`** (in
  [`RoomView.tsx`](../../../apps/fluux/src/components/RoomView.tsx)): add a
  `whisperTarget: string | null` state. When set:
  - Show a prominent banner above the input: "🔒 Private message to @nick · Esc
    to return to public".
  - Tinted composer border / changed placeholder for unmistakable mode indication.
  - `onSend` calls `client.room.sendWhisper(roomJid, whisperTarget, body)` instead
    of `sendMessage`.
  - `Esc` (and a banner close button) clears `whisperTarget`.
  - Mention autocomplete against occupants keeps working.

## 11. Notifications

Incoming whispers reuse the mention path in `notificationState`: they notify and
increment the room's mention counter (so the sidebar/badge reflects them). A
dedicated whisper indicator can be added later; v1 reuses mentions.

## 12. Error handling (delivery failure)

If the target occupant has left, the server returns a `type='error'` message,
already handled at
[`Chat.ts:211`](../../../packages/fluux-sdk/src/core/modules/Chat.ts#L211). v1
surfaces the failure inline against the originating whisper (match by stanza id):
the outgoing whisper bubble shows a "delivery failed — occupant may have left"
state. No retry/queue.

## 13. Known limitations (accepted for v1)

- **Joined rooms only.** A whisper from a room we are not currently joined to is
  not recognized as a whisper (falls through to the legacy phantom-1:1 path). In
  practice you receive whispers only from rooms you're in.
- **Nick-keyed identity.** If an occupant changes nick mid-thread, the inline
  association by nick can split. `occupantId` is captured for a future fix.
- **Ephemeral.** Whispers vanish on reload / re-join by design.
- **Plain messages only.** No reactions/corrections/retractions/chat-states or
  E2EE within whispers in v1.

## 14. Testing strategy

### SDK — `Chat.test.ts`

- `sendWhisper` produces the correct stanza: `to='room@conf/nick'`, `type='chat'`,
  `<x muc#user>` marker present, `<origin-id>` present, body correct.
- `sendWhisper` emits `room:whisper` (not `chat:message`) with
  `isPrivate: true`, `isOutgoing: true`, `whisperWith: nick`.
- Receiving `type='chat'` from a **joined** room occupant emits `room:whisper`
  with `isPrivate: true`, `nick`/`whisperWith` = sender nick.
- **Ordering regression:** a whisper carrying the `muc#user` marker is **not**
  reclassified into a public `groupchat` message.
- Sent-carbon of a whisper → `isOutgoing: true`.
- **Non-regression:** `type='chat'` from a non-joined JID still routes to
  `processChatMessage`; a mediated invite (no resource) still hits the invite
  handler.

### Store

- `room:whisper` binding appends the message inline to the room runtime.
- Persistence layer excludes `isPrivate` messages; a reload drops them.
- Incoming whisper increments the mention/notification counters.

### App

- Occupant "Private message" action puts the composer into whisper mode.
- Composer in whisper mode calls `sendWhisper`; `Esc` exits the mode.
- `MessageBubble` renders the private badge for `isPrivate` messages.

## 15. File-by-file change summary

| File | Change |
|------|--------|
| `packages/fluux-sdk/src/core/types/room.ts` | Add `isPrivate?`, `whisperWith?` to `RoomMessage`. |
| `packages/fluux-sdk/src/core/modules/Chat.ts` | Add `sendWhisper`; add whisper detection (pre-empting line 221) + `processRoomWhisper`. |
| `packages/fluux-sdk/src/core/types/sdk-events.ts` | Add `room:whisper` event type. |
| `packages/fluux-sdk/src/stores/roomStore.ts` | Action to append whisper to runtime; persistence filter excludes `isPrivate`. |
| `packages/fluux-sdk/src/provider/storeBindings.ts` | Bind `room:whisper` → store action + notification (mention path). |
| `packages/fluux-sdk/src/hooks/useRoomActive.ts` | Expose `sendWhisper`. |
| `apps/fluux/src/components/conversation/MessageBubble.tsx` | Private badge + tint; "Private message" / "Reply privately" actions. |
| `apps/fluux/src/components/RoomView.tsx` (`RoomMessageInput`) | `whisperTarget` state, banner, `Esc` to exit, `sendWhisper` wiring. |
| i18n locale files | New keys (private badge, banner, menu actions) translated into all locales. |

## 16. Open follow-ups (post-v1, out of scope)

- XEP-0421 occupant-id-keyed whisper identity (survives nick changes).
- Optional per-occupant filtered "mini-thread" view.
- Chat-states / reactions / corrections within whispers.
- E2EE for whispers once MUC encryption lands.
