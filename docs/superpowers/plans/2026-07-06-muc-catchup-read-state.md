# MUC Catch-up & Read-State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rooms (and chats) never lose read state on launch: they open at the "New messages" divider, reading (or Esc) marks read, badges hydrate from MAM catch-up, and read state syncs both ways over XEP-0490 MDS.

**Spec:** `docs/superpowers/specs/2026-07-06-muc-catchup-read-state-design.md` — read it first.

**Architecture:** All heavy lifting is SDK-side. The app already anchors entry scroll on `firstNewMessageId` when one exists (`useMessageListScroll.ts` ~line 1826, marker re-assert loop); rooms simply never have a divider today because room activation passes `treatDelayedAsNew: false` and MAM merges never touch unread counts. We (1) flip the room divider derivation, (2) add a pure `recomputeCountsFromPointer` used by MAM-merge hydration and inbound MDS, (3) make activation load the cache window around a deep pointer, (4) add `markReadToNewest` (Esc / mark-all-read), and (5) let the MDS stanza-id serve as a MAM `after` cursor on empty-cache catch-up. App side: Esc wiring, a jump pill, a menu item.

**Tech Stack:** TypeScript, Zustand vanilla stores, Vitest, Playwright (scroll e2e), react-i18next (33 locales).

## Global Constraints

