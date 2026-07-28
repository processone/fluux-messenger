# Room MAM After Confirmed Join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an active room restored as `joined=true` from starting fresh-session MAM before the new stream confirms MUC membership.

**Architecture:** Keep the global connection lifecycle unchanged and add a private, session-local join-confirmation gate inside `setupRoomSideEffects`. Fresh `online` resets fetch tracking and requires a successful `room:joined`; SM `resumed` disables that requirement. Revalidate the active room, confirmed join, and connection after asynchronous cache hydration before issuing MAM.

**Tech Stack:** TypeScript, Zustand vanilla stores, Vitest, the SDK internal/SDK event emitters.

## Global Constraints

- Do not reorder the global `online` event.
- Do not change persisted `joined` snapshot semantics.
- Do not redesign the fresh-session or SM-resumption lifecycle.
- A fresh-session room MAM query requires a successful `room:joined` observed in that fresh session.
- A successful SM resume continues to trust preserved MUC membership.
- An uninterrupted missing-marker SM upgrade preserves joins observed before
  its synthetic `online`; a later transport reconnect does not.
- A superseded cache-hydration attempt cannot query MAM or clear state owned by
  its replacement.
- Keep delayed background catch-up for inactive rooms unchanged.
- Keep the separate cache-first sidebar preview refresh unchanged.
- Do not address the redundant first-activation IndexedDB read in this change.
- Add no public SDK API and no persisted state.

---

## File map

- `packages/fluux-sdk/src/core/roomSideEffects.ts`
  - Owns the private fresh-session confirmation gate.
  - Distinguishes an uninterrupted post-resume synthetic `online`.
  - Owns private per-room fetch-attempt identities.
  - Starts foreground room catch-up only from an eligible active room.
  - Revalidates eligibility after IndexedDB cache hydration.
- `packages/fluux-sdk/src/core/roomSideEffects.test.ts`
  - Proves event ordering, synthetic-online preservation, late `supportsMAM`
    fallback, post-cache race aborts, replacement ownership, and retryability.
- `packages/fluux-sdk/src/core/networkScenario.testHelpers.ts`
  - Keeps the fresh-session journey description aligned with production order.
- `packages/fluux-sdk/src/core/networkScenarios.test.ts`
  - Proves the hydrated-room fresh-session journey does not query MAM before
    invalidation/rejoin and does query exactly once after confirmation.
- `packages/fluux-sdk/src/core/chatNetworkScenarios.test.ts`
  - Adapts the concurrent chat/room scenario so chat MAM starts on `online`
    while room MAM waits for confirmed `room:joined`.
- `docs/superpowers/specs/2026-07-27-room-mam-after-join-design.md`
  - Already contains the approved behavior and the join-confirmation
    clarification discovered during plan self-review.

---

### Task 1: Gate fresh-session room MAM on a confirmed join

**Files:**
- Modify: `packages/fluux-sdk/src/core/roomSideEffects.ts:44-50`
- Modify: `packages/fluux-sdk/src/core/roomSideEffects.ts:58-87`
- Modify: `packages/fluux-sdk/src/core/roomSideEffects.ts:201-218`
- Modify: `packages/fluux-sdk/src/core/roomSideEffects.ts:238-310`
- Test: `packages/fluux-sdk/src/core/roomSideEffects.test.ts`
- Modify: `packages/fluux-sdk/src/core/networkScenario.testHelpers.ts:110-130`
- Test: `packages/fluux-sdk/src/core/networkScenarios.test.ts:196-224`

**Interfaces:**
- Consumes:
  - `client.on('online' | 'resumed', handler)`
  - `client.subscribe('room:joined', handler)`
  - `roomStore.getState().setRoomJoined(roomJid, joined)`
  - existing `fetchInitiated: Set<string>`
- Produces no public interface.
- Adds private state:
  - `freshSessionRequiresJoinConfirmation: boolean`
  - `freshSessionJoinedRooms: Set<string>`
  - `hasConfirmedJoinForCurrentSession(roomJid: string): boolean`

- [ ] **Step 1: Add the failing hydrated-room ordering regression**

In `roomSideEffects.test.ts`, add a local helper just inside the top-level
`describe`:

```ts
const ROOM = 'room@conference.example.com'

function confirmRoomJoin(roomJid = ROOM) {
  roomStore.getState().setRoomJoined(roomJid, true)
  mockClient._emitSDK('room:joined', { roomJid, joined: true })
}
```

