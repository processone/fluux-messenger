# MDS Retract-on-Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user truly deletes a conversation (1:1) or removes a room (forget), best-effort retract its XEP-0490 read marker from the MDS PEP node, so the node stays tidy and orphan markers don't accumulate (notably from churny rooms / gateway JIDs).

**Architecture:** A guarded SDK side-effect (folded into `mdsSideEffects.ts`) tracks the set of live conversation/room JIDs and, while a session is online and synced, retracts the MDS marker for any JID that leaves the set. It reuses the existing `syncEnabled` arm so it never fires during seed/rehydration, and a wholesale-clear guard so logout/reset never retracts. Retraction also evicts the JID from the publisher's in-memory maps so a delete-then-recreate republishes cleanly.

**Tech Stack:** TypeScript, `@xmpp/client`, Zustand vanilla stores, Vitest. Ships on branch `mr/elated-panini-81a58f` (PR #598), on top of the merged 1:1 + MUC read-sync work.

## Global Constraints

- **NEVER retract on logout / reset / disconnect.** Retraction fires ONLY for a JID that leaves the tracked set while `syncEnabled === true` AND `connectionStore.status === 'online'` AND it is not a wholesale clear (the new tracked set is non-empty). A reset/logout clears the whole set at once and must be treated as a teardown (update baseline, retract nothing).
- **Track the right keys:** the live set is `chatStore.conversationEntities.keys()` ∪ `roomStore.rooms.keys()`. This gives correct semantics for free: **archiving keeps the entity** (no retract), and **removing a bookmark for a room you're still joined to keeps it in `rooms`** (no retract). Only `deleteConversation`, `removeRoom`, and `removeBookmark`-while-not-joined drop the key.
- **Best-effort:** `retractDisplayed` tolerates an absent item (the server may 404); never throw into the side effect. localStorage/grow-only semantics mean a still-active conversation on another device simply republishes — no data loss.
- **Evict on retract:** remove the JID from `lastKnownNodeStanzaId`, `lastConsideredSeenId`, `unroutedSeedMarkers`, and the `dirty` coalescer, so a pending publish can't re-create the just-retracted marker and a recreated conversation publishes fresh.
- **No new persistence; no app changes.** Pure SDK side-effect.
- **Worktree build order:** after SDK source changes run `npm run build:sdk` AND `rsync -a --delete packages/fluux-sdk/dist/ /Users/mremond/AIProjects/fluux-messenger/packages/fluux-sdk/dist/`, then `npm run typecheck` from repo root.
- **Run SDK tests per-workspace.** Commit message must NOT contain a Claude footer. One commit per task.

---

## File Structure

- Modify `packages/fluux-sdk/src/core/modules/Mds.ts` (+ `Mds.test.ts`) — add `retractDisplayed`.
- Modify `packages/fluux-sdk/src/utils/keyedCoalescer.ts` (+ `keyedCoalescer.test.ts`) — add `delete(key)`.
- Modify `packages/fluux-sdk/src/core/mdsSideEffects.ts` (+ `mdsSideEffects.test.ts`) — guarded retraction.
- Modify `CHANGELOG.md` — one line under `[Unreleased] → Changed`.

---

## Task 1: `Mds.retractDisplayed(conversationJid)`

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Mds.ts`
- Test: `packages/fluux-sdk/src/core/modules/Mds.test.ts`

**Interfaces:**
- Consumes: `ModuleDependencies` (`sendIQ`, `getCurrentJid`), `NS_PUBSUB`, `NS_MDS`, `generateUUID`.
- Produces: `Mds.retractDisplayed(conversationJid: string): Promise<void>` — sends a pubsub retract IQ removing the `<item id=conversationJid>` from the MDS node. Best-effort: swallows errors (absent item / no node).

- [ ] **Step 1: Write the failing test**

Add to `packages/fluux-sdk/src/core/modules/Mds.test.ts`:

```typescript
describe('Mds.retractDisplayed', () => {
  it('sends a pubsub retract for the conversation item on the MDS node', async () => {
    const sendIQ = vi.fn().mockResolvedValue(xml('iq', { type: 'result' }))
    const mds = new Mds(makeDeps(sendIQ)) // reuse the makeDeps helper in this file

    await mds.retractDisplayed('juliet@capulet.example')

    const iq = sendIQ.mock.calls[0][0]
    expect(iq.attrs.type).toBe('set')
    const retract = iq.getChild('pubsub', NS_PUBSUB)?.getChild('retract')
    expect(retract?.attrs.node).toBe(NS_MDS)
    expect(retract?.getChild('item')?.attrs.id).toBe('juliet@capulet.example')
  })

  it('swallows errors (absent item / no node) — best effort', async () => {
    const sendIQ = vi.fn().mockRejectedValue(new Error('item-not-found'))
    const mds = new Mds(makeDeps(sendIQ))
    await expect(mds.retractDisplayed('x@example')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Mds.test.ts`
Expected: FAIL — `retractDisplayed` is not a function.

- [ ] **Step 3: Implement**

In `packages/fluux-sdk/src/core/modules/Mds.ts`, add the method to the `Mds` class (mirror `publishDisplayed`'s IQ-building style; the `<retract>` lives under `<pubsub xmlns=NS_PUBSUB>`):

```typescript
  /**
   * Best-effort retract of a conversation's displayed marker (e.g. on delete).
   * Tolerates an absent item or missing node — the goal is node hygiene, not
   * correctness, and a still-active conversation on another device will simply
   * republish its marker.
   */
  async retractDisplayed(conversationJid: string): Promise<void> {
    if (!this.deps.getCurrentJid()) return

    const iq = xml('iq', { type: 'set', id: `mds_retract_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('retract', { node: NS_MDS },
          xml('item', { id: conversationJid }),
        ),
      ),
    )

    try {
      await this.deps.sendIQ(iq)
    } catch {
      // Best-effort: item may not exist, or the node may be absent.
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Mds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Mds.ts packages/fluux-sdk/src/core/modules/Mds.test.ts
git commit -m "feat(mds): add Mds.retractDisplayed for best-effort marker retraction"
```

---

## Task 2: `KeyedCoalescer.delete(key)`

**Files:**
- Modify: `packages/fluux-sdk/src/utils/keyedCoalescer.ts`
- Test: `packages/fluux-sdk/src/utils/keyedCoalescer.test.ts`

**Interfaces:**
- Produces: `KeyedCoalescer.delete(key: K): boolean` — removes any buffered value for `key` (so a retracted JID can't be published by a pending flush). Returns true if an entry was removed.

- [ ] **Step 1: Write the failing test**

Add to `packages/fluux-sdk/src/utils/keyedCoalescer.test.ts`:

```typescript
it('delete(key) drops a buffered entry so it is not flushed', () => {
  const c = createKeyedCoalescer<string, number>()
  c.open()
  c.add('a', 1)
  c.add('b', 2)
  expect(c.delete('a')).toBe(true)
  expect(c.delete('missing')).toBe(false)
  expect(c.size()).toBe(1)
  expect(c.flush()).toEqual([{ key: 'b', value: 2 }])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/utils/keyedCoalescer.test.ts`
Expected: FAIL — `c.delete is not a function`.

- [ ] **Step 3: Implement**

In `packages/fluux-sdk/src/utils/keyedCoalescer.ts`, add to the `KeyedCoalescer<K, V>` interface:

```typescript
  /** Drop any buffered value for key. Returns true if an entry was removed. */
  delete(key: K): boolean
```

And to the returned object in `createKeyedCoalescer`:

```typescript
    delete: (key) => buffer.delete(key),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/utils/keyedCoalescer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/utils/keyedCoalescer.ts packages/fluux-sdk/src/utils/keyedCoalescer.test.ts
git commit -m "feat(mds): add KeyedCoalescer.delete to drop a buffered key"
```

---

## Task 3: Guarded retraction side-effect in `mdsSideEffects`

**Files:**
- Modify: `packages/fluux-sdk/src/core/mdsSideEffects.ts`
- Test: `packages/fluux-sdk/src/core/mdsSideEffects.test.ts`

**Interfaces:**
- Consumes: `client.mds.retractDisplayed` (Task 1), `dirty.delete` (Task 2), `chatStore.conversationEntities`, `roomStore.rooms`, `connectionStore.status`, the existing `syncEnabled` flag and the `lastKnownNodeStanzaId` / `lastConsideredSeenId` / `unroutedSeedMarkers` maps in the closure.
- Produces: retraction wired into `setupMdsSideEffects`; new subscriptions cleaned up on teardown.

- [ ] **Step 1: Write the failing tests**

Add to `packages/fluux-sdk/src/core/mdsSideEffects.test.ts` (reuse the file's `makeClient` fake + fake timers; the fake `client.mds` must gain `retractDisplayed: vi.fn().mockResolvedValue(undefined)`). Seed a conversation via the chat seeding idiom used elsewhere in this file / `chatStore.mds.test.ts`. Required cases:

```typescript
it('retracts the MDS marker when a conversation is deleted while online+synced', async () => {
  const cid = 'juliet@capulet.example'
  const client = makeClient()
  connectionStore.setState({ status: 'online' } as never)
  const cleanup = setupMdsSideEffects(client as never)
  client._emit('online')
  await vi.runOnlyPendingTimersAsync() // seed completes → syncEnabled true, baseline built

  // a conversation exists (in conversationEntities), then is deleted
  chatStore.getState().addConversation?.({ id: cid, name: cid, type: 'chat' }) // use the real add idiom
  await vi.advanceTimersByTimeAsync(0)
  chatStore.getState().deleteConversation(cid)
  await vi.advanceTimersByTimeAsync(0)

  expect(client.mds.retractDisplayed).toHaveBeenCalledWith(cid)
  cleanup()
})

it('does NOT retract on a wholesale clear (logout/reset)', async () => {
  const client = makeClient()
  connectionStore.setState({ status: 'online' } as never)
  const cleanup = setupMdsSideEffects(client as never)
  client._emit('online')
  await vi.runOnlyPendingTimersAsync()

  chatStore.getState().addConversation?.({ id: 'a@x', name: 'a', type: 'chat' })
  chatStore.getState().addConversation?.({ id: 'b@x', name: 'b', type: 'chat' })
  await vi.advanceTimersByTimeAsync(0)

  chatStore.getState().reset() // mass clear
  await vi.advanceTimersByTimeAsync(0)

  expect(client.mds.retractDisplayed).not.toHaveBeenCalled()
  cleanup()
})

it('does NOT retract while offline or before sync is enabled', async () => {
  const cid = 'c@x'
  const client = makeClient()
  connectionStore.setState({ status: 'connecting' } as never) // not online
  const cleanup = setupMdsSideEffects(client as never)

  chatStore.getState().addConversation?.({ id: cid, name: 'c', type: 'chat' })
  await vi.advanceTimersByTimeAsync(0)
  chatStore.getState().deleteConversation(cid)
  await vi.advanceTimersByTimeAsync(0)

  expect(client.mds.retractDisplayed).not.toHaveBeenCalled()
  cleanup()
})
```

> Use the REAL chat add/seed idiom (read `chatStore.test.ts` / `chatStore.mds.test.ts`): if there's no `addConversation`, inject entities via `chatStore.setState` directly (a `conversationEntities` Map write). `deleteConversation` and `reset` are real store actions. Replace `addConversation?.(...)` accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/mdsSideEffects.test.ts`
Expected: FAIL — no retraction wired.

- [ ] **Step 3: Implement**

In `packages/fluux-sdk/src/core/mdsSideEffects.ts`:

Add a tracked-set baseline near the other closure state:

```typescript
  // Live conversation/room JIDs, to detect user deletes (retraction). Maintained
  // while disarmed; the removed delta is retracted only while armed (syncEnabled).
  let trackedJids = new Set<string>()
```

Add helpers (place near `consider`):

```typescript
  /** Current live set: 1:1 conversation entities ∪ known rooms. */
  function liveJids(): Set<string> {
    const s = new Set<string>()
    for (const jid of chatStore.getState().conversationEntities.keys()) s.add(jid)
    for (const jid of roomStore.getState().rooms.keys()) s.add(jid)
    return s
  }

  /** Forget a JID's in-memory publisher state so a retract/recreate is clean. */
  function evictJid(jid: string): void {
    lastKnownNodeStanzaId.delete(jid)
    lastConsideredSeenId.delete(jid)
    unroutedSeedMarkers.delete(jid)
    dirty.delete(jid)
  }

  /**
   * Detect user deletes and retract their MDS markers. Armed only while online
   * and synced; a wholesale clear (logout/reset) is treated as teardown and
   * retracts nothing.
   */
  function reconcileDeletions(): void {
    const current = liveJids()

    if (!syncEnabled || connectionStore.getState().status !== 'online') {
      trackedJids = current // keep baseline synced while disarmed; never retract
      return
    }
    // Wholesale clear (logout/reset/account switch): never mass-retract.
    if (current.size === 0 && trackedJids.size > 0) {
      trackedJids = current
      return
    }
    for (const jid of trackedJids) {
      if (!current.has(jid)) {
        evictJid(jid)
        void client.mds.retractDisplayed(jid) // best-effort
      }
    }
    trackedJids = current
  }
```

Add two subscriptions (alongside the existing ones):

```typescript
  const unsubscribeChatEntities = chatStore.subscribe(
    (state) => state.conversationEntities,
    () => reconcileDeletions()
  )
  const unsubscribeRoomEntities = roomStore.subscribe(
    (state) => state.rooms,
    () => reconcileDeletions()
  )
```

Rebuild the baseline when sync is (re)enabled so the initial population is never seen as deletions. In the `online` handler, AFTER `syncEnabled = true`, add:

```typescript
      trackedJids = liveJids()
```

In the `resumed` handler, after `syncEnabled = true`, add the same `trackedJids = liveJids()`.

In the disconnect handler (status leaves 'online'), after `syncEnabled = false`, add:

```typescript
        trackedJids = new Set()
```

Add the two new unsubscribes to the cleanup return.

> NOTE: `roomStore.rooms` already has a subscription (the seed-drain). Keep it separate — this is a second, distinct subscription with its own concern. Both firing on a `rooms` change is fine.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/mdsSideEffects.test.ts`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Regression + typecheck**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.test.ts src/stores/roomStore.test.ts && npx tsc --noEmit`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/mdsSideEffects.ts packages/fluux-sdk/src/core/mdsSideEffects.test.ts
git commit -m "feat(mds): retract read marker when a conversation is deleted"
```

---

## Task 4: Docs + full-suite verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: CHANGELOG**

Under the existing `## [Unreleased]`, add a `### Changed` entry (create the subsection if absent), no em-dashes:

```
- Read-position sync (XEP-0490): deleting a conversation now also clears its synced read marker, so the position does not linger on your other devices
```

- [ ] **Step 2: SDK suite + rebuild/sync dist + app suite + typecheck + lint**

Run:
```bash
cd packages/fluux-sdk && npx vitest run
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/elated-panini-81a58f && npm run build:sdk
rsync -a --delete packages/fluux-sdk/dist/ /Users/mremond/AIProjects/fluux-messenger/packages/fluux-sdk/dist/
cd apps/fluux && npx vitest run
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/elated-panini-81a58f && npm run typecheck && npm run lint
```
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(mds): note read-marker retraction on conversation delete"
```

---

## Self-Review

**Spec coverage:** retract method (T1) ✅; coalescer evict support (T2) ✅; guarded side-effect with online+synced arm, wholesale-clear guard, evict, baseline rebuild (T3) ✅; docs (T4) ✅. Archive/still-joined-room correctly excluded because the entity/room key stays — covered by tracking `conversationEntities`/`rooms` keys, asserted implicitly (delete removes the key; archive does not).

**Placeholder scan:** the chat add/seed idiom (`addConversation?.` / `setState`) and the room seeding are flagged "use the real idiom from the test files" — read-from-actual-code instructions, the established convention.

**Type consistency:** `retractDisplayed(jid)` consistent T1↔T3. `delete(key)` consistent T2↔T3 (`dirty.delete(jid)`). `trackedJids`/`liveJids`/`reconcileDeletions`/`evictJid` self-consistent within T3.