- Repo root: run everything from the worktree root unless a task says otherwise.
- After ANY SDK change consumed by the app: `npm run build:sdk` before app typecheck/tests (worktree resolves `@fluux/sdk` to dist; verify `apps/fluux/node_modules/@fluux/sdk` symlink points at this worktree's package, not the main repo).
- Line numbers in this plan drift — locate code by the quoted snippets/test names, not raw line numbers.
- Any edit under `apps/fluux/src/components/conversation/` (scroll machinery): gate with `npm run test:scroll` (needs dev server buildable; Playwright chromium installed).
- Before every commit: workspace-scoped tests pass with no stderr + `npm run typecheck` (root — the dts build can pass while tsc fails). Never run bare `vitest` from root.
- SDK tests: `cd packages/fluux-sdk && npx vitest run <file>`. App tests: `cd apps/fluux && npx vitest run <file>`.
- New i18n keys: translate into ALL 33 locale files (real translations, never English placeholders; no em-dash/en-dash connectors). Locales are 4-space-indented with trailing newline — edit via parse → mutate → `JSON.stringify(obj, null, 4) + '\n'`, never a manual reformat. Keys asserted in component tests must also be added to the hardcoded i18n block in `apps/fluux/src/test-setup.ts`.
- Commit messages: conventional style, no Claude footer.
- `chatStore` conversation tests may set `conversations` without `conversationMeta`; store functions need the fallback pattern `meta?.x ?? combined.x` (already used everywhere — keep it in new code).

---

### Task 1: `recomputeCountsFromPointer` pure function

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/notificationState.ts` (append after `onMessageSeen`)
- Test: `packages/fluux-sdk/src/stores/shared/notificationState.test.ts`

**Interfaces:**
- Consumes: existing `EntityNotificationState`, `NotificationMessage` types (same file).
- Produces: `recomputeCountsFromPointer(state, messages, options?) => EntityNotificationState` with `options: { countMentions?: boolean }`. Later tasks (4, 5) import it via the existing `notifState` namespace import in both stores. Rules later tasks rely on: fresh-entity guard snaps `lastSeenMessageId` to newest; an outgoing message in the counted range advances the pointer past it; returns the SAME reference when nothing changes.

- [ ] **Step 1: Write failing tests**

Append to `notificationState.test.ts` (follow the file's existing `describe`/helper style; timestamps via `new Date()` offsets per the file's convention):

```typescript
describe('recomputeCountsFromPointer', () => {
  const msg = (id: string, minutesAgo: number, opts: Partial<NotificationMessage> = {}): NotificationMessage => ({
    id,
    timestamp: new Date(Date.now() - minutesAgo * 60_000),
    isOutgoing: false,
    isDelayed: true, // catch-up context: everything is archive-delivered
    ...opts,
  })

  it('fresh entity (no pointer, no lastReadAt) is caught up: snaps pointer to newest, zero counts', () => {
    const state = createInitialNotificationState()
    const messages = [msg('a', 30), msg('b', 20), msg('c', 10)]
    const out = recomputeCountsFromPointer(state, messages, { countMentions: true })
    expect(out.unreadCount).toBe(0)
    expect(out.mentionsCount).toBe(0)
    expect(out.lastSeenMessageId).toBe('c')
  })

  it('counts incoming messages after the pointer, including delayed ones, with mentions', () => {
    const state = { ...createInitialNotificationState(), lastSeenMessageId: 'a' }
    const messages = [msg('a', 30), msg('b', 20, { isMention: true }), msg('c', 10)]
    const out = recomputeCountsFromPointer(state, messages, { countMentions: true })
    expect(out.unreadCount).toBe(2)
    expect(out.mentionsCount).toBe(1)
    expect(out.lastSeenMessageId).toBe('a') // pointer untouched
  })

  it('pointer missing from slice: falls back to lastReadAt timestamp', () => {
    const state = {
      ...createInitialNotificationState(),
      lastSeenMessageId: 'gone',
      lastReadAt: new Date(Date.now() - 25 * 60_000),
    }
    const messages = [msg('a', 30), msg('b', 20), msg('c', 10)]
    const out = recomputeCountsFromPointer(state, messages)
    expect(out.unreadCount).toBe(2) // b and c are newer than lastReadAt
  })

  it('pointer missing and no usable lastReadAt: counts the whole slice (lower bound)', () => {
    const state = { ...createInitialNotificationState(), lastSeenMessageId: 'gone', lastReadAt: new Date(0) }
    const messages = [msg('a', 30), msg('b', 20)]
    const out = recomputeCountsFromPointer(state, messages)
    expect(out.unreadCount).toBe(2)
  })

  it('an outgoing message in range marks everything before it read and advances the pointer', () => {
    const state = { ...createInitialNotificationState(), lastSeenMessageId: 'a' }
    const messages = [msg('a', 40), msg('b', 30), msg('mine', 20, { isOutgoing: true }), msg('c', 10)]
    const out = recomputeCountsFromPointer(state, messages)
    expect(out.unreadCount).toBe(1) // only c
    expect(out.lastSeenMessageId).toBe('mine')
  })

  it('returns the same reference when nothing changes', () => {
    const state = { ...createInitialNotificationState(), lastSeenMessageId: 'b', unreadCount: 0 }
    const messages = [msg('a', 30), msg('b', 20)]
    expect(recomputeCountsFromPointer(state, messages)).toBe(state)
  })

  it('empty slice returns the same reference', () => {
    const state = { ...createInitialNotificationState(), lastSeenMessageId: 'x', unreadCount: 3 }
    expect(recomputeCountsFromPointer(state, [])).toBe(state)
  })
})
```

Add `recomputeCountsFromPointer` to the file's import list from `./notificationState`.

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts`
Expected: FAIL — `recomputeCountsFromPointer` is not exported.

- [ ] **Step 3: Implement**

Append to `notificationState.ts` after `onMessageSeen`:

```typescript
/** Options for {@link recomputeCountsFromPointer}. */
export interface RecomputeCountsOptions {
  /** Count `isMention` messages into mentionsCount (rooms). */
  countMentions?: boolean
}

/**
 * Recompute unreadCount/mentionsCount from the persisted read pointer against
 * a freshly merged message slice (sorted oldest → newest). Used by MAM
 * catch-up hydration and inbound XEP-0490 marker handling — never by the live
 * message path (onMessageReceived owns incremental counting).
 *
 * Fresh-entity guard: an entity with NO read state (no lastSeenMessageId, no
 * lastReadAt) is caught up — the pointer snaps to the newest message and
 * counts stay zero. History replay of a newly joined room, or a new device
 * with no MDS position, never manufactures unread debt.
 *
 * An outgoing message inside the counted range is a read boundary (the user
 * replied, here or on another device): counting restarts after the last one
 * and the pointer advances to it.
 */
export function recomputeCountsFromPointer(
  state: EntityNotificationState,
  messages: NotificationMessage[],
  options?: RecomputeCountsOptions
): EntityNotificationState {
  const { countMentions = false } = options ?? {}
  if (messages.length === 0) return state

  if (!state.lastSeenMessageId && !state.lastReadAt) {
    const newest = messages[messages.length - 1]
    if (state.unreadCount === 0 && state.mentionsCount === 0 && state.lastSeenMessageId === newest.id) {
      return state
    }
    return { ...state, unreadCount: 0, mentionsCount: 0, lastSeenMessageId: newest.id }
  }

  let startIdx: number
  const pointerIdx = state.lastSeenMessageId
    ? messages.findIndex((m) => m.id === state.lastSeenMessageId)
    : -1
  if (pointerIdx !== -1) {
    startIdx = pointerIdx + 1
  } else {
    const readAt = state.lastReadAt instanceof Date
      ? state.lastReadAt
      : state.lastReadAt ? new Date(state.lastReadAt as unknown as string) : undefined
    if (readAt && readAt.getTime() > 0) {
      const idx = messages.findIndex((m) => m.timestamp > readAt)
      startIdx = idx === -1 ? messages.length : idx
    } else {
      // Pointer resolves nowhere and no usable timestamp: the slice is
      // entirely past the read horizon — count it all (a lower bound).
      startIdx = 0
    }
  }

  let newPointer = state.lastSeenMessageId
  for (let i = messages.length - 1; i >= startIdx; i--) {
    if (messages[i].isOutgoing) {
      newPointer = messages[i].id
      startIdx = i + 1
      break
    }
  }

  let unread = 0
  let mentions = 0
  for (let i = startIdx; i < messages.length; i++) {
    const m = messages[i]
    if (m.isOutgoing) continue
    unread++
    if (countMentions && m.isMention) mentions++
  }

  const mentionsOut = countMentions ? mentions : state.mentionsCount
  if (unread === state.unreadCount && mentionsOut === state.mentionsCount && newPointer === state.lastSeenMessageId) {
    return state
  }
  return { ...state, unreadCount: unread, mentionsCount: mentionsOut, lastSeenMessageId: newPointer }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts`
Expected: PASS, no stderr.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/notificationState.ts packages/fluux-sdk/src/stores/shared/notificationState.test.ts
git commit -m "feat(sdk): add recomputeCountsFromPointer for read-state hydration"
```

---

### Task 2: Divider flip for rooms + resume-preserving stale-pointer handling

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/notificationState.ts` (`onActivate` stale path, `onMessageSeen` signature, `onActivate` docstring)
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (`setActiveRoom` onActivate call; `applyRemoteDisplayed` active-room divider recompute; `updateLastSeenMessageId` live-edge flag)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (`updateLastSeenMessageId` equivalent — pass live-edge flag)
- Test: `packages/fluux-sdk/src/stores/roomStore.test.ts`, `packages/fluux-sdk/src/stores/shared/notificationState.test.ts`

**Interfaces:**
- Consumes: `onActivate(state, messages, { treatDelayedAsNew })`, `onMessageSeen(state, messageId, messages)`.
- Produces: `onMessageSeen(state, messageId, messages, options?: { atLiveEdge?: boolean })` — when the pointer is unresolvable in the slice AND `atLiveEdge` AND `messageId` is the last message, the pointer advances (jump-to-present must never leave a stuck pointer). `onActivate` stale-pointer path now snaps the pointer to the message just BEFORE the derived divider (resume-preserving) instead of to the newest; snap-to-newest remains only when no divider could be derived.

- [ ] **Step 1: Write failing tests**

In `notificationState.test.ts`:

```typescript
describe('onActivate stale pointer (resume-preserving)', () => {
  it('snaps pointer to the message before the derived divider, not to the newest', () => {
    const mkMsg = (id: string, minutesAgo: number): NotificationMessage => ({
      id, timestamp: new Date(Date.now() - minutesAgo * 60_000), isOutgoing: false, isDelayed: true,
    })
    const state = {
      ...createInitialNotificationState(),
      lastSeenMessageId: 'evicted',
      lastReadAt: new Date(Date.now() - 25 * 60_000),
    }
    const messages = [mkMsg('a', 30), mkMsg('b', 20), mkMsg('c', 10)]
    const out = onActivate(state, messages, { treatDelayedAsNew: true })
    expect(out.firstNewMessageId).toBe('b')
    expect(out.lastSeenMessageId).toBe('a') // predecessor of divider — NOT 'c'
  })
})

describe('onMessageSeen atLiveEdge advance', () => {
  it('advances an unresolvable pointer when viewing the newest message at the live edge', () => {
    const state = { ...createInitialNotificationState(), lastSeenMessageId: 'evicted' }
    const messages = [{ id: 'a' }, { id: 'b' }]
    const out = onMessageSeen(state, 'b', messages, { atLiveEdge: true })
    expect(out.lastSeenMessageId).toBe('b')
  })
  it('stays guarded off the live edge (window slid up — no regression)', () => {
    const state = { ...createInitialNotificationState(), lastSeenMessageId: 'newer-than-slice' }
    const messages = [{ id: 'a' }, { id: 'b' }]
    expect(onMessageSeen(state, 'b', messages, { atLiveEdge: false })).toBe(state)
    expect(onMessageSeen(state, 'a', messages, { atLiveEdge: true })).toBe(state) // not the newest
  })
})
```

In `roomStore.test.ts`, find the test asserting "no marker when only delayed history follows lastSeen" (~line 4657) and INVERT it: delayed history after lastSeen now yields a marker at the first delayed message. Add a fresh-join companion:

```typescript
it('places the divider on delayed history after lastSeen (unified with chats)', () => {
  // Reuse the existing test's setup verbatim, but expect:
  // useRoomStore.getState().firstNewMessageMarkers.get(roomJid) === firstDelayedId
})

it('fresh join (no read state) derives no marker from delayed history', () => {
  // Same setup WITHOUT seeding lastSeenMessageId/lastReadAt/unreadCount;
  // after setActiveRoom, firstNewMessageMarkers.get(roomJid) is undefined.
})
```

- [ ] **Step 2: Run, verify failures**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts src/stores/roomStore.test.ts`
Expected: the new tests FAIL; note which existing room-marker tests fail — they are behavior inversions to update in Step 3 (update expectations only where the spec says behavior changed; investigate anything else).

- [ ] **Step 3: Implement**

(a) `notificationState.ts` — in `onActivate`'s `lastSeenIdx === -1` branch, replace the unconditional snap:

```typescript
      // Resume-preserving pointer placement: snap the pointer to the message
      // just BEFORE the derived divider so viewport advance works inside this
      // slice. Snapping to the NEWEST (previous behavior) destroyed the resume
      // point whenever the backlog was deeper than the loaded window. When no
      // divider could be derived there is nothing to resume — snap to newest
      // as before so the stale-fallback doesn't repeat forever.
      if (firstNewMessageId) {
        const dividerIdx = messages.findIndex((m) => m.id === firstNewMessageId)
        if (dividerIdx > 0) updatedLastSeenMessageId = messages[dividerIdx - 1].id
        // dividerIdx === 0: whole slice is unread — keep the old pointer;
        // onMessageSeen's atLiveEdge escape hatch prevents a stuck pointer.
      } else {
        const lastMsg = messages[messages.length - 1]
        if (lastMsg) updatedLastSeenMessageId = lastMsg.id
      }
```

(b) `onMessageSeen` — add the options parameter and live-edge escape hatch:

```typescript
export function onMessageSeen(
  state: EntityNotificationState,
  messageId: string,
  messages: Array<{ id: string }>,
  options?: { atLiveEdge?: boolean }
): EntityNotificationState {
```

and replace the `currentIdx === -1` early return with:

```typescript
  if (currentIdx === -1) {
    // Unresolvable pointer (older than the slice, or evicted). Viewing the
    // NEWEST message while the window is at the live edge is an unambiguous
    // maximum — advancing cannot regress. Off the live edge the slice's last
    // message may be older than the pointer, so stay guarded.
    if (options?.atLiveEdge && newIdx !== -1 && newIdx === messages.length - 1) {
      return { ...state, lastSeenMessageId: messageId }
    }
    return state
  }
```

(c) Update `onActivate`'s docstring: rooms and chats now BOTH pass `treatDelayedAsNew: true`; delayed history counts as new relative to the pointer, and the fresh-entity guard (Task 1 / activation paths) protects fresh joins.

(d) `roomStore.ts` `setActiveRoom` — the `onActivate` call becomes:

```typescript
        const activated = notifState.onActivate(notifInput, messages, { treatDelayedAsNew: true })
```

(e) `roomStore.ts` `applyRemoteDisplayed` — the active-room divider recompute (`notifState.onActivate(...)` inside the `state.activeRoomJid === roomJid` branch): add `{ treatDelayedAsNew: true }` as the third argument and update its comment (chat's equivalent already passes it).

(f) `roomStore.ts` `updateLastSeenMessageId` — pass the live-edge flag:

```typescript
      const atLiveEdge = state.roomRuntime.get(roomJid)?.windowAtLiveEdge !== false
      const updated = notifState.onMessageSeen(notifInput, messageId, messages, { atLiveEdge })
```

(g) `chatStore.ts` `updateLastSeenMessageId` (locate the `onMessageSeen` call): pass the equivalent flag from the chat runtime's `windowAtLiveEdge` (same `!== false` idiom; find the field with `grep -n "windowAtLiveEdge" chatStore.ts`).

- [ ] **Step 4: Run tests**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts src/stores/roomStore.test.ts src/stores/chatStore.test.ts`
Expected: PASS after inverting the flagged legacy expectations. Then the full SDK suite: `npx vitest run` (from `packages/fluux-sdk`) — PASS, no stderr.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src
git commit -m "feat(sdk): rooms derive the unread divider from delayed history (unified with chats)"
```

---

### Task 3: Activation loads the cache window around a deep pointer

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (`activateRoom`)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (`activateConversation`)
- Test: `packages/fluux-sdk/src/stores/roomStore.test.ts`, `packages/fluux-sdk/src/stores/chatStore.test.ts`

**Interfaces:**
- Consumes: existing `loadMessagesFromCache(jid, { limit: 100 })`, `loadMessagesAroundFromCache(jid, anchorMessageId, options?)` (both stores), activation-token stale-guard pattern, `mdsConsumedThisSession` fold.
- Produces: activation guarantees that if `lastSeenMessageId` is set and resolvable from IndexedDB, it is present in the resident slice before `setActiveRoom`/`setActiveConversation` derives the divider. The app's existing marker-entry scroll then anchors it. Cache miss → latest-100 slice + Task 2's degrade path (spec §5: degrade gracefully, never block open).

- [ ] **Step 1: Write failing test (room)**

In `roomStore.test.ts`, near the existing `activateRoom` tests (reuse their `messageCache` mock idiom — the suite mocks `messageCache`; extend the mock so `getMessagesAround`/the store's `loadMessagesAroundFromCache` path can return a fixture):

```typescript
it('activateRoom reloads the window around a pointer deeper than the latest slice', async () => {
  // Arrange: cache holds 300 messages; latest-100 slice does NOT contain
  // meta.lastSeenMessageId ('msg-150'). Seed roomMeta.lastSeenMessageId = 'msg-150'.
  // Assert: after activateRoom, the resident runtime slice CONTAINS 'msg-150'
  // and firstNewMessageMarkers.get(roomJid) === 'msg-151'.
})
```

And the mirror test in `chatStore.test.ts` for `activateConversation`.

- [ ] **Step 2: Run, verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts -t "reloads the window around"`
Expected: FAIL — slice is the latest 100, marker degraded.

- [ ] **Step 3: Implement (room)**

In `activateRoom`, after the MDS fold block and before `setActiveRoom(roomJid)`:

```typescript
      // Resume anchor: if the read pointer is deeper than the latest-100
      // slice, reload the window AROUND it (IndexedDB only) so the divider
      // derives inside the slice and the entry scroll can anchor on it. The
      // fold above ran first — it may have advanced the pointer to the synced
      // position. A cache miss keeps the latest slice; the divider then
      // degrades via the stale-pointer fallback (spec §5) and MAM catch-up
      // heals the cache for the next open.
      const pointer = get().roomMeta.get(roomJid)?.lastSeenMessageId
      if (pointer) {
        const loaded = get().roomRuntime.get(roomJid)?.messages ?? get().rooms.get(roomJid)?.messages ?? []
        if (!loaded.some((m) => m.id === pointer)) {
          await get().loadMessagesAroundFromCache(roomJid, pointer)
          if (token !== activationToken) return
        }
      }
```

Mirror in `chatStore.activateConversation` (same shape, `conversationMeta` / `messages` map / its own activation token).

- [ ] **Step 4: Run tests**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts src/stores/chatStore.test.ts`
Expected: PASS, no stderr.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores
git commit -m "feat(sdk): activation loads the cache window around a deep read pointer"
```

---

### Task 4: Badge hydration on forward MAM merges

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (`mergeRoomMAMMessages`, non-active branch)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (`mergeMAMMessages`, non-active branch)
- Test: `packages/fluux-sdk/src/stores/roomStore.test.ts`, `packages/fluux-sdk/src/stores/chatStore.test.ts`

**Interfaces:**
- Consumes: `notifState.recomputeCountsFromPointer` (Task 1); `merged` array captured inside `set()`; `direction` parameter.
- Produces: after any FORWARD merge into a NON-ACTIVE entity, `roomMeta`/`conversationMeta` (and combined-map mirrors) carry pointer-derived `unreadCount`/`mentionsCount` (+ possibly an advanced pointer per the outgoing-boundary/fresh-guard rules). The rail/sidebar badges light up after catch-up with no open needed — the heart of #855.

- [ ] **Step 1: Write failing tests**

`roomStore.test.ts`:

```typescript
describe('mergeRoomMAMMessages badge hydration', () => {
  it('forward merge into a non-active room recomputes unread and mention counts from the pointer', () => {
    // Seed: room exists, non-active; roomMeta.lastSeenMessageId = 'm1'.
    // Merge forward: [m1, m2 (isMention: true, isDelayed: true), m3 (isDelayed: true)].
    // Expect roomMeta: unreadCount 2, mentionsCount 1.
  })
  it('forward merge into a room with NO read state snaps the pointer (fresh-join guard)', () => {
    // Seed: room exists, non-active, no lastSeenMessageId/lastReadAt.
    // Merge forward 3 delayed messages. Expect unreadCount 0, mentionsCount 0,
    // roomMeta.lastSeenMessageId === newest merged id.
  })
  it('backward merge does not touch counts', () => { /* direction: "backward" → counts unchanged */ })
  it('forward merge into the ACTIVE room does not touch counts', () => { /* active → counts stay 0 */ })
})
```

Mirror the first two for `chatStore.mergeMAMMessages` (no mentions).

- [ ] **Step 2: Run, verify failures**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts -t "badge hydration"`
Expected: FAIL — merge never writes counts today.

- [ ] **Step 3: Implement (room)**

In `mergeRoomMAMMessages`, inside the `set()`, in the non-active branch (the block commented "NON-ACTIVE room (background catch-up)"), before its `return`:

```typescript
        // Badge hydration (spec §1): a forward merge extends contiguous
        // history past the read pointer — recompute unread/mention counts so
        // an unopened room regains its badge after catch-up. Backward merges
        // only prepend older history (nothing after the pointer changes).
        // The live path (addMessage/onMessageReceived) keeps owning
        // incremental counting; this reconciles bulk archive delivery.
        if (direction === 'forward' && existingMeta) {
          const recomputed = notifState.recomputeCountsFromPointer(
            {
              unreadCount: existingMeta.unreadCount,
              mentionsCount: existingMeta.mentionsCount,
              lastReadAt: existingMeta.lastReadAt,
              lastSeenMessageId: existingMeta.lastSeenMessageId,
              firstNewMessageId: state.firstNewMessageMarkers.get(roomJid),
            },
            merged,
            { countMentions: true }
          )
          const hydrated = {
            ...newMeta.get(roomJid)!,
            unreadCount: recomputed.unreadCount,
            mentionsCount: recomputed.mentionsCount,
            lastSeenMessageId: recomputed.lastSeenMessageId,
          }
          newMeta.set(roomJid, hydrated)
          newRooms.set(roomJid, {
            ...newRooms.get(roomJid)!,
            unreadCount: recomputed.unreadCount,
            mentionsCount: recomputed.mentionsCount,
            lastSeenMessageId: recomputed.lastSeenMessageId,
          })
        }
```

Note: the non-active branch currently sets `newMeta` only when `existingMeta` exists and builds `newRooms` locally — adapt variable names to the surrounding code, keeping meta and combined map coherent. Mirror in `chatStore.mergeMAMMessages`'s non-active branch with `{ countMentions: false }` omitted (default) and `conversationMeta`/`conversations` maps.

- [ ] **Step 4: Run tests**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts src/stores/chatStore.test.ts`
Expected: PASS, no stderr. Watch for pre-existing merge tests asserting counts stay untouched — update only those contradicting spec §1.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores
git commit -m "feat(sdk): hydrate unread badges from forward MAM merges"
```

---

### Task 5: Inbound MDS recompute + stanza-id resolution fallback

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (`applyRemoteDisplayed` advance branch)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (`applyRemoteDisplayed` advance branch)
- Modify: `packages/fluux-sdk/src/core/mdsSideEffects.ts` (`resolveSeenStanzaId`)
- Test: `packages/fluux-sdk/src/stores/roomStore.test.ts`, `packages/fluux-sdk/src/stores/chatStore.test.ts`, `packages/fluux-sdk/src/core/mdsSideEffects.test.ts`

**Interfaces:**
- Consumes: `recomputeCountsFromPointer` (Task 1); `applyRemoteDisplayed(jid, stanzaId, messagesOverride?)` in both stores; `resolveSeenStanzaId(jid)` in mdsSideEffects.
- Produces: a remote displayed-marker for a NON-ACTIVE entity updates its badge counts immediately (spec §4 inbound). `resolveSeenStanzaId` falls back to the entity's `lastMessage` when the resident array is evicted — required by Task 6's mark-all-read publish.

- [ ] **Step 1: Write failing tests**

`roomStore.test.ts`:

```typescript
it('applyRemoteDisplayed on a non-active room recomputes badge counts', () => {
  // Seed: non-active room, roomMeta { lastSeenMessageId: 'm1', unreadCount: 3, mentionsCount: 1 }.
  // Messages m1..m4 passed as messagesOverride, m4 has stanzaId 's4', m3 is the mention.
  // Act: applyRemoteDisplayed(roomJid, 's4', messages).
  // Expect: roomMeta unreadCount 0, mentionsCount 0, lastSeenMessageId 'm4'.
})
it('applyRemoteDisplayed to a mid-history position leaves the honest remainder', () => {
  // Marker at m2's stanza-id with m3, m4 after → unreadCount 2.
})
```

Mirror one test in `chatStore.test.ts`. In `mdsSideEffects.test.ts` (follow its existing harness):

```typescript
it('resolves the seen stanza-id from lastMessage when the resident array is evicted', () => {
  // Seed: room with empty runtime messages; rooms.get(jid).lastMessage =
  //   { id: 'm9', stanzaId: 's9', ... }; roomMeta.lastSeenMessageId = 'm9'.
  // Advancing the pointer must enqueue a publish with stanza-id 's9'
  // (assert via the mocked client.mds.publishDisplayed after the debounce timer).
})

it('own PEP echo never re-publishes (no loop) — spec §5 pin', () => {
  // After a publish of stanza-id 's9' resolves, simulate the node echo:
  // the read:displayed-synced path applies the SAME position back.
  // Advance the debounce timer again and assert publishDisplayed was
  // called exactly once total (lastKnownNodeStanzaId/lastConsideredSeenId
  // suppress the echo). Follow the file's existing echo-suppression tests
  // if one exists — extend rather than duplicate.
})
```

- [ ] **Step 2: Run, verify failures**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts src/core/mdsSideEffects.test.ts`
Expected: new tests FAIL (counts untouched today; resolution returns undefined on evicted arrays).

- [ ] **Step 3: Implement**

(a) `roomStore.applyRemoteDisplayed` — in the advance branch (after `newMeta.set(roomJid, { ...meta, lastSeenMessageId: updated.lastSeenMessageId, pendingRemoteDisplayedStanzaId: undefined })`), add:

```typescript
      // Inbound read-state sync (spec §4): a marker published by another
      // client clears this room's badge now, not on the next activation.
      // The active room's counts are already zero.
      if (state.activeRoomJid !== roomJid) {
        const recomputed = notifState.recomputeCountsFromPointer(
          {
            unreadCount: meta.unreadCount,
            mentionsCount: meta.mentionsCount,
            lastReadAt: meta.lastReadAt,
            lastSeenMessageId: updated.lastSeenMessageId,
            firstNewMessageId: state.firstNewMessageMarkers.get(roomJid),
          },
          messages,
          { countMentions: true }
        )
        const entry = newMeta.get(roomJid)!
        newMeta.set(roomJid, {
          ...entry,
          unreadCount: recomputed.unreadCount,
          mentionsCount: recomputed.mentionsCount,
        })
      }
```

and fold the same counts into the `newRooms.set(roomJid, ...)` mirror below it. Mirror in `chatStore.applyRemoteDisplayed` (no mentions option; `activeConversationId`).

(b) `mdsSideEffects.resolveSeenStanzaId` — add lastMessage fallbacks:

```typescript
  function resolveSeenStanzaId(jid: string): string | undefined {
    if (isRoom(jid)) {
      const seenId = roomStore.getState().roomMeta.get(jid)?.lastSeenMessageId
      if (!seenId) return undefined
      const messages = roomStore.getState().roomRuntime.get(jid)?.messages ?? []
      const fromSlice = messages.find((m) => m.id === seenId)?.stanzaId
      if (fromSlice) return fromSlice
      // Non-active rooms keep no resident array; mark-all-read points at the
      // newest known message, whose stanza-id survives on lastMessage.
      const last = roomStore.getState().rooms.get(jid)?.lastMessage
      return last?.id === seenId ? last.stanzaId : undefined
    }
    const seenId = chatStore.getState().conversationMeta.get(jid)?.lastSeenMessageId
    if (!seenId) return undefined
    const messages = chatStore.getState().messages.get(jid) || []
    const fromSlice = messages.find((m) => m.id === seenId)?.stanzaId
    if (fromSlice) return fromSlice
    const last = chatStore.getState().conversationMeta.get(jid)?.lastMessage
      ?? chatStore.getState().conversations.get(jid)?.lastMessage
    return last?.id === seenId ? last.stanzaId : undefined
  }
```

(Adapt the chat `lastMessage` lookup to whichever of `conversationMeta`/`conversations` actually carries it — check with `grep -n "lastMessage" packages/fluux-sdk/src/stores/chatStore.ts | head`.)

- [ ] **Step 4: Run tests**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts src/stores/chatStore.test.ts src/core/mdsSideEffects.test.ts`
Expected: PASS, no stderr.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src
git commit -m "feat(sdk): inbound MDS markers clear badges live; resolve stanza-id via lastMessage"
```

---

### Task 6: `markReadToNewest` + `markAllRoomsRead` actions and hooks

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (interface + implementation)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (interface + implementation)
- Modify: `packages/fluux-sdk/src/hooks/useRoomActions.ts`, `packages/fluux-sdk/src/hooks/useChatActions.ts`
- Test: `packages/fluux-sdk/src/stores/roomStore.test.ts`, `packages/fluux-sdk/src/stores/chatStore.test.ts`

**Interfaces:**
- Consumes: store state shapes; MDS publish rides the existing `roomMeta`/`conversationMeta` watches (pointer advance → `consider()` → debounced publish; evicted-array resolution fixed in Task 5).
- Produces (app-facing, Tasks 8/10 depend on these exact names):
  - `roomStore: markReadToNewest(roomJid: string) => void`, `markAllRoomsRead() => void`
  - `chatStore: markReadToNewest(conversationId: string) => void`
  - `useRoomActions()` returns `{ ..., markReadToNewest, markAllRoomsRead }`; `useChatActions()` returns `{ ..., markReadToNewest }`.

- [ ] **Step 1: Write failing tests**

`roomStore.test.ts`:

```typescript
describe('markReadToNewest / markAllRoomsRead', () => {
  it('advances the pointer to the newest message, zeroes counts, clears the divider', () => {
    // Seed active room with messages m1..m3, meta { lastSeenMessageId: 'm1', unreadCount: 2 },
    // firstNewMessageMarkers set for the room.
    // Act: markReadToNewest(roomJid).
    // Expect meta { lastSeenMessageId: 'm3', unreadCount: 0, mentionsCount: 0 },
    // firstNewMessageMarkers.has(roomJid) === false.
  })
  it('falls back to lastMessage for an evicted (non-active) room', () => {
    // Seed non-active room: runtime messages [], rooms.get(jid).lastMessage = m9.
    // Act → meta.lastSeenMessageId === 'm9', counts 0.
  })
  it('markAllRoomsRead marks every joined room with unread, skips clean and unjoined rooms', () => {
    // Three rooms: joined+unread, joined+clean, unjoined+unread → only the first changes.
  })
})
```

Mirror the first test for `chatStore.markReadToNewest`.

- [ ] **Step 2: Run, verify failures**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts -t "markReadToNewest"`
Expected: FAIL — action does not exist.

- [ ] **Step 3: Implement**

`roomStore.ts` — interface (near `markAsRead`):

```typescript
  /** Esc / mark-all-read: advance the read pointer to the newest known
   *  message, zero the counts, drop the divider. The MDS publisher picks up
   *  the pointer advance via the roomMeta watch. */
  markReadToNewest: (roomJid: string) => void
  /** Bulk vacation-recovery: markReadToNewest for every joined room with unread. */
  markAllRoomsRead: () => void
```

Implementation (near `markAsRead`'s implementation):

```typescript
  markReadToNewest: (roomJid) => {
    set((state) => {
      const existing = state.rooms.get(roomJid)
      if (!existing) return state
      const meta = state.roomMeta.get(roomJid)
      const runtime = state.roomRuntime.get(roomJid)
      const resident = runtime?.messages?.length ? runtime.messages : existing.messages
      const newest = resident[resident.length - 1] ?? existing.lastMessage
      if (!newest) return state

      const read = {
        lastSeenMessageId: newest.id,
        unreadCount: 0,
        mentionsCount: 0,
        lastReadAt: newest.timestamp,
      }
      const newMeta = new Map(state.roomMeta)
      if (meta) newMeta.set(roomJid, { ...meta, ...read })
      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...existing, ...read })
      const newMarkers = new Map(state.firstNewMessageMarkers)
      newMarkers.delete(roomJid)
      return { roomMeta: newMeta, rooms: newRooms, firstNewMessageMarkers: newMarkers }
    })
  },

  markAllRoomsRead: () => {
    for (const room of get().joinedRooms()) {
      const meta = get().roomMeta.get(room.jid)
      const unread = (meta?.unreadCount ?? room.unreadCount ?? 0) + (meta?.mentionsCount ?? room.mentionsCount ?? 0)
      if (unread > 0) get().markReadToNewest(room.jid)
    }
  },