Under `describe('reconnection')`, add:

```ts
it('waits for a fresh-session room:joined before catching up a hydrated active room', async () => {
  roomStore.getState().addRoom({
    jid: ROOM,
    name: 'Test Room',
    nickname: 'testuser',
    joined: true, // hydrated SM snapshot, not confirmed in the new stream
    supportsMAM: true,
    occupants: new Map(),
    messages: [],
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
    isBookmarked: true,
  })
  roomStore.getState().setActiveRoom(ROOM)
  connectionStore.getState().setStatus('disconnected')
  cleanup = setupRoomSideEffects(mockClient)

  simulateFreshSession(mockClient)
  await new Promise(resolve => setTimeout(resolve, 50))

  expect(mockClient.mam.catchUpRoomHistory).not.toHaveBeenCalled()

  roomStore.getState().markAllRoomsNotJoined()
  confirmRoomJoin()

  await vi.waitFor(() => {
    expect(mockClient.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
  })
  expect(mockClient.mam.catchUpRoomHistory).toHaveBeenCalledWith(
    ROOM,
    expect.any(Array),
    expect.objectContaining({ sessionStartTime: expect.any(Number) }),
  )
})
```

- [ ] **Step 2: Run the ordering regression and verify RED**

Run:

```bash
cd packages/fluux-sdk
npx vitest run src/core/roomSideEffects.test.ts \
  -t "waits for a fresh-session room:joined"
```

Expected: FAIL at `not.toHaveBeenCalled()` because the current `online`
handler starts MAM from hydrated `joined=true`.

- [ ] **Step 3: Add the private fresh-session confirmation gate**

In `setupRoomSideEffects`, beside `fetchInitiated`, add:

```ts
const freshSessionJoinedRooms = new Set<string>()
let freshSessionRequiresJoinConfirmation = false

function hasConfirmedJoinForCurrentSession(roomJid: string): boolean {
  return (
    !freshSessionRequiresJoinConfirmation ||
    freshSessionJoinedRooms.has(roomJid)
  )
}
```

In `fetchMAMForRoom`, immediately after the existing `room.joined` guard, add:

```ts
if (!hasConfirmedJoinForCurrentSession(roomJid)) {
  if (debug) {
    console.log(
      '[SideEffects] Room: Skipping MAM - fresh-session join not confirmed',
      roomJid,
    )
  }
  return
}
```

Replace the current `online` handler body after `sessionStartTime = Date.now()`
with unconditional reset-only behavior:

```ts
freshSessionRequiresJoinConfirmation = true
freshSessionJoinedRooms.clear()
fetchInitiated.clear()

if (debug) {
  console.log(
    '[SideEffects] Room: Fresh session — waiting for confirmed room joins before MAM',
  )
}
```

Do not read `activeRoomJid` and do not call `fetchMAMForRoom` from `online`.

At the start of the existing `resumed` handler, before archive-held seeding,
disable the fresh-session gate:

```ts
freshSessionRequiresJoinConfirmation = false
freshSessionJoinedRooms.clear()
```

Replace the start of the `room:joined` listener with:

```ts
const unsubscribeRoomJoined = client.subscribe('room:joined', ({ roomJid, joined }) => {
  if (!joined) {
    freshSessionJoinedRooms.delete(roomJid)
    return
  }

  freshSessionJoinedRooms.add(roomJid)

  const activeRoomJid = roomStore.getState().activeRoomJid
  if (roomJid !== activeRoomJid) return
  if (fetchInitiated.has(roomJid)) return

  if (debug) {
    console.log(
      '[SideEffects] Room: Self-presence received, triggering MAM fetch',
      roomJid,
    )
  }
  void fetchMAMForRoom(roomJid)
})
```

Recording the join before the active-room filter is required: a background
autojoin must remain eligible when the user opens it later.

- [ ] **Step 4: Update existing tests to use the new lifecycle contract**

In `roomSideEffects.test.ts`, make these exact fixture changes:

1. `should trigger MAM fetch when supportsMAM becomes true on active room`
   - after `simulateFreshSession`, call
     `roomStore.getState().markAllRoomsNotJoined()`;
   - call `confirmRoomJoin()` while `supportsMAM` is still false;
   - then update `supportsMAM: true`;
   - retain the expectation that the watcher starts one catch-up. This proves
     the late-capability fallback still works after confirmed self-presence.
