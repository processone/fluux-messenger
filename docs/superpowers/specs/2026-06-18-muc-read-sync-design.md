# MUC Read-Position Sync (XEP-0490 for rooms) — Design

**Date:** 2026-06-18
**Status:** Approved (brainstorming) → ready for implementation plan
**Builds on:** the 1:1 MDS implementation in `docs/superpowers/plans/2026-06-18-mds-read-sync.md` (merged on branch `mr/elated-panini-81a58f`, PR #598). This extends that work to MUC rooms and ships in the **same** PR.

## Goal

Extend XEP-0490 (Message Displayed Synchronization) read-position sync to **MUC rooms**, so a user's last-read position in a room follows them across devices — the same way the merged 1:1 work already does for direct chats.

For MDS, MUC is the bigger win: room read state is **ephemeral today** (`roomMeta`/`roomRuntime` are not persisted), so it resets on every cold start. MDS gives rooms server-backed, cross-device read positions for the first time.

## Scope decisions (settled during brainstorming)

1. **Fold into PR #598** — ship 1:1 + MUC as one cohesive "read-position sync" feature.
2. **Ephemeral fallback** — no new local persistence for room read state. When PEP is unavailable, rooms behave exactly as today (read state resets on cold start). MDS strictly improves the status quo and never regresses below it.
3. **Routing approach A** — route incoming markers to room-vs-chat in `storeBindings` by known-room membership (`roomStore.rooms.has(jid)`). No disco, no network.

## Architecture

The 1:1 MDS infrastructure is reused wholesale — the `Mds` module (publish/fetch keyed by bare JID), the PEP node `urn:xmpp:mds:displayed:0`, the `keyedCoalescer`, the debounced publisher side effect, and the `lastKnownNodeStanzaId` reconciliation. MUC support is additive:

### 1. Generalize the SDK event

Rename the branch-local event `chat:displayed-synced` → **`read:displayed-synced { conversationJid: string; stanzaId: string }`**. It now carries both 1:1 and room markers. `PubSub.handleMdsUpdate` stays store-agnostic: it parses items and emits this one event. The event was added on this branch and is unreleased, so the rename is free.

### 2. Route in `storeBindings`

The `read:displayed-synced` handler disambiguates by known-room membership and dispatches:

```
on('read:displayed-synced', ({ conversationJid, stanzaId }) => {
  const stores = getStores()
  if (stores.room.rooms.has(conversationJid)) {
    stores.room.applyRemoteDisplayed(conversationJid, stanzaId)
  } else {
    stores.chat.applyRemoteDisplayed(conversationJid, stanzaId)
  }
})
```

`roomStore.rooms` is a JID-keyed map of bookmarked + joined rooms — the authoritative "is this a room" signal, available without network.

### 3. `roomStore.applyRemoteDisplayed(roomJid, stanzaId)`

A forward-only mirror of `chatStore.applyRemoteDisplayed`:
- Resolve `stanzaId` → local message id by matching `RoomMessage.stanzaId` in the room's `roomRuntime` messages.
- Advance `lastSeenMessageId` forward-only via `notifState.onMessageSeen` (index comparison, never timestamp).
- If the stanza-id isn't in the loaded messages, store it as `pendingRemoteDisplayedStanzaId` on `RoomMetadata` and leave `lastSeenMessageId` unchanged.
- Mirror the write into both `roomMeta` and the combined `rooms` map (matching `roomStore.updateLastSeenMessageId`'s existing idiom), and clear the pending marker on a resolved advance (mirroring the 1:1 coherence fix).

**Binding surface:** `applyRemoteDisplayed` is called from `storeBindings` via `getStores().room`, which is the **full** room-store type (`ReturnType<typeof roomStore.getState>`) — so adding the method to `roomStore` is sufficient for the binding to typecheck. It does **not** need an entry in the narrow XMPPClient-called room-bindings interface in `core/types/client.ts` (that interface is for methods XMPPClient modules invoke directly, like the occupant-avatar batch). This matches exactly how the merged 1:1 `chatStore.applyRemoteDisplayed` was wired. The one mock that does need it: `test-utils.ts`'s room-store mock (so binding/store tests don't hit "undefined is not a spy"), mirroring the 1:1 task's `test-utils` update.

### 4. Resolve pending markers on room MAM merge

Mirror the 1:1 "B5" step: after `roomStore`'s MAM-merge action commits room messages, if the room has a `pendingRemoteDisplayedStanzaId` now present, call `applyRemoteDisplayed` to resolve it forward-only and clear it.

### 5. Publisher watches both stores

`mdsSideEffects` already keys its coalescer and `lastKnownNodeStanzaId` by JID, so it extends naturally:
- Also subscribe to `roomStore.roomMeta` for read-position advances.
- On a room advance, resolve the **room-archive** stanza-id from `RoomMessage.stanzaId` and publish via the existing `client.mds.publishDisplayed(roomJid, stanzaId)` path.
- No disambiguation on publish — the source store (roomMeta vs conversationMeta) tells us it's a room.
- The existing guards apply unchanged: forward-only by index, no regressive publish, exact-equal echo skip, drop-on-disconnect, syncEnabled gating.

### 6. Seed ordering

`fetchAllDisplayed()` returns mixed chat + room markers. Each is routed via `roomStore.rooms.has(jid)`, so the MDS seed must run **after** the XEP-0402 bookmark fetch has populated `roomStore.rooms` in the fresh-session flow.

## Data flow

**Publish (room read advances):** user scrolls in a room → `roomStore.updateLastSeenMessageId` advances `lastSeenMessageId` → `mdsSideEffects` roomMeta subscription fires → resolve room-archive stanza-id → coalesce per-JID → debounced publish to `urn:xmpp:mds:displayed:0` (item id = room JID).

**Apply (incoming):** another device's publish → server pushes a PEP notify (we advertise `+notify`) → `PubSub.handleMdsUpdate` emits `read:displayed-synced` → `storeBindings` routes by room membership → `roomStore.applyRemoteDisplayed` advances forward-only (or stores pending).

**Seed (fresh session):** after bookmarks load, `mds.fetchAllDisplayed()` → route each marker by room membership → `roomStore`/`chatStore.applyRemoteDisplayed` + seed `lastKnownNodeStanzaId`.

## Edge cases & error handling

- **Mis-route from unsynced bookmark:** a room bookmarked only on another device (not yet synced here) routes its marker to chat as a stray read marker on a non-existent 1:1 entity. Harmless; self-corrects on the next seed once the bookmark syncs. Documented, not guarded.
- **Stanza-id correctness:** the `<displayed id>` for a room MUST be the room-stamped stanza-id (`by` = room JID), not the user's account-archive id. Verify in the plan that `RoomMessage.stanzaId` already holds the room-stamped value (MUC stamps stanza-id by the room JID; `parseMessageContent` takes `expectedStanzaIdBy`). If MUC parsing doesn't already select the room-stamped id, fix it as part of this work.
- **PEP unavailable / publish rejected:** best-effort, same as 1:1. Rooms fall back to today's ephemeral behavior. No new persistence.
- **No regressive publish / echo:** reuse the merged guards unchanged (index comparison, `lastKnownNodeStanzaId` exact-equal skip seeded from notifications and successful publishes).

## Testing

- `roomStore.applyRemoteDisplayed`: forward-only advance, no regression, pending high-water mark when unloaded, combined-map mirror + pending clear on advance.
- Room MAM merge resolves a pending room marker.
- `storeBindings` routing: a room-JID marker hits `roomStore.applyRemoteDisplayed`; a contact-JID marker hits `chatStore.applyRemoteDisplayed`.
- Publisher: a room read advance publishes the room-archive stanza-id (debounced, once).
- Seed: a mixed chat+room batch routes correctly after bookmarks are present.
- Regression: existing 1:1 MDS tests still pass after the event rename.

## Out of scope (unchanged from the 1:1 plan)

- Local persistence for room read state (the ephemeral-fallback decision).
- Emitting peer-visible XEP-0333 `<displayed/>` receipts.
- PEP node self-heal on `precondition-not-met`.
- Migrating the #518 occupant-avatar batcher onto `keyedCoalescer`.