```

(Verify the joined-rooms selector name with `grep -n "joinedRooms" packages/fluux-sdk/src/stores/roomStore.ts` — use the existing one.) `chatStore.markReadToNewest`: same shape over `conversations`/`conversationMeta`/`messages` map/`firstNewMessageMarkers`.

Hooks — `useRoomActions.ts` (follow the file's `useCallback` pattern):

```typescript
  const markReadToNewest = useCallback((roomJid: string) => {
    roomStore.getState().markReadToNewest(roomJid)
  }, [])
  const markAllRoomsRead = useCallback(() => {
    roomStore.getState().markAllRoomsRead()
  }, [])
```

and add both to the returned object. Same for `useChatActions.ts` (`markReadToNewest` only).

- [ ] **Step 4: Run tests + full SDK suite**

Run: `cd packages/fluux-sdk && npx vitest run`
Expected: PASS, no stderr.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src
git commit -m "feat(sdk): markReadToNewest and markAllRoomsRead actions"
```

---

### Task 7: MDS stanza-id as MAM `after` cursor (empty-cache catch-up)

**Files:**
- Modify: `packages/fluux-sdk/src/utils/mamCatchUpUtils.ts` (`CatchUpQuery`, `CatchUpQueryOptions`, `selectCatchUpQuery`)
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts` (1:1 `queryArchive` gains `after`; `item-not-found` fallback in both query paths; the two `selectCatchUpQuery` call sites ~948 and ~1113)
- Modify: `packages/fluux-sdk/src/core/chatSideEffects.ts` (~114), `packages/fluux-sdk/src/core/roomSideEffects.ts` (~124)
- Test: `packages/fluux-sdk/src/utils/mamCatchUpUtils.test.ts` (create if absent — check first), plus the existing MAM/side-effects test files that cover catch-up cursor selection

**Interfaces:**
- Consumes: `pendingRemoteDisplayedStanzaId` on `roomMeta`/`conversationMeta` (the raw XEP-0490 stanza-id, kept when unresolved locally).
- Produces: `CatchUpQuery` gains `after?: string`; `CatchUpQueryOptions` gains `pointerStanzaId?: string`. Priority: forward-gap → cached cursor → preview fallback → **`{ after: pointerStanzaId }`** → `{ before: '' }`. `MAMQueryOptions` gains `after?: string` (rooms already have it). On `item-not-found` for an `after`-anchored first page, the query retries once as `{ before: '' }`.

- [ ] **Step 1: Write failing tests**

In the mamCatchUpUtils test file:

```typescript
describe('selectCatchUpQuery pointerStanzaId', () => {
  it('uses the MDS stanza-id as an RSM after-cursor when nothing else is available', () => {
    expect(selectCatchUpQuery([], { pointerStanzaId: 'stanza-42' })).toEqual({ after: 'stanza-42' })
  })
  it('cached cursor still wins over the pointer', () => {
    const messages = [{ timestamp: new Date(Date.now() - 60_000) }]
    const q = selectCatchUpQuery(messages, { pointerStanzaId: 'stanza-42' })
    expect(q.start).toBeDefined()
    expect(q.after).toBeUndefined()
  })
  it('gap boundary still wins over everything', () => {
    const q = selectCatchUpQuery([], { forwardGapTimestamp: Date.now() - 1000, pointerStanzaId: 's' })
    expect(q.start).toBeDefined()
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/utils/mamCatchUpUtils.test.ts`
Expected: FAIL — `after` never returned.

- [ ] **Step 3: Implement `selectCatchUpQuery`**

```typescript
export interface CatchUpQuery { start?: string; before?: string; after?: string }
```

Add to `CatchUpQueryOptions`:

```typescript
  /** XEP-0490 stanza-id of the remote read position (pendingRemoteDisplayedStanzaId).
   *  Last-but-one resort — the MDS marker IS an archive id, so an empty-cache
   *  catch-up on a new device can forward-page `after` it instead of a
   *  `before: ''` fetch-latest that manufactures a "pointer beyond window". */
  pointerStanzaId?: string
```

In `selectCatchUpQuery`, before the final `return { before: '' }`:

```typescript
  if (pointerStanzaId) return { after: pointerStanzaId }
```

(and destructure it from `options`).

- [ ] **Step 4: Plumb `after` through the queries and call sites**

(a) `MAM.ts` `queryArchive` (1:1): add `after` to the destructured options (`const { with: withJid, max = 50, before = '', start, end, after, ... }`), treat `after` like `start` for forward-pagination (`isForwardPaginate` true when `start` or `after` present; initial `currentAfter = after`). The query builder already emits an `<after>` RSM element for the room path — reuse the same parameter (inspect `buildMAMQuery`'s signature and pass `after` for the first page). Add `after?: string` to `MAMQueryOptions` in `core/types`.

(b) `item-not-found` fallback in BOTH `queryArchive` and `queryRoomArchive`: when the FIRST page of an `after`-anchored query rejects with an IQ error whose condition is `item-not-found` (the archive purged that id), retry the whole query once with `{ before: '' }` and the same `max`, logging via the module's `logInfo`:

```typescript
      // The archive no longer holds the after-anchor (expired/purged):
      // degrade to fetch-latest (spec §5 — degrade gracefully, never error).
```

(c) All four `selectCatchUpQuery` call sites pass the pointer. At `chatSideEffects.ts` ~114 and the 1:1 MAM site (~948), add:

```typescript
      pointerStanzaId: chatStoreRef.getState().conversationMeta.get(conversationId)?.pendingRemoteDisplayedStanzaId,
```

At `roomSideEffects.ts` ~124 and the room MAM site (~1113):

```typescript
      pointerStanzaId: roomStore.getState().roomMeta.get(roomJid)?.pendingRemoteDisplayedStanzaId,
```

(Adapt to how each file already references its store — all four already read meta nearby for `fallbackNewestTimestamp`.) Then thread `q.after` into the actual query invocation next to the existing `q.start`/`q.before` usage (each site builds query options from `q` — extend the object it builds).

- [ ] **Step 5: Run tests**

Run: `cd packages/fluux-sdk && npx vitest run src/utils/mamCatchUpUtils.test.ts src/core/modules/Chat.mam.test.ts && npx vitest run`
Expected: PASS, no stderr (full SDK suite).

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src
git commit -m "feat(sdk): use the XEP-0490 stanza-id as MAM after-cursor for empty-cache catch-up"
```

---

### Task 8: SDK build checkpoint + Esc marks read

**Files:**
- Modify: `apps/fluux/src/hooks/useKeyboardShortcuts.ts` (Escape priority chain)
- Modify: `apps/fluux/src/components/ChatLayout.tsx` (provide the escape callback)
- Modify: `apps/fluux/src/i18n/locales/*.json` (33 files) + `apps/fluux/src/test-setup.ts` (only if a component test asserts the key)
- Test: `apps/fluux/src/hooks/useKeyboardShortcuts.test.ts` (or the file's existing test neighbor — check what exists)

**Interfaces:**
- Consumes: `useRoomActions().markReadToNewest/markAllRoomsRead`, `useChatActions().markReadToNewest` (Task 6); the existing ⌘/Ctrl+↓ scroll-to-bottom action inside `useKeyboardShortcuts`; existing Escape priority chain (modals → console → contact profile).
- Produces: Escape, when nothing higher-priority consumes it, marks the ACTIVE conversation/room read and jumps to the bottom (spec §3 step 3). Composer-level Escape (reply/edit cancel) must keep winning.

- [ ] **Step 1: Rebuild SDK and verify the app sees the new API**

Run: `npm run build:sdk && npm run typecheck`
Expected: clean. If the app cannot resolve the new hooks, re-check the worktree symlink (`ls -la apps/fluux/node_modules/@fluux/sdk`) per Global Constraints.

Check the app's SDK mock: `grep -n "markReadToNewest\|importOriginal" apps/fluux/src/test-setup.ts` — if the mock enumerates hook returns rather than spreading `importOriginal`, add `markReadToNewest`/`markAllRoomsRead` stubs (`vi.fn()`).

- [ ] **Step 2: Write failing test**

Follow the existing test around `useKeyboardShortcuts` (or ChatLayout keyboard tests — find with `grep -rn "Escape" apps/fluux/src --include="*.test.*" -l`). New case:

```typescript
it('Escape with no overlay open marks the active entity read and scrolls to bottom', () => {
  // Mount the hook/harness with an active room and no modal state.
  // Dispatch: new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }).
  // Assert the markReadToNewest mock was called with the active jid and the
  // scroll-to-bottom action ran (same assertion style as the ⌘↓ shortcut test).
})
it('Escape is ignored when a composer already consumed it (defaultPrevented)', () => {
  // Dispatch an Escape event with defaultPrevented (dispatch on a child that
  // preventDefaults, or monkeypatch) → markReadToNewest NOT called.
})
```

Run it; expected: FAIL.

- [ ] **Step 3: Implement**

(a) In `useKeyboardShortcuts.ts`, first make the keydown listener skip consumed events if it does not already:

```typescript
      if (e.defaultPrevented) return
```

(b) Extend the hook's options with an optional callback, wired as the LOWEST priority in `handleEscape` (after the contact-profile check):

```typescript
  // 7. Conversation catch-up (spec §3): nothing above consumed Escape —
  // mark the active chat/room read and jump to the present.
  if (esc?.onConversationEscape?.()) return true
```

(c) In `ChatLayout.tsx`: first read how the component knows which view is displayed and how the ⌘/Ctrl+↓ shortcut reaches the message list (`grep -n "scrollToBottom\|activeRoom\|activeConversation" apps/fluux/src/components/ChatLayout.tsx`). ChatLayout renders ChatView/RoomView from its own view state — reuse those exact variables. Then add, next to where the existing `esc` config object is built:

```typescript
  const { markReadToNewest: markRoomRead } = useRoomActions()
  const { markReadToNewest: markChatRead } = useChatActions()

  // Spec §3 step 3: Escape with nothing else open = mark read + jump to present.
  const onConversationEscape = useCallback((): boolean => {
    if (activeRoomJid) {
      markRoomRead(activeRoomJid)
    } else if (activeConversationId) {
      markChatRead(activeConversationId)
    } else {
      return false // no conversation displayed — let Escape fall through
    }
    scrollActiveListToBottom() // the SAME action the ⌘/Ctrl+↓ shortcut invokes
    return true // even when already read/at bottom: a no-op Esc must not
                // bubble into surprise behavior
  }, [activeRoomJid, activeConversationId, markRoomRead, markChatRead])
```

where `activeRoomJid` / `activeConversationId` / `scrollActiveListToBottom` are the names ChatLayout ALREADY uses for those three things (substitute the real identifiers found in the grep — do not introduce parallel state). Pass `onConversationEscape` into the `esc` options object consumed by `useKeyboardShortcuts`.

- [ ] **Step 4: Run tests**

Run: `cd apps/fluux && npx vitest run src/hooks && npm run typecheck` (root)
Expected: PASS. Manually verify composer precedence reasoning: composer's Escape handler calls `e.preventDefault()` (it does — reply-cancel), and step (a) makes the global handler respect it.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src packages/fluux-sdk
git commit -m "feat(app): Escape marks the active conversation read (#851)"
```

---

### Task 9: Jump-to-last-read pill

**Files:**
- Create: `apps/fluux/src/components/conversation/JumpToLastReadPill.tsx`
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx` (mount pill; visibility from marker position vs viewport)
- Modify: `apps/fluux/src/i18n/locales/*.json` (33 files), `apps/fluux/src/test-setup.ts`
- Test: `apps/fluux/src/components/conversation/JumpToLastReadPill.test.tsx`

**Interfaces:**
- Consumes: `firstNewMessageId` prop (already on `MessageListProps`); the existing `markerUnreadCount` memo in MessageList (`deduplicatedMessages.length - markerIdx`); the existing marker-scroll routine (the `stepToMarker` re-assert loop) — extract its trigger into a reusable `scrollToMarker()` callback; `FloatingDateHeader` for pill styling/positioning conventions (`absolute top-3 inset-x-0 z-30 flex justify-center`, `data-*` attribute, `bg-fluux-float border border-fluux-border` pill classes).
- Produces: a pill shown while a divider exists ABOVE the viewport: label `t('chat.newMessagesCount', { count })` when the count is known (> 0), else `t('chat.youWereAway')`; click → scroll to the divider. Hidden when the divider is visible or below the viewport, and after Esc (divider gone). `data-jump-to-last-read` test id.

- [ ] **Step 1: i18n keys**

Add to `en.json` `chat` namespace (respect 4-space format; then translate into the other 32 locales via the parse→mutate→stringify workflow — real translations, no em-dashes):

```json
"newMessagesCount": "{{count}} new message",
"newMessagesCount_other": "{{count}} new messages",
"youWereAway": "You were away",
"jumpToLastRead": "Jump to last read"
```

Add the same three keys to the `chat` block in `test-setup.ts`'s i18n resources.

- [ ] **Step 2: Write failing component test**

`JumpToLastReadPill.test.tsx` (jsdom pinned if it snapshots DOM per repo convention — check a neighbor component test's header):

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { JumpToLastReadPill } from './JumpToLastReadPill'

describe('JumpToLastReadPill', () => {
  it('renders the count and jumps on click', () => {
    const onJump = vi.fn()
    render(<JumpToLastReadPill visible count={12} onJump={onJump} />)
    const pill = screen.getByRole('button', { name: /12 new messages/i })
    fireEvent.click(pill)
    expect(onJump).toHaveBeenCalled()
  })
  it('degrades to "You were away" when the count is unknown', () => {
    render(<JumpToLastReadPill visible count={0} onJump={() => {}} />)
    expect(screen.getByText('You were away')).toBeInTheDocument()
  })
  it('renders nothing when not visible', () => {
    const { container } = render(<JumpToLastReadPill visible={false} count={3} onJump={() => {}} />)
    expect(container.querySelector('[data-jump-to-last-read]')).toBeNull()
  })
})
```

Run: `cd apps/fluux && npx vitest run src/components/conversation/JumpToLastReadPill.test.tsx` → FAIL (missing component).

- [ ] **Step 3: Implement the component**

```tsx
import { useTranslation } from 'react-i18next'

interface JumpToLastReadPillProps {
  visible: boolean
  /** Messages after the divider when known; 0 = unknown (deep/degraded). */
  count: number
  onJump: () => void
}

/**
 * Secondary catch-up affordance (spec §2): shown while the "New messages"
 * divider sits above the viewport, so the reading position stays one click
 * away after a jump-to-present. Styling mirrors FloatingDateHeader's pill.
 */
export function JumpToLastReadPill({ visible, count, onJump }: JumpToLastReadPillProps) {
  const { t } = useTranslation()
  if (!visible) return null
  return (
    <div data-jump-to-last-read className="absolute top-3 inset-x-0 z-30 flex justify-center pointer-events-none">
      <button
        type="button"
        onClick={onJump}
        title={t('chat.jumpToLastRead')}
        className="pointer-events-auto px-3 py-1 rounded-full text-xs bg-fluux-float border border-fluux-border shadow-sm hover:bg-fluux-hover"
      >
        {count > 0 ? t('chat.newMessagesCount', { count }) : t('chat.youWereAway')}
      </button>
    </div>
  )
}
```

(Match class tokens against `FloatingDateHeader.tsx` — reuse its exact palette/utility classes rather than inventing new ones.)

- [ ] **Step 4: Mount in MessageList**

In `MessageList.tsx`:
- Extract the existing marker-entry scroll trigger into a `scrollToMarker` callback reusable by the pill (the entry effect and the pill click must run the SAME re-assert loop — do not duplicate it; lift the `stepToMarker` launcher into a function both call). This is scroll-machinery surgery: keep the diff minimal.
- Visibility: `markerAboveViewport` — virtualized path: marker's item index < first visible virtual item index; non-virtualized: marker element's `offsetTop < scroller.scrollTop`. Recompute on the same scroll/RAF cadence FloatingDateHeader uses (or derive in the existing scroll handler where `showScrollToBottom` is computed — preferred, no new listener).
- Render next to the FAB block: `<JumpToLastReadPill visible={!!firstNewMessageId && markerAboveViewport} count={markerUnreadCount} onJump={scrollToMarker} />`.

- [ ] **Step 5: Verify (scroll gate)**

Run: `cd apps/fluux && npx vitest run src/components/conversation && cd ../.. && npm run typecheck && npm run test:scroll`
Expected: component tests PASS; scroll invariants PASS (no regressions from the extraction).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src
git commit -m "feat(app): jump-to-last-read pill above the message list"
```

---

### Task 10: Mark-all-read menu + final verification

**Files:**
- Modify: `apps/fluux/src/components/sidebar-components/RoomsHeaderActions.tsx` (+ its parent that supplies handlers — follow `onCatchUpAll` upward)
- Modify: `apps/fluux/src/i18n/locales/*.json` (33 files), `apps/fluux/src/test-setup.ts`
- Test: `apps/fluux/src/components/sidebar-components/RoomsHeaderActions.test.tsx` (or the existing test covering the menu — check first)
- Modify: `docs/superpowers/specs/2026-07-06-muc-catchup-read-state-design.md` (one accuracy amendment, below)

**Interfaces:**
- Consumes: `useRoomActions().markAllRoomsRead` (Task 6); `OverflowMenuItem` shape (`{ key, label, icon, onClick, disabled?, dividerBefore? }`).
- Produces: a "Mark all as read" item in the rooms header kebab menu.

- [ ] **Step 1: i18n key**

`rooms.markAllRead`: `"Mark all as read"` in `en.json` + 32 translations (same workflow as Task 9) + `test-setup.ts` rooms block.

- [ ] **Step 2: Failing test**

In the menu's test file (create alongside if none):

```tsx
it('offers Mark all as read and calls the action', () => {
  const onMarkAllRead = vi.fn()
  render(<RoomsHeaderActions onQuickChat={vi.fn()} onPermanentRoom={vi.fn()} onJoinRoom={vi.fn()}
    onBrowseRooms={vi.fn()} onCatchUpAll={vi.fn()} isCatchingUp={false} onMarkAllRead={onMarkAllRead} />)
  fireEvent.click(screen.getByRole('button'))               // open kebab
  fireEvent.click(screen.getByText('Mark all as read'))
  expect(onMarkAllRead).toHaveBeenCalled()
})
```

Run → FAIL (prop/item missing).

- [ ] **Step 3: Implement**

Add `onMarkAllRead: () => void` to `RoomsHeaderActionsProps` and, in the `items` array after the `catchup` entry:

```tsx
    { key: 'markAllRead', label: t('rooms.markAllRead'), icon: CheckCheck, onClick: onMarkAllRead },
```

(`CheckCheck` from `lucide-react`.) In the parent that renders `RoomsHeaderActions` (follow `onCatchUpAll`), supply `onMarkAllRead={markAllRoomsRead}` from `useRoomActions()`.

- [ ] **Step 4: Spec accuracy amendment**

In the spec's Section 2 "First activation vs revisit" bullet, replace the sentence about revisits restoring "bottom if the user left at the bottom" with the actual (better) shipped behavior:

```markdown
- **First activation vs revisit:** entry scroll priority is (1) restore the
  saved position when the user had scrolled up, (2) anchor at the divider
  when one exists, (3) bottom. A revisit that left at the bottom and gained
  new unread therefore re-anchors at the fresh divider — same as first open.
```

- [ ] **Step 5: Full verification suite**

Run, in order, and fix anything that fails before committing:

```bash
npm run build:sdk
npm run typecheck
cd packages/fluux-sdk && npx vitest run && cd ../..
cd apps/fluux && npx vitest run && cd ../..
npm run test:scroll
npm run lint --workspaces --if-present
```

Then a manual demo sanity pass: `npm run dev` → `http://localhost:5173/demo.html?tutorial=false` → demo rooms must show NO unread badges or dividers (fresh-join guard — demo seeds have no read state), chats behave as before, Esc in a conversation is a no-op when caught up.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src docs/superpowers/specs
git commit -m "feat(app): mark all rooms as read menu action"
```

---

## Deferred (explicitly out of this plan)

- New Playwright scroll-invariant cases for divider-anchored entry (the existing marker-entry branch is already covered by the current suite; add cases only if Task 9's extraction destabilizes it).
- MAM-around network fetch DURING activation for pointers beyond the local cache (spec §5 degrade covers it; the forward catch-up + Task 7 cursor keep the cache primed).
- Per-room catch-up preferences, mark-all-read keyboard shortcut (spec: out of scope).