2. `should not trigger MAM fetch if supportsMAM was already true`
   - after `simulateFreshSession`, call
     `roomStore.getState().markAllRoomsNotJoined()`;
   - activate `ROOM`;
   - call `confirmRoomJoin()`;
   - await the initial catch-up before clearing its mock;
   - retain the existing unrelated-room-update assertion. This preserves the
     test's original purpose under the confirmed-join lifecycle.
3. The four tests in `describe('reconnection')` that currently rely on
   `simulateFreshSession` alone:
   - call `roomStore.getState().markAllRoomsNotJoined()`;
   - call `confirmRoomJoin()`;
   - then retain their cache/cursor expectations.
4. `should NOT trigger MAM when room:joined fires for non-active room`
   - model the active room rejoin first with
     `markAllRoomsNotJoined(); confirmRoomJoin('active-room@conference.example.com')`;
   - wait for and clear that one active catch-up;
   - then confirm the non-active room and retain the zero-call assertion.
5. `should NOT trigger MAM when room:joined fires with joined=false`
   - model and await one confirmed active join first;
   - clear the mock;
   - emit the `joined=false` event and retain the zero-call assertion.
6. `should trigger MAM correctly after SM resume then fresh session`
   - after the fresh `online`, assert zero calls;
   - call `markAllRoomsNotJoined(); confirmRoomJoin()`;
   - then expect the catch-up.

Update stale comments that say fresh `online` itself triggers active-room MAM.

- [ ] **Step 5: Strengthen the multi-step fresh-session journey**

In `networkScenario.testHelpers.ts`, change the helper comment to:

```ts
/**
 * Simulate the full fresh session flow:
 * 1. Emit 'online' (reset fetch tracking and require confirmed joins)
 * 2. markAllRoomsNotJoined()
 * 3. Re-join specified rooms and emit room:joined
 * 4. Foreground MAM may start only after step 3
 */
```

In Scenario 5 of `networkScenarios.test.ts`, import the lower-level helper:

```ts
import { simulateFreshSession } from './sideEffects.testHelpers'
```

Replace the single `simulateFreshSessionWithRejoin` call with the explicit
journey:

```ts
simulateFreshSession(client)
await settle()
expect(client.mam.catchUpRoomHistory).not.toHaveBeenCalled()

roomStore.getState().markAllRoomsNotJoined()
roomStore.getState().setRoomJoined('room@conference.example.com', true)
client._emitSDK('room:joined', {
  roomJid: 'room@conference.example.com',
  joined: true,
})
await settle()
```

Keep the final `joined=true` assertion and change the MAM assertion to
`toHaveBeenCalledTimes(1)` plus the existing argument match.

- [ ] **Step 6: Run the focused side-effect and journey tests**

Run:

```bash
cd packages/fluux-sdk
npx vitest run \
  src/core/roomSideEffects.test.ts \
  src/core/networkScenarios.test.ts
```

Expected: both files pass; the fresh-session ordering test observes zero MAM
before `room:joined` and exactly one afterward.

- [ ] **Step 7: Commit the confirmed-join gate**

```bash
git add \
  packages/fluux-sdk/src/core/roomSideEffects.ts \
  packages/fluux-sdk/src/core/roomSideEffects.test.ts \
  packages/fluux-sdk/src/core/networkScenario.testHelpers.ts \
  packages/fluux-sdk/src/core/networkScenarios.test.ts
git commit -m "fix(muc): wait for confirmed join before MAM catch-up"
```

---

### Task 2: Abort a stale foreground catch-up after cache hydration

**Files:**
- Modify: `packages/fluux-sdk/src/core/roomSideEffects.ts:104-129`
- Test: `packages/fluux-sdk/src/core/roomSideEffects.test.ts`

**Interfaces:**
- Consumes the Task 1 private gate through
  `hasConfirmedJoinForCurrentSession(roomJid)`.
- Produces private
  `isRoomFetchStillEligible(roomJid: string): boolean`.
- Preserves `fetchMAMForRoom(roomJid: string): Promise<void>` as the only
  foreground catch-up entry point.

- [ ] **Step 1: Add a controllable cache promise helper**

Near the imports in `roomSideEffects.test.ts`, add:

```ts
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
```

- [ ] **Step 2: Add the failing leave-during-cache test**

Under a new `describe('post-cache eligibility')`, add:

