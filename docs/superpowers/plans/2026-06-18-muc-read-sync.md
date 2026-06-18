# MUC Read-Position Sync (XEP-0490 for rooms) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the merged XEP-0490 (MDS) read-position sync to MUC rooms, so a user's last-read position in a room follows them across devices — shipped in the same PR (#598) as the 1:1 work.

**Architecture:** Reuse the entire 1:1 MDS infrastructure (the `Mds` module, the `urn:xmpp:mds:displayed:0` PEP node, the `keyedCoalescer`, the debounced publisher, the `lastKnownNodeStanzaId` reconciliation). Add: a generalized `read:displayed-synced` event, room-vs-chat routing in `storeBindings` by `roomStore.rooms.has(jid)`, a forward-only `roomStore.applyRemoteDisplayed` mirror, room-MAM pending resolution, and a dual-store publisher that also watches `roomStore.roomMeta` and publishes the room-archive stanza-id.

**Tech Stack:** TypeScript, `@xmpp/client`, Zustand vanilla stores, Vitest. XEPs: 0490 (MDS), 0333 (displayed element), 0359 (stable IDs), 0045/0313 (MUC + room MAM), 0163 (PEP).

**Spec:** `docs/superpowers/specs/2026-06-18-muc-read-sync-design.md`.

## Global Constraints

- **Routing approach A:** route incoming markers room-vs-chat in `storeBindings` by `roomStore.rooms.has(conversationId)` (JID-keyed known-room map). No disco, no network.
- **Event field name stays `conversationId`** (it already holds a bare JID); only the event *key* is renamed `chat:displayed-synced` → `read:displayed-synced`.
- **Forward-only by archive order** (message index via `notifState.onMessageSeen`), never by wall-clock — on both apply and publish. Reuse the merged guards (no regressive publish, exact-equal echo skip, drop-on-disconnect, syncEnabled gating) unchanged.
- **Ephemeral fallback for rooms:** no new local persistence. PEP unavailable ⇒ rooms behave exactly as today (read state resets on cold start). Never regress below the status quo.
- **Room-archive stanza-id:** a room's `<displayed id>` must be the stanza-id stamped by the room (`by` = room JID), which is `RoomMessage.stanzaId`. Verify (Task 5) it already holds the room-stamped value.
- **Room-store binding surface:** `roomStore.applyRemoteDisplayed` is called from `storeBindings` via `getStores().room` (the full store type), so adding it to `roomStore` + the `test-utils.ts` room mock is sufficient. It does NOT need an entry in the narrow XMPPClient-called room-bindings interface in `core/types/client.ts`.
- **SDK keeps deps minimal** — no new npm dependencies.
- **Worktree build order:** after SDK source changes run `npm run build:sdk` AND sync the built dist into the main repo (`rsync -a --delete packages/fluux-sdk/dist/ /Users/mremond/AIProjects/fluux-messenger/packages/fluux-sdk/dist/`) before app typecheck; run `npm run typecheck` from repo root (tsup dts can pass while tsc fails).
- **Run SDK tests per-workspace:** `cd packages/fluux-sdk && npx vitest run <file>`.
- **Commit cadence:** one commit per task (TDD). Never include a Claude footer.

---

## File Structure

- Modify `packages/fluux-sdk/src/core/types/sdk-events.ts` — rename event key.
- Modify `packages/fluux-sdk/src/core/modules/PubSub.ts` (+ `PubSub.test.ts`) — rename emit.
- Modify `packages/fluux-sdk/src/core/types/room.ts` — add `pendingRemoteDisplayedStanzaId` to `RoomMetadata`.
- Modify `packages/fluux-sdk/src/stores/roomStore.ts` — `applyRemoteDisplayed` action + pending resolution in `mergeRoomMAMMessages`.
- Create `packages/fluux-sdk/src/stores/roomStore.mds.test.ts` — focused tests.
- Modify `packages/fluux-sdk/src/bindings/storeBindings.ts` (+ `storeBindings.test.ts`) — rename + route by room membership.
- Modify `packages/fluux-sdk/src/core/test-utils.ts` — room mock gains `applyRemoteDisplayed`.
- Modify `packages/fluux-sdk/src/core/mdsSideEffects.ts` (+ `mdsSideEffects.test.ts`) — dual-store publish + seed.
- Modify `SUPPORTED_XEPS.md`, `fluux-messenger.doap`, `CHANGELOG.md` — XEP-0490 now covers rooms.

