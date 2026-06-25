# New-message marker as session state (post XEP-0490 read-position cleanup)

Date: 2026-06-25
Status: Approved design, pending spec review
Related: `docs/XEP-CONVERSATION_SYNC.md` (XEP-0490 implementation), `packages/fluux-sdk/src/core/mdsSideEffects.ts`

## 1. Background and problem

XEP-0490 (Message Displayed Synchronization) now owns the per-conversation read
position. The SDK seeds it from the MDS PEP node on a fresh session and publishes
forward advances back to the node. Read state is therefore authoritative on the
server and synced across a user's devices.

The app keeps two per-entity markers:

- `lastSeenMessageId`: the read position. "How far have I read." Now also MDS-synced.
- `firstNewMessageId`: the "new messages" divider. "Where to draw the divider, and
  where to scroll when the conversation opens." Derived from `lastSeenMessageId` by
  `notificationState.onActivate` at activation time.

Persistence is asymmetric today, which the original framing got wrong:

- `chatStore` wraps the `persist` middleware (`chatStore.ts:486`), and its custom
  `serializeState` writes the whole `conversationMeta` entry, so `firstNewMessageId`
  **is persisted** for 1:1 conversations.
- `roomStore` uses only `subscribeWithSelector` (`roomStore.ts:496`), with no `persist`
  middleware. `roomMeta` is never serialized, so the room divider is **already
  in-memory only** and recomputes on activation.

So the de-persist cleanup is a chat-only concern, while the restore bug (section 1.2)
and the architectural separation apply to both. We adopt a symmetric model anyway: both
metadata types become purely durable, and both stores park the divider in a dedicated
session map, so the divider can never be persisted in either store and the two stores
stay consistent.

Persisting `firstNewMessageId` (chat) causes two problems.

### 1.1 Vestigial persistence

`firstNewMessageId` is recomputed on every activation (`onActivate`) and is read
**only for the active entity** (`useChatActive.ts:61`, `ChatView.tsx:475`,
`RoomView.tsx:541`, `MessageList.tsx`, `useMessageListScroll.ts`). Nothing reads the
persisted value before activation overwrites it (`activeConversationId` is always
persisted as `null`, `chatStore.ts:1740`). The persisted copy never does any work.

### 1.2 The "restore to the wrong place" bug

Root cause, as a causal chain:

1. On a fresh session the MDS seed runs on the `online` event, before any messages
   are loaded, so `applyRemoteDisplayed` cannot map the incoming stanza-id to a local
   message and stashes it as `pendingRemoteDisplayedStanzaId` (`chatStore.ts:933`).
2. When the user opens a conversation, `activateConversation` (`chatStore.ts:604`)
   calls `loadMessagesFromCache` then `setActiveConversation`. `loadMessagesFromCache`
   does **not** resolve a pending marker (only `mergeMAMMessages` does, at
   `chatStore.ts:1487`).
3. `onActivate` therefore derives the divider from a **stale** `lastSeenMessageId`.
4. When the pending marker later resolves, `applyRemoteDisplayed` advances
   `lastSeenMessageId` via `onMessageSeen`, which by design touches **only**
   `lastSeenMessageId`, never `firstNewMessageId` (`notificationState.ts:396`).
5. The divider stays frozen at the stale position. The conversation-switch scroll
   effect only re-runs when `firstNewMessageId` itself changes (`useMessageListScroll.ts:943`),
   so the scroll position is never corrected until the next activation.

Net effect: opening a conversation you have already read on another device can show
already-read messages as "new" and scroll to the old boundary, and it does not
self-correct within the session.

Wire-timing evidence (capture `xmpp-log-2026-06-25-105927.txt`): the MDS fetch result
lands at 10:56:40.488, the very first result after auth, while the per-conversation
MAM messages begin arriving at 10:56:41.186 and continue for seconds. Every marker is
stashed pending at seed time; whether it resolves before the user opens a given
conversation is a race.

## 2. Goals and non-goals

Goals:

- Make the read position the single durable, MDS-synced source of truth.
- Make the new-message divider a session-only derived marker, fully decoupled from
  persisted metadata.
- Fix the restore bug: the divider must be derived from the synced read position at
  open time.

Non-goals:

- Dropping `lastSeenMessageId` persistence. It is load-bearing: offline-first display
  before the connection is up, and MDS's own durable buffer for the "ahead-of-node"
  re-publish on the next fresh session (`mdsSideEffects.ts` header).
- Re-deriving the divider while a conversation is active (see section 6, decided:
  leave frozen).
- Any change to the XEP-0490 wire protocol or publish logic.

## 3. State model

| Marker | Question | Persisted | MDS-synced | Home |
| --- | --- | --- | --- | --- |
| `lastSeenMessageId` | how far have I read | yes (keep) | yes | `conversationMeta` / `roomMeta` |
| new-message divider | where to draw the divider / scroll on open | no (change) | no | new session-only map |

## 4. Design

### 4.1 Session marker map (the "cleaner" separation)

Add a session-only map to `ChatState` and `RoomState`, keyed by entity bare JID:

```
firstNewMessageMarkers: Map<string, string>   // jid -> messageId (provisional name)
```

It is never serialized (absent from `serializeState` / `partialize`) and is reset to
an empty map by `reset()` / logout. The divider is no longer part of any persisted
metadata or of the combined conversation/room object.

### 4.2 Type changes