```ts
it('aborts before MAM when the room leaves during cache hydration', async () => {
  const cache = deferred<[]>()
  roomStore.getState().addRoom({
    jid: ROOM,
    name: 'Test Room',
    nickname: 'testuser',
    joined: false,
    supportsMAM: true,
    occupants: new Map(),
    messages: [],
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
    isBookmarked: true,
  })
  roomStore.getState().setActiveRoom(ROOM)
  cleanup = setupRoomSideEffects(mockClient)
  simulateFreshSession(mockClient)

  const loadSpy = vi.spyOn(
    roomStore.getState(),
    'loadMessagesFromCache',
  ).mockReturnValue(cache.promise)

  confirmRoomJoin()
  expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(true)

  roomStore.getState().setRoomJoined(ROOM, false)
  cache.resolve([])

  await vi.waitFor(() => {
    expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(false)
  })
  expect(mockClient.mam.catchUpRoomHistory).not.toHaveBeenCalled()

  loadSpy.mockRestore()
})
```

- [ ] **Step 3: Run the leave race test and verify RED**

Run:

```bash
cd packages/fluux-sdk
npx vitest run src/core/roomSideEffects.test.ts \
  -t "aborts before MAM when the room leaves"
```

Expected: FAIL because current code calls `catchUpRoomHistory` after the cache
promise resolves without re-reading room state.

- [ ] **Step 4: Add post-cache eligibility revalidation**

Inside `setupRoomSideEffects`, add:

```ts
function isRoomFetchStillEligible(roomJid: string): boolean {
  const state = roomStore.getState()
  const room = state.rooms.get(roomJid)
  return !!(
    room &&
    state.activeRoomJid === roomJid &&
    room.joined &&
    room.supportsMAM &&
    !room.isQuickChat &&
    hasConfirmedJoinForCurrentSession(roomJid) &&
    connectionStore.getState().status === 'online' &&
    client.isConnected()
  )
}
```

Immediately after `loadMessagesFromCache` resolves and before reading
`roomMessages`, add:

```ts
if (!isRoomFetchStillEligible(roomJid)) {
  fetchInitiated.delete(roomJid)
  roomStore.getState().setRoomMAMLoading(roomJid, false)
  if (debug) {
    console.log(
      '[SideEffects] Room: MAM aborted after cache hydration - room no longer eligible',
      roomJid,
    )
  }
  return
}
```

Do not throw for this expected race; throwing would route through the error
logger and misclassify normal leave/switch/disconnect behavior.

- [ ] **Step 5: Add disconnect and active-room-switch race controls**

Add:

```ts
it('aborts before MAM when the connection drops during cache hydration', async () => {
  const cache = deferred<[]>()
  roomStore.getState().addRoom({
    jid: ROOM,
    name: 'Test Room',
    nickname: 'testuser',
    joined: false,
    supportsMAM: true,
    occupants: new Map(),
    messages: [],
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
    isBookmarked: true,
  })
  roomStore.getState().setActiveRoom(ROOM)
  cleanup = setupRoomSideEffects(mockClient)
  simulateFreshSession(mockClient)

  const loadSpy = vi.spyOn(
    roomStore.getState(),
    'loadMessagesFromCache',
  ).mockReturnValue(cache.promise)

  confirmRoomJoin()

  connectionStore.getState().setStatus('reconnecting')
  cache.resolve([])

  await vi.waitFor(() => {
    expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(false)
  })
  expect(mockClient.mam.catchUpRoomHistory).not.toHaveBeenCalled()

  loadSpy.mockRestore()
})
```

Then add:

```ts
it('aborts before MAM when another room becomes active during cache hydration', async () => {
  const cache = deferred<[]>()
  const OTHER = 'other@conference.example.com'
  roomStore.getState().addRoom({
    jid: ROOM,
    name: 'Test Room',
    nickname: 'testuser',
    joined: false,
    supportsMAM: true,
    occupants: new Map(),
    messages: [],
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
    isBookmarked: true,
  })
  roomStore.getState().addRoom({
    jid: OTHER,
    name: 'Other Room',
    nickname: 'testuser',
    joined: false,
    supportsMAM: false,
    occupants: new Map(),
    messages: [],
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
    isBookmarked: true,
  })
  roomStore.getState().setActiveRoom(ROOM)
  cleanup = setupRoomSideEffects(mockClient)
  simulateFreshSession(mockClient)

  const loadSpy = vi.spyOn(
    roomStore.getState(),
    'loadMessagesFromCache',
  ).mockImplementation((roomJid) => {
    return roomJid === ROOM ? cache.promise : Promise.resolve([])
  })

  confirmRoomJoin()
  roomStore.getState().setActiveRoom(OTHER)
  cache.resolve([])

  await vi.waitFor(() => {
    expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(false)
  })
  expect(mockClient.mam.catchUpRoomHistory).not.toHaveBeenCalledWith(
    ROOM,
    expect.anything(),
    expect.anything(),
  )

  loadSpy.mockRestore()
})
```