---

## Task 1: Rename event `chat:displayed-synced` → `read:displayed-synced`

Pure rename, no behavior change (still routes to chat only — Task 4 adds room routing).

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/sdk-events.ts`
- Modify: `packages/fluux-sdk/src/core/modules/PubSub.ts`, `PubSub.test.ts`
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts`, `storeBindings.test.ts`
- Modify: `packages/fluux-sdk/src/core/mdsSideEffects.ts`, `mdsSideEffects.test.ts`

**Interfaces:**
- Produces: SDK event `read:displayed-synced { conversationId: string; stanzaId: string }` on `ChatEvents` (payload shape unchanged; only the key changes).

- [ ] **Step 1: Find every reference**

Run: `cd packages/fluux-sdk && grep -rn "chat:displayed-synced" src/`
Expected: matches in `sdk-events.ts`, `PubSub.ts`, `PubSub.test.ts`, `storeBindings.ts`, `storeBindings.test.ts`, `mdsSideEffects.ts`, `mdsSideEffects.test.ts` (and a comment in `mdsSideEffects.ts`).

- [ ] **Step 2: Rename the event key everywhere**

Replace the string literal `chat:displayed-synced` with `read:displayed-synced` in all the files above (including the comment in `mdsSideEffects.ts` line ~96 referencing "the chat:displayed-synced subscription" → "the read:displayed-synced subscription"). In `sdk-events.ts`, update the JSDoc to say it covers 1:1 **and** rooms:

```typescript
  /** XEP-0490: a device synced its last-displayed (read) position for a conversation (1:1 or room) */
  'read:displayed-synced': {
    /** Conversation bare JID (1:1 contact or MUC room). */
    conversationId: string
    /** XEP-0359 stanza-id of the last displayed message on the publishing device. */
    stanzaId: string
  }
```

- [ ] **Step 3: Verify no stragglers**

Run: `cd packages/fluux-sdk && grep -rn "chat:displayed-synced" src/`
Expected: no matches.

- [ ] **Step 4: Run the affected tests**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/PubSub.test.ts src/bindings/storeBindings.test.ts src/core/mdsSideEffects.test.ts`
Expected: PASS (same counts as before the rename — behavior unchanged).

- [ ] **Step 5: SDK typecheck**

Run: `cd packages/fluux-sdk && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src
git commit -m "refactor(mds): rename chat:displayed-synced event to read:displayed-synced"
```

---

## Task 2: `RoomMetadata.pendingRemoteDisplayedStanzaId` + `roomStore.applyRemoteDisplayed`

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/room.ts`
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts`
- Test: `packages/fluux-sdk/src/stores/roomStore.mds.test.ts` (new)

**Interfaces:**
- Consumes: `notifState.onMessageSeen` (`./shared/notificationState`), `roomMeta`/`rooms`/`roomRuntime` maps, `RoomMessage` (`.id`, `.stanzaId`).
- Produces:
  - `RoomMetadata.pendingRemoteDisplayedStanzaId?: string`.
  - Store action `applyRemoteDisplayed(roomJid: string, stanzaId: string): void` — forward-only mirror of `chatStore.applyRemoteDisplayed`, adapted to the room meta/rooms/runtime split.

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/stores/roomStore.mds.test.ts`. First READ `packages/fluux-sdk/src/stores/roomStore.test.ts` to find the real helper that seeds `roomRuntime.messages` + `roomMeta` + `rooms` (mirror it; the chat equivalent injected via `setState`). Use distinct timestamps so the merged message order is stable. Tests required:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { roomStore } from './roomStore'
import type { RoomMessage } from '../core/types/room'

const ROOM = 'room@conference.example'
function rmsg(id: string, stanzaId: string, t: number): RoomMessage {
  return { id, stanzaId, from: `${ROOM}/alice`, body: id, timestamp: new Date(t), isOutgoing: false } as RoomMessage
}

// seedRoom: inject rooms + roomMeta + roomRuntime.messages via roomStore.setState.
// Mirror the real seeding helper found in roomStore.test.ts.
function seedRoom(jid: string, messages: RoomMessage[], lastSeenMessageId?: string) { /* per roomStore.test.ts idiom */ }