- Remove `firstNewMessageId` from `ConversationMetadata` (`chat.ts:112`) and
  `RoomMetadata` (`room.ts:251`).
- `Conversation` (`chat.ts:134`) and `Room` (`room.ts:304`) inherit from the metadata
  types, so the field leaves the combined objects as well. This is intentional: the
  divider is not part of a conversation's identity or durable metadata.

### 4.3 notificationState stays the derivation engine (unchanged)

The pure functions are not modified. `EntityNotificationState` keeps
`firstNewMessageId` as its computed currency: `onActivate` derives it, `onDeactivate`
and `markAsRead` clear it, the incoming-while-active-and-window-hidden path sets it
(`notificationState.ts:151`), and `onMessageSeen` preserves it. Only the **store**
changes where it stores the result.

### 4.4 Store routing

Everywhere the stores currently read or write `meta.firstNewMessageId`, route to the
session map instead:

- Build the `EntityNotificationState` input from `meta` (read position etc.) plus
  `firstNewMessageMarkers.get(jid)`.
- After calling the pure function, write `lastSeenMessageId` / `lastReadAt` /
  `unreadCount` to `meta`, and set or delete the divider in `firstNewMessageMarkers`.

Chat sites: `setActiveConversation` (activation result and the deactivate-previous
branch), `markAsRead` / `clearFirstNewMessageId`, and the incoming-message path.
Mirror in `roomStore`, including the `metaFields` routing list at `roomStore.ts:582`
and the combined-map plumbing, so no stale divider lingers on the in-memory combined
`rooms` map.

### 4.5 Activation resolves the synced position first (the bug fix)

In `activateConversation` (`chatStore.ts:604`) and `activateRoom` (`roomStore.ts:1445`),
between `loadMessagesFromCache` and `setActive*`, resolve any pending MDS marker:

```
await loadMessagesFromCache(id, { limit: 100 })
const pending = get().conversationMeta.get(id)?.pendingRemoteDisplayedStanzaId
if (pending) get().applyRemoteDisplayed(id, pending)  // forward-only, against now-loaded messages
get().setActiveConversation(id)                        // onActivate derives the divider from the synced position
```

`applyRemoteDisplayed` already resolves forward-only against loaded messages and clears
the pending mark. `onActivate` then draws the divider from the synced
`lastSeenMessageId`. No new resolution logic, only correct sequencing.

### 4.6 Selectors and hooks

- `chatSelectors.firstNewMessageIdFor` (`chatSelectors.ts:231`) and
  `roomSelectors.firstNewMessageIdFor` (`roomSelectors.ts:326`) read from
  `firstNewMessageMarkers`.
- `useChatActive` (`useChatActive.ts:60`) sources the active marker from
  `firstNewMessageMarkers` and exposes it as a standalone value (decoupled from the
  reconstructed conversation object). Room active hook does the same for `RoomView`.
- `ChatView.tsx:475` and `RoomView.tsx:541` read the marker from the hook as a
  standalone value (one line each).

## 5. Components and data flow

```
incoming msg / open / scroll-past
        |
        v
notificationState pure fns  --(firstNewMessageId in EntityNotificationState)-->
        |
        v
store: write read-state -> meta (persisted, MDS-synced)
       write divider     -> firstNewMessageMarkers (session only)
        |
        v
selectors / useChatActive / useRoomActive  -> ChatView / RoomView -> MessageList + useMessageListScroll
```

Read position flows out to the wire via the existing `mdsSideEffects` publisher,
unchanged. The divider never leaves the session map.

## 6. Edge behavior

- Marker's message not in the cached window at activation (older than the loaded 100,
  or not yet cached): `applyRemoteDisplayed` cannot resolve it, so the divider uses
  `onActivate`'s existing `lastReadAt` / `unreadCount` fallbacks and self-heals on the
  next activation. Narrow residual, strictly better than today.
- Sync resolves while the conversation is active (MAM merge mid-view, or a live remote
  read from another device): leave the divider frozen. It was placed at activation;
  moving it under an active reader is worse than a slightly late divider. The fix
  targets the open / restore moment, which is what "restore the right place" means.

## 7. Testing

- Failing test first (reproduces the bug): seed a pending remote marker for a
  conversation whose target message is in cache, call `activateConversation`, assert
  the divider sits at the synced position rather than the stale one. Mirror for rooms.
- De-persistence: `serializeState` output contains no `firstNewMessageId`; a
  persisted-then-reloaded store has no divider until activation; the persisted shape
  has no `firstNewMessageMarkers` key.
- Regression guards: forward-only / no-regress on `lastSeenMessageId` still hold; the
  divider clears on deactivate and on scroll-past; frozen-while-active holds.

## 8. Migration and compatibility

Old persisted `conversationMeta` / `roomMeta` may still contain `firstNewMessageId`.
Deserialize ignores it (the field leaves the type; the legacy read at
`chatStore.ts:342` is dropped). No data migration is needed; the divider recomputes on
the next activation.

## 9. Risks

- The touch surface spans both stores, their metadata types, two selector modules, two
  active-view hooks, and two app components. Mitigated by leaving `notificationState`
  untouched, by the marker already being isolated in single selectors, and by per-area
  behavior and render-count tests.
- The combined in-memory `conversations` / `rooms` maps and the `roomStore.ts:582`
  `metaFields` list must be updated consistently, or a stale divider could linger on
  the combined map. Covered by repointing all reads to `firstNewMessageMarkers` and
  removing the field from the metadata types (a compile error surfaces any missed site).