Do not share mutable room objects between tests.

- [ ] **Step 6: Prove an aborted room remains retryable**

Extend the leave test after its zero-query assertion:

```ts
loadSpy.mockResolvedValue([])
roomStore.getState().setRoomJoined(ROOM, true)
mockClient._emitSDK('room:joined', { roomJid: ROOM, joined: true })

await vi.waitFor(() => {
  expect(mockClient.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
})
```

This control proves both `fetchInitiated` and `isLoading` were cleared by the
abort path.

- [ ] **Step 7: Run the complete focused suite**

Run:

```bash
cd packages/fluux-sdk
npx vitest run \
  src/core/roomSideEffects.test.ts \
  src/core/networkScenarios.test.ts
```

Expected: all focused tests pass, including the three cache-hydration races and
the retry control.

- [ ] **Step 8: Commit the post-cache race guard**

```bash
git add \
  packages/fluux-sdk/src/core/roomSideEffects.ts \
  packages/fluux-sdk/src/core/roomSideEffects.test.ts
git commit -m "fix(mam): abort stale room catch-up before query"
```

---

### Task 3: Run repository regression gates and review the final scope

**Files:**
- Verify only; no production file is added in this task.
- Review:
  - `packages/fluux-sdk/src/core/roomSideEffects.ts`
  - `packages/fluux-sdk/src/core/roomSideEffects.test.ts`
  - `packages/fluux-sdk/src/core/networkScenario.testHelpers.ts`
  - `packages/fluux-sdk/src/core/networkScenarios.test.ts`
  - `packages/fluux-sdk/src/core/chatNetworkScenarios.test.ts`
  - `docs/superpowers/specs/2026-07-27-room-mam-after-join-design.md`

**Interfaces:**
- Consumes the two independently committed implementation tasks.
- Produces a verified branch ready for preflight/review.

- [ ] **Step 1: Run the focused room network tests from the repository root**

```bash
npx vitest run \
  packages/fluux-sdk/src/core/roomSideEffects.test.ts \
  packages/fluux-sdk/src/core/networkScenarios.test.ts
```

Expected: both test files pass with no failed tests.

- [ ] **Step 2: Run all unit tests**

```bash
npm test
```

Expected: SDK and app suites pass. Record but do not attempt to fix unrelated
baseline test-environment output such as the existing Node
`--localstorage-file`, Happy DOM canvas, or fictitious-network warnings.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: exit code 0 for both `@fluux/sdk` and `@xmpp/fluux`.

- [ ] **Step 4: Run lint**

```bash
npm run lint
```

Expected: exit code 0 and no new warnings in the modified files. Existing
repository warnings outside the modified lines are baseline, not part of this
change.

- [ ] **Step 5: Inspect the final diff and branch state**

```bash
git diff main...HEAD --check
git diff main...HEAD --stat
git status --short
```

Expected:

- no whitespace errors;
- only the approved spec, plan, room side effect, and focused test files are in
  the branch diff;
- `.agents/` remains untracked and untouched;
- no unrelated first-activation cache optimization or connection-lifecycle
  refactor appears.

- [ ] **Step 6: Review the behavioral matrix**

Confirm each row against a named test:

| Session/path | Before confirmed join | After confirmed join |
|---|---:|---:|
| Fresh, hydrated active room | no foreground MAM | exactly one foreground MAM |
| Fresh, late `supportsMAM` | no MAM | watcher starts one MAM after capability resolves |
| Fresh, inactive background join | no foreground MAM | eligible on later activation |
| SM resume, archive held | no redundant MAM | unchanged |
| SM resume, archive never held | unchanged first-open/late-capability fetch | unchanged |
| Missing-marker SM upgrade | preserve pre-synthetic-online confirmation | exactly one foreground MAM |
| Leave/disconnect/switch during cache read | abort and clear loading | later retry allowed |
| Superseded cache attempt | no stale query or cleanup | replacement owns query/loading |

If any row lacks a passing named test, add that test before declaring the branch
ready.