describe('roomStore.applyRemoteDisplayed', () => {
  beforeEach(() => roomStore.getState().reset())

  it('advances lastSeenMessageId forward to the local id of the matching stanza-id', () => {
    seedRoom(ROOM, [rmsg('m1','s1',1), rmsg('m2','s2',2), rmsg('m3','s3',3)], 'm1')
    roomStore.getState().applyRemoteDisplayed(ROOM, 's3')
    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m3')
  })

  it('never regresses lastSeenMessageId (incoming marker behind current)', () => {
    seedRoom(ROOM, [rmsg('m1','s1',1), rmsg('m2','s2',2), rmsg('m3','s3',3)], 'm3')
    roomStore.getState().applyRemoteDisplayed(ROOM, 's1')
    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m3')
  })

  it('stores a pending high-water mark when the stanza-id is not yet loaded', () => {
    seedRoom(ROOM, [rmsg('m1','s1',1)], 'm1')
    roomStore.getState().applyRemoteDisplayed(ROOM, 's-future')
    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe('s-future')
    expect(meta?.lastSeenMessageId).toBe('m1')
  })

  it('clears a stale pending marker when the message is loaded but position already past it', () => {
    seedRoom(ROOM, [rmsg('m1','s1',1), rmsg('m2','s2',2)], 'm2')
    // simulate a stale pending set on the room
    const meta = roomStore.getState().roomMeta.get(ROOM)!
    roomStore.setState((s) => { const m = new Map(s.roomMeta); m.set(ROOM, { ...meta, pendingRemoteDisplayedStanzaId: 's1' }); return { roomMeta: m } })
    roomStore.getState().applyRemoteDisplayed(ROOM, 's1')
    const after = roomStore.getState().roomMeta.get(ROOM)
    expect(after?.pendingRemoteDisplayedStanzaId).toBe(undefined)
    expect(after?.lastSeenMessageId).toBe('m2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.mds.test.ts`
Expected: FAIL — `applyRemoteDisplayed` is not a function.

- [ ] **Step 3: Add the type field**

In `packages/fluux-sdk/src/core/types/room.ts`, add to `RoomMetadata` (after `firstNewMessageId`):

```typescript
  /**
   * XEP-0490: a remote device reported reading up to this stanza-id, but the
   * message is not yet in the loaded room cache. Resolved to lastSeenMessageId
   * once the message arrives (see mergeRoomMAMMessages).
   */
  pendingRemoteDisplayedStanzaId?: string
```

- [ ] **Step 4: Implement the action**

Declare it in the room state interface near `updateLastSeenMessageId`:

```typescript
  /**
   * XEP-0490: apply a remote device's last-displayed marker. Advances
   * lastSeenMessageId forward-only by resolving the stanza-id to a local
   * message id; stores a pending high-water mark if not yet loaded.
   */
  applyRemoteDisplayed: (roomJid: string, stanzaId: string) => void
```

Implement it next to `updateLastSeenMessageId`, mirroring `chatStore.applyRemoteDisplayed` but using the room meta/rooms/runtime split (read messages from `roomRuntime?.messages ?? existing?.messages`, write both `roomMeta` and the combined `rooms` map):

```typescript
  applyRemoteDisplayed: (roomJid, stanzaId) => {
    set((state) => {
      const meta = state.roomMeta.get(roomJid)
      const existing = state.rooms.get(roomJid)
      if (!meta) return state

      const runtime = state.roomRuntime.get(roomJid)
      const messages = runtime?.messages ?? existing?.messages ?? []
      const match = messages.find((m) => m.stanzaId === stanzaId)

      if (!match) {
        const newMeta = new Map(state.roomMeta)
        newMeta.set(roomJid, { ...meta, pendingRemoteDisplayedStanzaId: stanzaId })
        if (existing) {
          const newRooms = new Map(state.rooms)
          newRooms.set(roomJid, { ...existing, pendingRemoteDisplayedStanzaId: stanzaId })
          return { roomMeta: newMeta, rooms: newRooms }
        }
        return { roomMeta: newMeta }
      }

      const updated = notifState.onMessageSeen(
        {
          unreadCount: meta.unreadCount,
          mentionsCount: meta.mentionsCount,
          lastReadAt: meta.lastReadAt,
          lastSeenMessageId: meta.lastSeenMessageId,
          firstNewMessageId: meta.firstNewMessageId,
        },
        match.id,
        messages
      )

      // No advance: the matching message is loaded and the local position is at
      // or past it → the marker is resolved; clear any stale pending mark.
      if (updated.lastSeenMessageId === meta.lastSeenMessageId) {
        if (meta.pendingRemoteDisplayedStanzaId === undefined) return state
        const newMeta = new Map(state.roomMeta)
        newMeta.set(roomJid, { ...meta, pendingRemoteDisplayedStanzaId: undefined })
        if (existing) {
          const newRooms = new Map(state.rooms)
          newRooms.set(roomJid, { ...existing, pendingRemoteDisplayedStanzaId: undefined })
          return { roomMeta: newMeta, rooms: newRooms }
        }
        return { roomMeta: newMeta }
      }

      const newMeta = new Map(state.roomMeta)
      newMeta.set(roomJid, {
        ...meta,
        lastSeenMessageId: updated.lastSeenMessageId,
        pendingRemoteDisplayedStanzaId: undefined,
      })
      if (existing) {
        const newRooms = new Map(state.rooms)
        newRooms.set(roomJid, {
          ...existing,
          lastSeenMessageId: updated.lastSeenMessageId,
          pendingRemoteDisplayedStanzaId: undefined,
        })
        return { roomMeta: newMeta, rooms: newRooms }
      }
      return { roomMeta: newMeta }
    })
  },
```

> If `notifState` is not already imported in `roomStore.ts`, it is (used by `updateLastSeenMessageId`). Confirm with `grep -n "notifState" src/stores/roomStore.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.mds.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Regression + typecheck**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts && npx tsc --noEmit`
Expected: existing room tests pass; no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/fluux-sdk/src/core/types/room.ts packages/fluux-sdk/src/stores/roomStore.ts packages/fluux-sdk/src/stores/roomStore.mds.test.ts
git commit -m "feat(mds): apply remote displayed markers forward-only in roomStore"
```

---

## Task 3: Resolve pending room marker on `mergeRoomMAMMessages`

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (`mergeRoomMAMMessages`)
- Test: `packages/fluux-sdk/src/stores/roomStore.mds.test.ts` (extend)

**Interfaces:**
- Consumes: `pendingRemoteDisplayedStanzaId` (Task 2), `applyRemoteDisplayed` (Task 2). `mergeRoomMAMMessages(roomJid, messages, rsm, complete, direction, preserveGapMarker?)`.
- Produces: after `mergeRoomMAMMessages` commits, a pending room marker now present in the merged messages is resolved and cleared.

- [ ] **Step 1: Write the failing test**

Add to `packages/fluux-sdk/src/stores/roomStore.mds.test.ts`:

```typescript
it('resolves a pending room marker once the message arrives via room MAM merge', () => {
  seedRoom(ROOM, [rmsg('m1','s1',1)], 'm1')
  roomStore.getState().applyRemoteDisplayed(ROOM, 's5') // not loaded → pending

  roomStore.getState().mergeRoomMAMMessages(
    ROOM,
    [rmsg('m2','s2',2), rmsg('m5','s5',5)],
    {} as never,            // RSMResponse: replace with the real shape from roomStore.test.ts
    true,
    'forward'
  )

  const meta = roomStore.getState().roomMeta.get(ROOM)
  expect(meta?.lastSeenMessageId).toBe('m5')
  expect(meta?.pendingRemoteDisplayedStanzaId).toBe(undefined)
})
```

> Replace `{} as never` with the valid `RSMResponse` shape used by existing `mergeRoomMAMMessages` tests in `roomStore.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.mds.test.ts`
Expected: FAIL — `lastSeenMessageId` still `m1` (pending not resolved).

- [ ] **Step 3: Implement**

In `mergeRoomMAMMessages`, AFTER the final `set(...)` that commits the merged messages, add:

```typescript
    // XEP-0490: a remote room marker may have arrived before its message.
    // Now that messages merged, try to resolve it forward-only.
    const pending = get().roomMeta.get(roomJid)?.pendingRemoteDisplayedStanzaId
    if (pending) {
      get().applyRemoteDisplayed(roomJid, pending)
    }
```

> `get` is the Zustand getter already in scope. Place this after the LAST `set` so the merged messages are visible. Read the existing `mergeRoomMAMMessages` (line ~1963) to confirm the final commit point and not disturb its existing behavior.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.mds.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Regression + typecheck**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts && npx tsc --noEmit`
Expected: existing room MAM tests pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/stores/roomStore.ts packages/fluux-sdk/src/stores/roomStore.mds.test.ts
git commit -m "feat(mds): resolve pending remote room markers on room MAM merge"
```

---

## Task 4: Route `read:displayed-synced` by room membership

**Files:**
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts`, `storeBindings.test.ts`
- Modify: `packages/fluux-sdk/src/core/test-utils.ts`

**Interfaces:**
- Consumes: `read:displayed-synced` (Task 1), `roomStore.applyRemoteDisplayed` (Task 2), `chatStore.applyRemoteDisplayed` (merged), `stores.room.rooms` (JID-keyed map).
- Produces: incoming `read:displayed-synced` routes to room vs chat store by `rooms.has(conversationId)`.

- [ ] **Step 1: Write the failing test**

Add to `packages/fluux-sdk/src/bindings/storeBindings.test.ts` (mirror the existing `read:displayed-synced`/chat test in that file; reuse its real fake-client emit + store-ref helpers). Two cases:

```typescript
it('routes read:displayed-synced for a known room to roomStore', () => {
  const roomApply = vi.fn()
  // store refs: roomStore mock with rooms = new Map([[ 'room@conf.example', {} ]]) and applyRemoteDisplayed: roomApply
  // chatStore mock with applyRemoteDisplayed: vi.fn()
  // ...build via the file's existing helpers...
  client._emitSDK('read:displayed-synced', { conversationId: 'room@conf.example', stanzaId: 's7' })
  expect(roomApply).toHaveBeenCalledWith('room@conf.example', 's7')
})

it('routes read:displayed-synced for a non-room JID to chatStore', () => {
  const chatApply = vi.fn()
  // roomStore mock with empty rooms map; chatStore mock applyRemoteDisplayed: chatApply
  client._emitSDK('read:displayed-synced', { conversationId: 'juliet@capulet.example', stanzaId: 's8' })
  expect(chatApply).toHaveBeenCalledWith('juliet@capulet.example', 's8')
})
```

> Use the file's actual fake-client/store-ref helpers (read the existing test for the names). The room mock must expose a real `rooms: Map` so `rooms.has(jid)` works, and `applyRemoteDisplayed`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/bindings/storeBindings.test.ts`
Expected: FAIL — room route not implemented (currently always routes to chat).

- [ ] **Step 3: Implement the routing**

In `packages/fluux-sdk/src/bindings/storeBindings.ts`, replace the renamed `read:displayed-synced` handler (currently chat-only) with:

```typescript
  on('read:displayed-synced', ({ conversationId, stanzaId }) => {
    const stores = getStores()
    if (stores.room.rooms.has(conversationId)) {
      stores.room.applyRemoteDisplayed(conversationId, stanzaId)
    } else {
      stores.chat.applyRemoteDisplayed(conversationId, stanzaId)
    }
  })
```

In `packages/fluux-sdk/src/core/test-utils.ts`, add `applyRemoteDisplayed: vi.fn()` to the room-store mock (alongside the other room actions), mirroring the chat mock's entry. Confirm the room mock exposes a `rooms: new Map()` field (it should, for `rooms.has` to work in tests/runtime mocks).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/bindings/storeBindings.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd packages/fluux-sdk && npx tsc --noEmit`
Expected: no errors (`getStores().room` is the full room store type, so `applyRemoteDisplayed` + `rooms` resolve).

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/bindings/storeBindings.ts packages/fluux-sdk/src/bindings/storeBindings.test.ts packages/fluux-sdk/src/core/test-utils.ts
git commit -m "feat(mds): route read:displayed-synced to room vs chat by membership"
```

---

## Task 5: Dual-store publisher + seed in `mdsSideEffects`

**Files:**
- Modify: `packages/fluux-sdk/src/core/mdsSideEffects.ts`, `mdsSideEffects.test.ts`

**Interfaces:**
- Consumes: `roomStore` (`rooms`, `roomMeta`, `roomRuntime`), `chatStore`, `client.mds.publishDisplayed`/`fetchAllDisplayed`, `createKeyedCoalescer`, `getBareJid`.
- Produces: `setupMdsSideEffects` also publishes and seeds room read positions, keyed by JID.

**Behavior:** make the per-store accessors room-aware; add a `roomStore.roomMeta` subscription; route the seed by membership. The coalescer, `lastKnownNodeStanzaId`, `lastConsideredSeenId`, the debounce, the `read:displayed-synced` node-HWM recorder, drop-on-disconnect, and `syncEnabled` gating are all JID-keyed and reused unchanged.

- [ ] **Step 1: Verify the room-archive stanza-id premise**

Run: `cd packages/fluux-sdk && grep -n "expectedStanzaIdBy\|parseStanzaId\|stanza-id" src/core/modules/MUC.ts`
Confirm MUC message parsing selects the room-stamped stanza-id (`parseMessageContent` with `expectedStanzaIdBy` = room JID), so `RoomMessage.stanzaId` is the room-archive id. If it does NOT, fix MUC parsing to pass the room JID as `expectedStanzaIdBy` (so the published `<displayed id>` is the room-archive id per XEP-0490). Note the finding in your report.

- [ ] **Step 2: Write the failing test**

Add to `packages/fluux-sdk/src/core/mdsSideEffects.test.ts` (reuse the file's fake `makeClient` + fake-timer setup; seed rooms via the real roomStore seeding helper, mirroring `roomStore.mds.test.ts`). Make the fake client's `rooms` include the room so routing/`isRoom` works:

```typescript
it('publishes the room-archive stanza-id on a local room read advance, debounced', async () => {
  const ROOM = 'room@conference.example'
  const client = makeClient()
  connectionStore.setState({ status: 'online' } as never)
  // ensure roomStore.rooms has ROOM and roomRuntime has its messages
  const cleanup = setupMdsSideEffects(client as never)
  client._emit('online')
  await vi.runOnlyPendingTimersAsync()

  // seed room messages + advance lastSeenMessageId in roomStore
  // seedRoom(ROOM, [rmsg('m1','s1',1), rmsg('m2','s2',2)], undefined)
  roomStore.getState().updateLastSeenMessageId(ROOM, 'm2')
  await vi.advanceTimersByTimeAsync(2_000)

  expect(client.mds.publishDisplayed).toHaveBeenCalledTimes(1)
  expect(client.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 's2')
  cleanup()
})

it('seeds a room marker from the node to roomStore', async () => {
  const ROOM = 'room@conference.example'
  const client = makeClient()
  client.mds.fetchAllDisplayed = vi.fn().mockResolvedValue([{ conversationJid: ROOM, stanzaId: 's2' }])
  connectionStore.setState({ status: 'online' } as never)
  // roomStore.rooms must contain ROOM and its messages so applyRemoteDisplayed resolves
  const cleanup = setupMdsSideEffects(client as never)
  client._emit('online')
  await vi.runOnlyPendingTimersAsync()
  expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m2')
  cleanup()
})
```

> Adapt the exact seeding/`rooms` population to the real roomStore test helpers. The `makeClient` fake must support the `read:displayed-synced` subscription and a `mds.fetchAllDisplayed` returning room markers.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/mdsSideEffects.test.ts`
Expected: FAIL — rooms are not published/seeded yet.

- [ ] **Step 4: Implement the dual-store extension**

In `packages/fluux-sdk/src/core/mdsSideEffects.ts`:

Add the room store import:

```typescript
import { chatStore, connectionStore, roomStore } from '../stores'
```

Add an `isRoom` helper and make the accessors room-aware:

```typescript
  /** Is this JID a known room (bookmarked or joined)? */
  function isRoom(jid: string): boolean {
    return roomStore.getState().rooms.has(jid)
  }

  /** Index of a stanza-id in a conversation's/room's loaded messages, or -1. */
  function indexOfStanza(jid: string, stanzaId: string | undefined): number {
    if (!stanzaId) return -1
    const messages = isRoom(jid)
      ? roomStore.getState().roomRuntime.get(jid)?.messages ?? []
      : chatStore.getState().messages.get(jid) || []
    return messages.findIndex((m) => m.stanzaId === stanzaId)
  }

  /** Resolve the stanza-id of a conversation's/room's current lastSeenMessageId. */
  function resolveSeenStanzaId(jid: string): string | undefined {
    if (isRoom(jid)) {
      const seenId = roomStore.getState().roomMeta.get(jid)?.lastSeenMessageId
      if (!seenId) return undefined
      const messages = roomStore.getState().roomRuntime.get(jid)?.messages ?? []
      return messages.find((m) => m.id === seenId)?.stanzaId
    }
    const seenId = chatStore.getState().conversationMeta.get(jid)?.lastSeenMessageId
    if (!seenId) return undefined
    const messages = chatStore.getState().messages.get(jid) || []
    return messages.find((m) => m.id === seenId)?.stanzaId
  }
```

Update `consider(jid)` to read the current lastSeenMessageId from the right store:

```typescript
  function consider(jid: string): void {
    if (!syncEnabled) return

    const seenId = isRoom(jid)
      ? roomStore.getState().roomMeta.get(jid)?.lastSeenMessageId
      : chatStore.getState().conversationMeta.get(jid)?.lastSeenMessageId
    if (seenId === lastConsideredSeenId.get(jid)) return
    lastConsideredSeenId.set(jid, seenId)

    const stanzaId = resolveSeenStanzaId(jid)
    if (!stanzaId) return

    const nodeId = lastKnownNodeStanzaId.get(jid)
    if (nodeId) {
      const candidateIdx = indexOfStanza(jid, stanzaId)
      const nodeIdx = indexOfStanza(jid, nodeId)
      if (candidateIdx !== -1 && nodeIdx !== -1 && candidateIdx <= nodeIdx) return
    }

    dirty.add(jid, stanzaId)
    schedulePublish()
  }
```

Add a `roomStore.roomMeta` subscription mirroring the `conversationMeta` one:

```typescript
  const unsubscribeRoomStore = roomStore.subscribe(
    (state) => state.roomMeta,
    () => {
      if (!syncEnabled) return
      for (const jid of roomStore.getState().roomMeta.keys()) {
        consider(jid)
      }
    }
  )
```

Route the seed by membership and snapshot BOTH stores' positions. Replace the seed loop + snapshot block in the `online` handler:

```typescript
      for (const { conversationJid, stanzaId } of markers) {
        const bare = getBareJid(conversationJid)
        lastKnownNodeStanzaId.set(bare, stanzaId)
        if (isRoom(bare)) {
          roomStore.getState().applyRemoteDisplayed(bare, stanzaId)
        } else {
          chatStore.getState().applyRemoteDisplayed(bare, stanzaId)
        }
      }

      dirty.drop()
      dirty.open()

      lastConsideredSeenId.clear()
      for (const [jid, meta] of chatStore.getState().conversationMeta) {
        lastConsideredSeenId.set(jid, meta.lastSeenMessageId)
      }
      for (const [jid, meta] of roomStore.getState().roomMeta) {
        lastConsideredSeenId.set(jid, meta.lastSeenMessageId)
      }
```

Add `unsubscribeRoomStore()` to the cleanup return.

> Seed ordering note: the seed routes by `roomStore.rooms.has(jid)` at `online` time. If a bookmarked room isn't yet in `roomStore.rooms`, its marker routes to chat (the documented, self-healing edge per the spec). During implementation, check whether the fresh-session bookmark fetch populates `roomStore.rooms` before `online` fires; if it reliably does, no action — if not, leave the self-heal behavior and note it in your report (do NOT add new ordering machinery; ephemeral fallback makes this acceptable).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/mdsSideEffects.test.ts`
Expected: PASS (existing 1:1 tests + new room tests).

- [ ] **Step 6: Regression + typecheck**

Run: `cd packages/fluux-sdk && npx vitest run src/core/mdsSideEffects.test.ts src/stores/roomStore.test.ts && npx tsc --noEmit`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add packages/fluux-sdk/src/core/mdsSideEffects.ts packages/fluux-sdk/src/core/mdsSideEffects.test.ts
git commit -m "feat(mds): publish and seed room read positions in mdsSideEffects"
```

---

## Task 6: Docs — XEP-0490 now covers rooms

**Files:**
- Modify: `SUPPORTED_XEPS.md`, `fluux-messenger.doap`, `CHANGELOG.md`

- [ ] **Step 1: Update the XEP-0490 wording**

In `SUPPORTED_XEPS.md`, change the XEP-0490 row note from "Syncs the 1:1 last-read position…" to cover rooms:

```
| [XEP-0490](https://xmpp.org/extensions/xep-0490.html) | Message Displayed Synchronization | ✅ Implemented | Syncs the last-read position for 1:1 chats and MUC rooms across devices via a private PEP node (`urn:xmpp:mds:displayed:0`); forward-only by archive order, with local fallback when PEP is unavailable |
```

In `fluux-messenger.doap`, update the XEP-0490 `<xmpp:note>` similarly:

```xml
        <xmpp:note>Syncs the last-read position for 1:1 chats and MUC rooms across devices via a private PEP node (urn:xmpp:mds:displayed:0); forward-only by archive order with local fallback</xmpp:note>
```

In `CHANGELOG.md`, under the existing `## [Unreleased]` → `### Added`, update the read-sync line to mention rooms:

```
- Read-position sync across your devices (XEP-0490 Message Displayed Synchronization): the last-read marker in 1:1 chats and group chats now follows you between desktop and web
```

- [ ] **Step 2: Validate the DOAP is still well-formed XML**

Run: `xmllint --noout fluux-messenger.doap && echo ok`
Expected: `ok` (no parser output). `xmllint` (libxml2) ships with macOS/most Linux; it avoids the XXE/billion-laughs caveats of Python's stdlib XML parsers. If `xmllint` is unavailable, use a hardened parser instead (`python3 -c "from defusedxml.ElementTree import parse; parse('fluux-messenger.doap'); print('ok')"`), not stdlib `xml.etree`.

- [ ] **Step 3: Commit**

```bash
git add SUPPORTED_XEPS.md fluux-messenger.doap CHANGELOG.md
git commit -m "docs(mds): XEP-0490 read-position sync now covers MUC rooms"
```

---

## Task 7: Full-suite verification + dist sync

**Files:** none (verification only).

- [ ] **Step 1: SDK suite**

Run: `cd packages/fluux-sdk && npx vitest run`
Expected: all pass, no stderr beyond the pre-existing `--localstorage-file` node warnings.

- [ ] **Step 2: Rebuild + sync dist**

Run from repo root:
```bash
npm run build:sdk
rsync -a --delete packages/fluux-sdk/dist/ /Users/mremond/AIProjects/fluux-messenger/packages/fluux-sdk/dist/
```

- [ ] **Step 3: App suite + typecheck + lint**

Run: `cd apps/fluux && npx vitest run` then from root `npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 4: Commit any test-mock fixes (if needed)**

```bash
git add -A
git commit -m "test(mds): align mocks for MUC read-sync"
```

---

## Self-Review

**Spec coverage:**
- Generalize event → Task 1 ✅
- Route in storeBindings by room membership → Task 4 ✅
- `roomStore.applyRemoteDisplayed` (forward-only mirror) + `RoomMetadata.pendingRemoteDisplayedStanzaId` → Task 2 ✅
- Resolve pending on room MAM merge → Task 3 ✅
- Dual-store publisher (room-archive stanza-id) + seed routing + seed-ordering edge → Task 5 ✅
- Ephemeral fallback (no new persistence) → honored throughout (no persist changes) ✅
- Stanza-id correctness verification → Task 5 Step 1 ✅
- Binding surface (test-utils mock, not the narrow iface) → Task 4 ✅
- Docs → Task 6 ✅

**Placeholder scan:** test helpers `seedRoom`/the fake-client/store-ref names and the `RSMResponse` shape are flagged "use the real one from `roomStore.test.ts`/the existing test file" — these are read-from-actual-code instructions, not inventable values, the same convention used (and proven) by the 1:1 plan.

**Type consistency:** `applyRemoteDisplayed(jid, stanzaId)` identical across Task 2 (def), Task 3 (call), Task 4 (binding), Task 5 (seed). Event `read:displayed-synced { conversationId, stanzaId }` consistent Task 1 ↔ 4 ↔ 5. `pendingRemoteDisplayedStanzaId` consistent Task 2 ↔ 3.
