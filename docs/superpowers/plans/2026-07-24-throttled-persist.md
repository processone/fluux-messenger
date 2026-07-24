# Throttled localStorage Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop serializing the whole chat/room store to localStorage on every store mutation, without losing any durable read-state, gap, coverage or retraction data.

**Architecture:** A per-key leading+trailing throttle module (`stores/shared/throttledStorage.ts`) sits between the stores and `localStorage`. It takes a lazy thunk so coalesced writes skip serialization entirely. `chatStore`'s zustand persist adapter and `roomStore`'s five save helpers plus `saveRoomReadState` route through it. Pending retractions are excluded from coalescing via `flushKey`, because they record a durable event rather than a lagging mirror.

**Deferred to its own cycle:** spec §2 item 5 (dropping the duplicated `conversations` compat map from the persisted blob) is *not* in this plan. It is independent of the throttle — the throttle cuts the write *count* 180→~20, which is the stall; the compat removal only halves each remaining write's *size* — and it is the half carrying a silent-data-loss failure mode, since `deserializeState`'s rebuild drops any conversation whose entity/meta went stale. Proving that safe needs all 22 `conversations` write paths covered, which is a larger piece of work than a test tweak.

**Decided for that PR:** centralize the 22 replacements behind one helper that guarantees the entity/meta write, then test the helper plus its exceptions — rather than a 22-case matrix alone. The guarantee becomes structural, so a future write site cannot quietly opt out of it.

**Tech Stack:** TypeScript, zustand 5 (`persist` middleware with a custom `storage` adapter), vitest with fake timers, `localStorageMock` from `core/sideEffects.testHelpers`.

**Spec:** [docs/superpowers/specs/2026-07-24-throttled-persist-design.md](../specs/2026-07-24-throttled-persist-design.md)

## Global Constraints

- Throttle window is exactly **1000 ms**. Do not reuse `PERSIST_DEBOUNCE_MS = 500` from `stateSnapshot.ts` — that is a different mechanism.
- Every write path (leading edge, timer callback, `flush`, `flushKey`) must **absorb** errors from both `produce()` and `localStorage.setItem`. Every call site being replaced already swallows storage errors; that behaviour must not regress.
- A throwing `produce` must not leave a timer armed or a window half-open.
- Storage keys are resolved **eagerly, at schedule time** — never inside a thunk. Resolving inside the thunk would write one account's data under another account's key.
- The SDK's public export name is **`flushPersistentStorage`**, not `flush`.
- No test may assert something that passes with the feature removed. Where a test targets an escape hatch, it must first put the system — **on the exact key under test** — into the state where the ordinary path would not have persisted.
- Tests count writes via `localStorageMock.setItem.mock.calls.length`. Do not add a dependency-injected sink; the production write path must be the one under test.
- Never include a Claude footer in commit messages.
- Commits are SSH-signed. If signing fails, use `--no-gpg-sign` (pre-approved for this repo).

---

## File Structure

**Created:**
- `packages/fluux-sdk/src/stores/shared/throttledStorage.ts` — the throttle. No knowledge of chat or rooms.
- `packages/fluux-sdk/src/stores/shared/throttledStorage.test.ts`
- `packages/fluux-sdk/src/stores/chatStore.persist.test.ts`
- `packages/fluux-sdk/src/stores/roomStore.throttledPersist.test.ts`

**Modified:**
- `packages/fluux-sdk/src/stores/chatStore.ts` — adapter, `switchAccount`, `recordPendingRetraction`
- `packages/fluux-sdk/src/stores/chatStore.test.ts` + `roomStore.test.ts` + `shared/readStateStorage.test.ts` — adapted to the new timing contract
- `packages/fluux-sdk/src/stores/roomStore.ts` — 5 save helpers, `persistRoomReadState`, `switchAccount`, `reset`, one doc comment
- `packages/fluux-sdk/src/stores/shared/readStateStorage.ts` — `saveRoomReadState`, `clearRoomReadState`, `_clearAllRoomReadStateForTesting`
- `packages/fluux-sdk/src/index.ts` — export `flushPersistentStorage`
- `packages/fluux-sdk/package.json` — zustand peer range
- `apps/fluux/src/hooks/useTauriCloseHandler.ts` + `.test.tsx`

---

## Task 1: The throttle module

**Files:**
- Create: `packages/fluux-sdk/src/stores/shared/throttledStorage.ts`
- Test: `packages/fluux-sdk/src/stores/shared/throttledStorage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `schedule(key: string, produce: () => string): void`, `flushKey(key: string): void`, `cancel(key: string): void`, `flush(): void`, `_resetForTesting(): void`. All exported from `stores/shared/throttledStorage`.

- [ ] **Step 1: Write the failing tests**

Create `packages/fluux-sdk/src/stores/shared/throttledStorage.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { localStorageMock } from '../../core/sideEffects.testHelpers'
import { schedule, flushKey, cancel, flush, _resetForTesting } from './throttledStorage'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

const KEY = 'test-key'
const OTHER = 'other-key'

function writeCount(): number {
  return localStorageMock.setItem.mock.calls.length
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  localStorageMock.setItem.mockClear()
  _resetForTesting()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('throttledStorage', () => {
  it('writes immediately on the leading edge', () => {
    schedule(KEY, () => 'a')
    expect(localStorage.getItem(KEY)).toBe('a')
    expect(writeCount()).toBe(1)
  })

  it('coalesces N schedules in one window into 2 writes', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    schedule(KEY, () => 'c')
    schedule(KEY, () => 'd')
    expect(writeCount()).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(writeCount()).toBe(2)
    expect(localStorage.getItem(KEY)).toBe('d')
  })

  // The control that kills a leading-edge-only implementation: it passes the
  // write-count assertions above and fails this one.
  it('flush writes the LATEST pending value, not the first', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    flush()
    expect(localStorage.getItem(KEY)).toBe('b')
  })

  it('does not invoke produce for coalesced writes', () => {
    const produce = vi.fn(() => 'x')
    schedule(KEY, () => 'first')
    schedule(KEY, produce)
    schedule(KEY, () => 'last')
    expect(produce).not.toHaveBeenCalled()
  })

  it('keeps writing during a sustained burst, ~1 per window', () => {
    schedule(KEY, () => 'v0')
    for (let i = 1; i <= 5; i++) {
      schedule(KEY, () => `v${i}`)
      vi.advanceTimersByTime(1000)
    }
    // 1 leading + 5 trailing
    expect(writeCount()).toBe(6)
    expect(localStorage.getItem(KEY)).toBe('v5')
  })

  it('cancel drops the pending write', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    cancel(KEY)
    vi.advanceTimersByTime(5000)
    expect(localStorage.getItem(KEY)).toBe('a')
    expect(writeCount()).toBe(1)
  })

  it('flushKey writes the pending thunk for one key only', () => {
    schedule(KEY, () => 'a')
    schedule(OTHER, () => 'x')
    schedule(KEY, () => 'b')
    schedule(OTHER, () => 'y')
    flushKey(KEY)
    expect(localStorage.getItem(KEY)).toBe('b')
    expect(localStorage.getItem(OTHER)).toBe('x')
  })

  it('flushKey with nothing pending performs zero writes', () => {
    schedule(KEY, () => 'a')
    localStorageMock.setItem.mockClear()
    flushKey(KEY)
    expect(writeCount()).toBe(0)
  })

  it('closes the window, so the next schedule writes immediately', () => {
    schedule(KEY, () => 'a')
    flushKey(KEY)
    schedule(KEY, () => 'b')
    expect(localStorage.getItem(KEY)).toBe('b')
  })

  it('pagehide flushes pending writes', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    window.dispatchEvent(new Event('pagehide'))
    expect(localStorage.getItem(KEY)).toBe('b')
  })

  it('a failed leading write leaves no window and no timer', () => {
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    expect(() => schedule(KEY, () => 'a')).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)

    // The next save must write immediately, not be coalesced behind a window
    // that is guarding a write which never landed.
    schedule(KEY, () => 'b')
    expect(localStorage.getItem(KEY)).toBe('b')
  })

  it('a failed trailing write closes the window instead of rearming', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)

    schedule(KEY, () => 'c')
    expect(localStorage.getItem(KEY)).toBe('c')
  })

  it('a throwing produce on the trailing edge leaves no timer armed', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => {
      throw new Error('serialize failed')
    })
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)

    schedule(KEY, () => 'c')
    expect(localStorage.getItem(KEY)).toBe('c')
  })

  it('a throwing produce inside flush and flushKey does not propagate', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => {
      throw new Error('serialize failed')
    })
    expect(() => flush()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)

    schedule(OTHER, () => 'x')
    schedule(OTHER, () => {
      throw new Error('serialize failed')
    })
    expect(() => flushKey(OTHER)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  // The spec promises absorption of BOTH error kinds on ALL FOUR paths. The
  // three above cover produce-on-timer, produce-in-flush/flushKey and
  // setItem-on-leading/timer. These pin the remaining corners.
  it('a throwing produce on the leading edge leaves no window and no timer', () => {
    expect(() =>
      schedule(KEY, () => {
        throw new Error('serialize failed')
      })
    ).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)

    schedule(KEY, () => 'b')
    expect(localStorage.getItem(KEY)).toBe('b')
  })

  it('a failed setItem during flush does not propagate', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    expect(() => flush()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a failed setItem during flushKey does not propagate', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    expect(() => flushKey(KEY)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/shared/throttledStorage.test.ts
```

Expected: FAIL — `Failed to resolve import "./throttledStorage"`.

- [ ] **Step 3: Implement the module**

Create `packages/fluux-sdk/src/stores/shared/throttledStorage.ts`:

```typescript
/**
 * Per-key leading + trailing throttle over `localStorage`.
 *
 * Every persisted store in the SDK re-serializes its whole blob on each
 * mutation. During post-connect MAM catch-up that is one synchronous
 * `JSON.stringify` + disk write per page — a main-thread stall on mobile
 * WebKit, where `setItem` is a synchronous disk write.
 *
 * `produce` is a LAZY THUNK, not a string. The expensive part is the
 * serialization, not `setItem`, so coalesced writes must skip it entirely:
 * a 180-page catch-up costs ~20 serializations rather than 180.
 *
 * Throttle, not debounce. A debounce resets its timer on every write, so a
 * continuous burst defers the write for the whole burst and leaves all of it
 * at risk on an abrupt close. This writes at a steady ~1/window and is never
 * starved: on-disk state is never more than one window stale.
 *
 * NOT safe for data that records a durable EVENT rather than a lagging mirror
 * of reconstructible state — see `flushKey` and chatStore's pending
 * retractions.
 */

/**
 * Deliberately not `PERSIST_DEBOUNCE_MS` from `stateSnapshot.ts` (500 ms).
 * That is a different mechanism (debounce, SM snapshot) and the two constants
 * must be able to move independently.
 */
const WINDOW_MS = 1000

interface Entry {
  timer: ReturnType<typeof setTimeout>
  /** Latest thunk received while the window was open; undefined = window idle. */
  pending?: () => string
}

/** Open windows, keyed by storage key. Absence of a key means no open window. */
const entries = new Map<string, Entry>()

let lifecycleRegistered = false

/**
 * Serialize and write, absorbing every failure.
 *
 * Both halves can throw: `produce` runs user serialization, and `setItem`
 * throws on quota exhaustion and in private mode. Every call site this module
 * replaced swallowed storage errors and continued without persistence, and a
 * throw escaping here would propagate out of a `set()` call or a `pagehide`
 * handler.
 */
function write(key: string, produce: () => string): boolean {
  try {
    localStorage.setItem(key, produce())
    return true
  } catch {
    // Continue without persistence, as every replaced call site did — but the
    // CALLER must know, so it can avoid arming a window around a write that
    // never landed.
    return false
  }
}

function onTimer(key: string): void {
  const entry = entries.get(key)
  if (!entry) return

  const pending = entry.pending
  if (!pending) {
    // Quiet window — close it. The next schedule takes the leading edge.
    entries.delete(key)
    return
  }

  // Cleared BEFORE the write: a throwing `produce` must not leave the thunk
  // armed to be retried forever.
  entry.pending = undefined
  if (!write(key, pending)) {
    // Failed write: close the window instead of rearming. Leaving a timer
    // armed around a failure would make the next good save wait a full window
    // for no reason; closing lets it take the leading edge immediately.
    entries.delete(key)
    return
  }
  // Open a fresh window rather than closing. This is what makes a sustained
  // burst write at a steady rate instead of going silent after two writes.
  entry.timer = setTimeout(() => onTimer(key), WINDOW_MS)
}

function registerLifecycleHandlers(): void {
  if (lifecycleRegistered) return
  lifecycleRegistered = true
  // Guarded so importing the SDK in Node (bots, tests, SSR) has no side effect.
  if (typeof window === 'undefined') return
  // `pagehide` and `visibilitychange` are the pair that fires reliably on
  // mobile WebKit; `beforeunload` is desktop belt-and-braces.
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
  }
}

/**
 * Persist `produce()` under `key`, coalescing bursts.
 *
 * `key` must be resolved by the CALLER, before calling — never inside
 * `produce`. A trailing write that fires after an account switch has to land
 * under the key that was current when its state was produced.
 */
export function schedule(key: string, produce: () => string): void {
  registerLifecycleHandlers()

  const entry = entries.get(key)
  if (entry) {
    entry.pending = produce
    return
  }

  // Only arm a window if the leading write actually landed. A failed write
  // must leave no window and no timer, so the next schedule can retry
  // immediately on its own leading edge rather than being coalesced behind a
  // window that is guarding nothing.
  if (!write(key, produce)) return
  entries.set(key, { timer: setTimeout(() => onTimer(key), WINDOW_MS) })
}

/**
 * Force one key's pending write out now and close its window.
 *
 * The durability escape hatch for data that must not sit in a pending thunk.
 * Carries no thunk of its own — it flushes whatever the caller already
 * scheduled, so it costs nothing when the leading edge has already written.
 */
export function flushKey(key: string): void {
  const entry = entries.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  entries.delete(key)
  if (entry.pending) write(key, entry.pending)
}

/**
 * Drop one key's pending write and close its window.
 *
 * Call BEFORE `localStorage.removeItem` on any clear path, or a write
 * scheduled moments earlier fires afterwards and resurrects what was cleared.
 */
export function cancel(key: string): void {
  const entry = entries.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  entries.delete(key)
}

/** Write every pending thunk now and close all windows. */
export function flush(): void {
  for (const [key, entry] of entries) {
    clearTimeout(entry.timer)
    if (entry.pending) write(key, entry.pending)
  }
  entries.clear()
}

/**
 * Test-only: drop all windows without writing.
 *
 * Lifecycle listeners are deliberately NOT unregistered — `flush` is
 * idempotent, and re-registering per suite would stack duplicates.
 * @internal
 */
export function _resetForTesting(): void {
  for (const entry of entries.values()) clearTimeout(entry.timer)
  entries.clear()
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/shared/throttledStorage.test.ts
```

Expected: PASS, 17 tests.

- [ ] **Step 5: Run the control checks**

These prove the tests can fail. Make each edit, confirm the expected failure, then **revert it**.

1. In `onTimer`, replace the **entire** `if (!pending) { ... }` block *and everything after it* with
   an unconditional `entries.delete(key); return` — i.e. make the timer always close the window and
   never perform the trailing write. (Replacing only the branch body with its own contents is a
   no-op and proves nothing.) Re-run.
   Expected: `coalesces N schedules`, `flush writes the LATEST`, and `sustained burst` FAIL.
2. In `schedule`, change `write(key, produce)` on the leading edge to a no-op. Re-run.
   Expected: `writes immediately on the leading edge` FAILS.

Revert both before committing.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/throttledStorage.ts packages/fluux-sdk/src/stores/shared/throttledStorage.test.ts
git commit -m "feat(sdk): add per-key leading+trailing storage throttle"
```

---

## Task 2: Wire chatStore's persist adapter

**Files:**
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` — adapter at ~2945, `switchAccount` at ~2914
- Test: `packages/fluux-sdk/src/stores/chatStore.persist.test.ts` (create)

**Interfaces:**
- Consumes: `schedule`, `cancel`, `flush` from Task 1.
- Produces: chat blob writes are throttled. `chatStore.getState().switchAccount(jid)` flushes first.

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/stores/chatStore.persist.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { localStorageMock } from '../core/sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import { chatStore } from './chatStore'
import { _resetForTesting, flush } from './shared/throttledStorage'
import { _resetStorageScopeForTesting } from '../utils/storageScope'

const KEY = 'xmpp-chat-storage'

function writeCount(): number {
  return localStorageMock.setItem.mock.calls.length
}

function seedConversation(id: string): void {
  // `Conversation extends ConversationEntity, ConversationMetadata`, so
  // `unreadCount` is required.
  chatStore.getState().addConversation({ id, name: id, type: 'chat', unreadCount: 0 })
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  _resetForTesting()
  _resetStorageScopeForTesting()
  chatStore.getState().reset()
  _resetForTesting()
  localStorageMock.setItem.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('chatStore persistence throttling', () => {
  it('collapses a long burst of mutations into far fewer writes', () => {
    seedConversation('a@example.com')
    localStorageMock.setItem.mockClear()

    // 180 MAM pages' worth of churn, spread over ~20s of wall clock.
    for (let i = 0; i < 180; i++) {
      chatStore.getState().setMAMLoading('a@example.com', i % 2 === 0)
      vi.advanceTimersByTime(110)
    }
    flush()

    expect(writeCount()).toBeGreaterThan(0)
    expect(writeCount()).toBeLessThanOrEqual(25)
  })

  it('after flush, on-disk state equals the final state', () => {
    seedConversation('a@example.com')
    seedConversation('b@example.com')
    chatStore.getState().setMAMLoading('a@example.com', true)
    flush()

    const onDisk = JSON.parse(localStorage.getItem(KEY)!)
    const ids = onDisk.state.conversationEntities.map(([id]: [string]) => id)
    expect(ids).toEqual(['a@example.com', 'b@example.com'])
  })

  it('a pagehide persists without an explicit flush', () => {
    seedConversation('a@example.com')
    seedConversation('b@example.com') // coalesced into the pending thunk
    window.dispatchEvent(new Event('pagehide'))

    const onDisk = JSON.parse(localStorage.getItem(KEY)!)
    const ids = onDisk.state.conversationEntities.map(([id]: [string]) => id)
    expect(ids).toContain('b@example.com')
  })

  it('reset leaves no pre-logout data behind', () => {
    seedConversation('secret@example.com')
    seedConversation('secret2@example.com') // pending, not yet written
    chatStore.getState().reset()
    vi.advanceTimersByTime(5000)

    // Per spec 2.1 the key EXISTS holding an empty blob — asserting absence
    // would assert something that has never been true, throttle or not.
    const raw = localStorage.getItem(KEY)
    expect(raw ?? '').not.toContain('secret@example.com')
    expect(raw ?? '').not.toContain('secret2@example.com')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/chatStore.persist.test.ts -t "collapses a long burst"
```

Expected: FAIL — write count is 180, exceeding 25.

- [ ] **Step 3: Import the throttle in chatStore**

At the top of `packages/fluux-sdk/src/stores/chatStore.ts`, beside the other `./shared/...` imports:

```typescript
import { schedule, flushKey, cancel, flush as flushThrottledStorage } from './shared/throttledStorage'
```

(`flushKey` is used in Task 3; importing it now avoids a second edit to the import block.)

- [ ] **Step 4: Replace the adapter's setItem and removeItem**

In the `persist(...)` options, replace:

```typescript
        setItem: (_, value) => {
          const scopedStorageKey = getScopedStorageKey()
          try {
            const state = value.state as ChatState
            const serialized = serializeState(state, scopedStorageKey)
            localStorage.setItem(scopedStorageKey, JSON.stringify({ state: serialized }))
          } catch {
            // Storage quota exceeded or other error, continue without persistence
          }
        },
        removeItem: () => {
          try {
            localStorage.removeItem(getScopedStorageKey())
          } catch {
            // Ignore storage errors
          }
        },
```

with:

```typescript
        setItem: (_, value) => {
          // Resolved HERE, not inside the thunk: a trailing write that fires
          // after a switchAccount must land under the key that was current
          // when this state was produced.
          const scopedStorageKey = getScopedStorageKey()
          const state = value.state as ChatState
          // Lazy — a coalesced write never pays for serializeState at all.
          // Error absorption lives in the throttle's `write`.
          schedule(scopedStorageKey, () =>
            JSON.stringify({ state: serializeState(state, scopedStorageKey) })
          )
        },
        removeItem: () => {
          const scopedStorageKey = getScopedStorageKey()
          // Before the removal: a write scheduled moments ago would otherwise
          // fire afterwards and resurrect the blob.
          cancel(scopedStorageKey)
          try {
            localStorage.removeItem(scopedStorageKey)
          } catch {
            // Ignore storage errors
          }
        },
```

- [ ] **Step 5: Flush on switchAccount**

In `switchAccount`, add the flush as the first statement:

```typescript
      switchAccount: (jid) => {
        // The outgoing account's pending blob must land before we load the
        // incoming one: a fast A -> B -> A would otherwise reload A from a
        // blob that predates its last mutations, and that stale load becomes
        // the live state.
        flushThrottledStorage()
        clearAllTypingTimeouts()
```

- [ ] **Step 6: Run to verify it passes**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/chatStore.persist.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Adapt the existing chatStore suite to the new timing contract**

The throttle changes when writes land, so suites written against synchronous
persistence break. These are known, not hypothetical:

`chatStore.test.ts`'s `beforeEach` calls `chatStore.setState({...})` after
`localStorageMock.clear()`. That `setState` goes through the persist adapter and
**opens a throttle window**, so the first mutation of every test body is
coalesced instead of writing immediately. Add `_resetForTesting()` to the
`beforeEach`, after the `setState`:

```typescript
import { _resetForTesting } from './shared/throttledStorage'

  beforeEach(() => {
    _resetStorageScopeForTesting()
    localStorageMock.clear()
    chatStore.setState({ /* ...existing reset... */ })
    // The setState above went through the persist adapter and opened a
    // throttle window. Drop it, so each test starts with a closed window and
    // its first mutation takes the leading edge.
    _resetForTesting()
  })
```

Then run the suite and fix the fallout. For any test that asserts on-disk
state, add an explicit `flush()` before the assertion — **only** where the test
genuinely means to observe the final persisted blob. Do not sprinkle `flush()`
to make failures disappear: a test that was asserting on a mid-burst write is a
test whose intent needs re-reading.

- [ ] **Step 8: Run the full chat store suite for regressions**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/chatStore
```

Expected: PASS, no stderr — including the two tests at `chatStore.test.ts:2067`
and `:2086` that assert `parsed.state.conversations`. This plan no longer
removes that field, so they must stay green; if either fails, the throttle has
changed *what* is persisted rather than only *when*, which is a bug in the
adapter wiring.

- [ ] **Step 9: Commit**

```bash
git add packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/chatStore.persist.test.ts packages/fluux-sdk/src/stores/chatStore.test.ts
git commit -m "perf(sdk): throttle chatStore localStorage writes"
```

---

## Task 3: Pending retractions bypass the throttle

**Files:**
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts:2137-2156` (`recordPendingRetraction`)
- Modify: `packages/fluux-sdk/package.json:98` (zustand peer range)
- Test: `packages/fluux-sdk/src/stores/chatStore.persist.test.ts` (extend)

**Interfaces:**
- Consumes: `flushKey` from Task 1 (already imported in Task 2 Step 3).
- Produces: nothing new.

The peer-range narrowing ships here because this task is what makes synchronous `setItem` load-bearing. Verified for zustand 5.0.13 at `node_modules/zustand/esm/middleware.mjs:370-374`; the declared `^4.0.0` lower bound never honoured the `storage` adapter at all (v4.0.0 took `getStorage`/`serialize`/`deserialize`), so narrowing removes a claim that was already untrue.

- [ ] **Step 1: Write the failing tests**

Append to `packages/fluux-sdk/src/stores/chatStore.persist.test.ts`:

```typescript
describe('pending retraction durability', () => {
  // The window MUST be opened first, on this same key. Recording a retraction
  // into an idle store is hollow: with no window open, the leading edge writes
  // it anyway and the test passes with flushKey removed.
  it('persists a retraction that was coalesced into an open window', () => {
    const id = 'a@example.com'
    seedConversation(id) // leading edge writes a blob with NO retraction, opens the window
    localStorageMock.setItem.mockClear()

    chatStore.getState().recordPendingRetraction(id, 'target-msg-1', 'someone@example.com')

    // The hard kill: no timer, no flush, no lifecycle event.
    const raw = localStorage.getItem(KEY)!
    expect(raw).toContain('target-msg-1')
  })

  // Pins the synchronous-setItem assumption. If a zustand upgrade ever defers
  // the adapter, this fails loudly instead of retractions quietly becoming losable.
  it('has persisted before recordPendingRetraction returns', () => {
    const id = 'b@example.com'
    seedConversation(id)
    chatStore.getState().recordPendingRetraction(id, 'target-msg-2', 'someone@example.com')
    expect(localStorage.getItem(KEY)!).toContain('target-msg-2')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/chatStore.persist.test.ts -t "coalesced into an open window"
```

Expected: FAIL — the retraction sits in the pending thunk, so the on-disk blob does not contain `target-msg-1`.

- [ ] **Step 3: Add the flushKey**

In `recordPendingRetraction`, after the `set(...)` block and before the closing brace:

```typescript
        set((state) => {
          const existing = state.pendingRetractions.get(conversationId) ?? []
          const next = addPendingRetraction(existing, { targetId, actorJid, retractedAt: Date.now() })
          if (next === existing) return state
          const nextPending = new Map(state.pendingRetractions)
          nextPending.set(conversationId, next)
          return { pendingRetractions: nextPending }
        })

        // A pending retraction is a durable EVENT, not a lagging mirror: it
        // records a retraction whose target was not resident. Lose it and the
        // message is never tombstoned — once coverage marks the range covered,
        // MAM will not re-query it and the retraction never arrives again.
        //
        // `flushKey` rather than a re-serialize: the `set` above already drove
        // the persist adapter (zustand calls `setItem` synchronously inside
        // `set`), so the blob is either already on disk via the leading edge
        // or sitting in the pending thunk. This lands the second case and
        // costs nothing in the first.
        flushKey(getScopedStorageKey())
      },
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/chatStore.persist.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Narrow the zustand peer range**

In `packages/fluux-sdk/package.json`, under `peerDependencies`, change:

```json
    "zustand": "^4.0.0 || ^5.0.0"
```

to:

```json
    "zustand": "^5.0.0"
```

Then regenerate the root lockfile, which carries workspace dependency metadata:

```bash
npm install --package-lock-only
git diff --stat package-lock.json
```

Expected: `package-lock.json` shows the narrowed peer range. It must be
committed with the manifest change — a lockfile left describing the old range
is a dirty tree on the next `npm install` and a CI diff.

- [ ] **Step 6: Verify the whole SDK suite and typecheck**

```bash
cd packages/fluux-sdk && npm run test:run && npm run typecheck && npm run lint
```

Expected: PASS, no stderr.

- [ ] **Step 7: Commit**

```bash
git add packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/chatStore.persist.test.ts packages/fluux-sdk/package.json package-lock.json
git commit -m "fix(sdk): keep pending retractions off the persist throttle

Narrows the zustand peer range to ^5.0.0: the storage adapter was never
honoured on the declared v4 lower bound, and synchronous setItem is now a
load-bearing assumption."
```

---

## Task 4: Wire roomStore and readStateStorage

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` — `saveDraftsToStorage` (~100), `savePollIdsToStorage` (~143), `saveGapsToStorage` (~193), `saveCoverageToStorage` (~223), `persistRoomReadState` (~260), `resolveRoomReadPosition` doc comment (~300), `switchAccount` (~1628), `reset` (~1640)
- Modify: `packages/fluux-sdk/src/stores/shared/readStateStorage.ts` — `clearRoomReadState` (~124), `_clearAllRoomReadStateForTesting` (~140), `saveRoomReadState` (~153)
- Test: `packages/fluux-sdk/src/stores/roomStore.throttledPersist.test.ts` (create)

**Interfaces:**
- Consumes: `schedule`, `cancel`, `flush` from Task 1.
- Produces: nothing new. `savePendingRetractionsToStorage` is deliberately unchanged.

All 13 helper call sites go through 5 functions, so only the function bodies change — no call site edits.

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/stores/roomStore.throttledPersist.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { localStorageMock } from '../core/sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import { roomStore } from './roomStore'
import { _resetForTesting, flush } from './shared/throttledStorage'
import { _clearAllRoomReadStateForTesting } from './shared/readStateStorage'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import type { Room, RoomMessage } from '../core/types'

// Same shape as the helpers in roomStore.test.ts:54 and :84 — copy them rather
// than importing across suites, matching how the existing suites are written.
function createRoom(jid: string, options: Partial<Room> = {}): Room {
  return {
    jid,
    name: options.name ?? jid.split('@')[0],
    nickname: options.nickname ?? 'testuser',
    joined: options.joined ?? false,
    isBookmarked: false,
    occupants: new Map(),
    messages: options.messages ?? [],
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
  }
}

function createMessage(id: string, roomJid: string, nick: string, body: string): RoomMessage {
  return {
    type: 'groupchat',
    id,
    roomJid,
    from: `${roomJid}/${nick}`,
    nick,
    body,
    timestamp: new Date(),
    isOutgoing: false,
  }
}

const ROOM = 'room@conference.example.com'

function writeCount(): number {
  return localStorageMock.setItem.mock.calls.length
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  _resetForTesting()
  _resetStorageScopeForTesting()
  roomStore.getState().reset()
  _resetForTesting()
  localStorageMock.setItem.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('roomStore throttled persistence', () => {
  it('coalesces repeated draft writes and keeps the latest', () => {
    roomStore.getState().setDraft(ROOM, 'one')
    roomStore.getState().setDraft(ROOM, 'two')
    roomStore.getState().setDraft(ROOM, 'three')
    expect(writeCount()).toBe(1)
    flush()
    expect(localStorage.getItem('fluux-room-drafts')).toContain('three')
  })

  it('gives each key its own window', () => {
    roomStore.getState().setDraft(ROOM, 'draft-a')
    roomStore.getState().setDraft(ROOM, 'draft-b')
    // Drafts' window is open; a first poll write must still take its own
    // leading edge rather than being coalesced behind it.
    roomStore.getState().recordPollVote(ROOM, 'poll-1')
    expect(localStorage.getItem('fluux-room-voted-polls')).toContain('poll-1')
    expect(localStorage.getItem('fluux-room-drafts')).toContain('draft-a')
    expect(localStorage.getItem('fluux-room-drafts')).not.toContain('draft-b')
  })

  it('switchAccount flushes the outgoing account under its own key', () => {
    setStorageScopeJid('a@example.com')
    roomStore.getState().setDraft(ROOM, 'a-first')
    roomStore.getState().setDraft(ROOM, 'a-pending')

    // Production order: XMPPClient.ts:1020-1022 sets the storage scope FIRST,
    // then calls switchAccount on both stores. Skipping the scope change would
    // test a sequence that never occurs.
    setStorageScopeJid('b@example.com')
    roomStore.getState().switchAccount('b@example.com')
    vi.advanceTimersByTime(5000)

    expect(localStorage.getItem('fluux-room-drafts:a@example.com')).toContain('a-pending')
    expect(localStorage.getItem('fluux-room-drafts:b@example.com') ?? '').not.toContain('a-pending')

    setStorageScopeJid('a@example.com')
    roomStore.getState().switchAccount('a@example.com')
    // The state field is `drafts`, not `roomDrafts`.
    expect(roomStore.getState().drafts.get(ROOM)).toBe('a-pending')
  })

  // Drafts and polls alone leave the three durable maps untested — and those
  // are the ones the #1081 read-pointer work depends on.
  //
  // There are no `recordRoomGap` / `recordRoomCoverage` setters. Gaps and
  // coverage are written from `removeRoom`, `mergeRoomMAMMessages`,
  // `clearRoomGapAnchor` and `clearRoomCoverage`. The two `clear*` actions are
  // the only ones with a signature small enough to drive directly, so the
  // scenarios seed the maps and then clear TWO rooms: the first clear takes the
  // leading edge, the second is the coalesced one that only lands if the
  // trailing write works.
  it('coalesces gap writes across two rooms', () => {
    const ROOM2 = 'room2@conference.example.com'
    // GapInterval is { start, end?, startId?, endId? } — epoch ms, not Dates.
    roomStore.setState({
      roomGaps: new Map([
        [ROOM, { start: 1000, startId: 'gap-anchor-1' }],
        [ROOM2, { start: 2000, startId: 'gap-anchor-2' }],
      ]),
    })
    localStorageMock.setItem.mockClear()

    roomStore.getState().clearRoomGapAnchor(ROOM, 'gap-anchor-1')  // leading edge
    roomStore.getState().clearRoomGapAnchor(ROOM2, 'gap-anchor-2') // coalesced
    flush()

    const raw = localStorage.getItem('fluux-room-gaps') ?? ''
    expect(raw).not.toContain('gap-anchor-1')
    expect(raw).not.toContain('gap-anchor-2')
  })

  it('coalesces coverage writes across two rooms', () => {
    const ROOM2 = 'room2@conference.example.com'
    // CoverageRecord is { bottomId, topId? }.
    roomStore.setState({
      roomCoverage: new Map([
        [ROOM, { bottomId: 'cov-1' }],
        [ROOM2, { bottomId: 'cov-2' }],
      ]),
    })
    localStorageMock.setItem.mockClear()

    roomStore.getState().clearRoomCoverage(ROOM)  // leading edge
    roomStore.getState().clearRoomCoverage(ROOM2) // coalesced
    flush()

    const raw = localStorage.getItem('fluux-room-coverage') ?? ''
    expect(raw).not.toContain('cov-1')
    expect(raw).not.toContain('cov-2')
  })

  // `advanceReadPointer` persists only when: connectionStore.windowVisible is
  // true (it defaults to true, so no setup needed), the room is in `rooms`,
  // it has a `roomMeta` entry, and the message id is resident. `addRoom` with
  // a populated `messages` array satisfies the last three.
  it('coalesces room read state and keeps the latest pointer', () => {
    roomStore.getState().addRoom(
      createRoom(ROOM, {
        joined: true,
        messages: [
          createMessage('r1', ROOM, 'alice', 'first'),
          createMessage('r2', ROOM, 'alice', 'second'),
        ],
      })
    )
    localStorageMock.setItem.mockClear()

    roomStore.getState().advanceReadPointer(ROOM, 'r1') // leading edge
    roomStore.getState().advanceReadPointer(ROOM, 'r2') // coalesced
    flush()

    expect(localStorage.getItem('fluux-room-read-state')).toContain('r2')
  })

  it('reset cancels pending gap, coverage and read-state writes', () => {
    const ROOM2 = 'room2@conference.example.com'
    roomStore.setState({
      roomGaps: new Map([
        [ROOM, { start: 1000, startId: 'gap-first' }],
        [ROOM2, { start: 2000, startId: 'gap-pending' }],
      ]),
      roomCoverage: new Map([
        [ROOM, { bottomId: 'cov-first' }],
        [ROOM2, { bottomId: 'cov-pending' }],
      ]),
    })
    roomStore.getState().addRoom(
      createRoom(ROOM, {
        joined: true,
        messages: [
          createMessage('read-first', ROOM, 'alice', 'a'),
          createMessage('read-pending', ROOM, 'alice', 'b'),
        ],
      })
    )
    // Open a window on each of the three keys, leaving a second write pending.
    roomStore.getState().clearRoomGapAnchor(ROOM, 'gap-first')
    roomStore.getState().clearRoomGapAnchor(ROOM2, 'gap-pending')
    roomStore.getState().clearRoomCoverage(ROOM)
    roomStore.getState().clearRoomCoverage(ROOM2)
    roomStore.getState().advanceReadPointer(ROOM, 'read-first')
    roomStore.getState().advanceReadPointer(ROOM, 'read-pending')

    roomStore.getState().reset()
    vi.advanceTimersByTime(5000)

    expect(localStorage.getItem('fluux-room-gaps') ?? '').not.toContain('gap-pending')
    expect(localStorage.getItem('fluux-room-coverage') ?? '').not.toContain('cov-pending')
    expect(localStorage.getItem('fluux-room-read-state') ?? '').not.toContain('read-pending')
  })

  it('_clearAllRoomReadStateForTesting leaves no row to resurrect', () => {
    roomStore.getState().addRoom(
      createRoom(ROOM, {
        joined: true,
        messages: [
          createMessage('r-first', ROOM, 'alice', 'a'),
          createMessage('r-pending', ROOM, 'alice', 'b'),
        ],
      })
    )
    roomStore.getState().advanceReadPointer(ROOM, 'r-first')
    roomStore.getState().advanceReadPointer(ROOM, 'r-pending') // pending

    _clearAllRoomReadStateForTesting()
    vi.advanceTimersByTime(5000)

    expect(localStorage.getItem('fluux-room-read-state') ?? '').not.toContain('r-pending')
  })

  it('reset does not let a pending write resurrect room data', () => {
    roomStore.getState().setDraft(ROOM, 'first')
    roomStore.getState().setDraft(ROOM, 'secret-pending')
    roomStore.getState().reset()
    vi.advanceTimersByTime(5000)
    expect(localStorage.getItem('fluux-room-drafts') ?? '').not.toContain('secret-pending')
  })

  // The throttle is PER KEY, so opening a window on room-read-state proves
  // nothing here. Both retractions must be on the retraction key: if that
  // helper were ever routed through `schedule`, the SECOND would be sitting
  // in a pending thunk.
  it('keeps pending retractions synchronous', () => {
    roomStore.getState().recordPendingRetraction(ROOM, 'target-1', 'nick-1')
    roomStore.getState().recordPendingRetraction(ROOM, 'target-2', 'nick-2')

    const raw = localStorage.getItem('fluux-room-pending-retractions') ?? ''
    expect(raw).toContain('target-1')
    expect(raw).toContain('target-2')
  })
})
```

**Note for the implementer:** `roomStore.recordPendingRetraction` writes its map only when the
target is non-resident and the entry is new. If the assertion finds an empty key, check the guard in
`roomStore.ts:1981` and seed the room first — do **not** relax the assertion or add a wrapper.

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/roomStore.throttledPersist.test.ts -t "coalesces repeated draft"
```

Expected: FAIL — 3 writes, not 1.

- [ ] **Step 3: Import the throttle in roomStore**

```typescript
import { schedule, cancel, flush as flushThrottledStorage } from './shared/throttledStorage'
```

- [ ] **Step 4: Route the five helpers through `schedule`**

```typescript
function saveDraftsToStorage(drafts: Map<string, string>, jid?: string | null): void {
  // Lazy: a coalesced write never pays for the stringify. Error absorption
  // lives in the throttle.
  schedule(getRoomDraftsStorageKey(jid), () => JSON.stringify(Array.from(drafts.entries())))
}

function savePollIdsToStorage(pollIds: Map<string, Set<string>>, storageKey: string): void {
  schedule(storageKey, () =>
    JSON.stringify(
      Array.from(pollIds.entries()).map(([k, v]) => [k, Array.from(v)] as [string, string[]])
    )
  )
}

function saveGapsToStorage(gaps: Map<string, GapInterval>, jid?: string | null): void {
  schedule(getRoomGapsStorageKey(jid), () => serializeGaps(gaps))
}

function saveCoverageToStorage(coverage: Map<string, CoverageRecord>, jid?: string | null): void {
  schedule(getRoomCoverageStorageKey(jid), () => serializeCoverage(coverage))
}
```

Leave `savePendingRetractionsToStorage` exactly as it is.

- [ ] **Step 5: Route `saveRoomReadState` through `schedule`**

In `readStateStorage.ts`, add `import { schedule, cancel } from './throttledStorage'` and replace the body:

```typescript
function serializeRoomReadState(state: Map<string, RoomReadState>): string {
  const entries: [string, SerializedRoomReadState][] = []
  for (const [roomJid, value] of state) {
    if (!value.readPointer && !value.historyFloor) continue
    entries.push([
      roomJid,
      {
        ...(value.readPointer ? { readPointer: serializeReadPointer(value.readPointer) } : {}),
        ...(value.historyFloor ? { historyFloor: value.historyFloor.getTime() } : {}),
      },
    ])
  }
  return JSON.stringify(entries)
}

export function saveRoomReadState(state: Map<string, RoomReadState>, jid?: string | null): void {
  const key = getRoomReadStateStorageKey(jid)
  // Registered at SCHEDULE time, not write time: a clear-all must be able to
  // cancel a write that is still pending.
  writtenRoomReadStateKeys.add(key)
  // `state` is a parameter, so the closure holds the MAP REFERENCE the caller
  // passed — not roomStore's reassignable `persistedRoomReadState` binding.
  // Keep it that way: reading a module binding inside the thunk would let a
  // pending write for account A serialize account B's map.
  schedule(key, () => serializeRoomReadState(state))
}
```

- [ ] **Step 6: Cancel before every clear**

```typescript
export function clearRoomReadState(jid?: string | null): void {
  const key = getRoomReadStateStorageKey(jid)
  // Before the removal, or a pending write fires afterwards and restores the
  // row this just deleted.
  cancel(key)
  writtenRoomReadStateKeys.delete(key)
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore storage errors (private mode, etc.).
  }
}

export function _clearAllRoomReadStateForTesting(): void {
  for (const key of writtenRoomReadStateKeys) {
    // Without this a timer armed by one test fires during the next and
    // reintroduces a row the cleanup deleted — which surfaces as a flaky
    // suite somewhere else entirely.
    cancel(key)
    try {
      localStorage.removeItem(key)
    } catch {
      // Ignore storage errors (private mode, etc.).
    }
  }
  writtenRoomReadStateKeys.clear()
  clearRoomReadState()
}
```

- [ ] **Step 7: Flush on switchAccount, cancel on reset**

In `roomStore.switchAccount`, as the first statement:

```typescript
  switchAccount: (jid) => {
    // Freshness on an immediate return: without this, a fast A -> B -> A runs
    // loadRoomReadState(A) against a blob predating A's last mutations, and
    // that stale load becomes the live state.
    flushThrottledStorage()
    roomArchiveSaves.clear()
```

In `roomStore.reset`, cancel each key before its `removeItem`:

```typescript
    // Cancel BEFORE removing. Unlike chatStore, nothing after this re-triggers
    // these helper writes, so a pending thunk would resurrect logged-out data.
    for (const key of [
      getRoomDraftsStorageKey(),
      getRoomVotedPollsStorageKey(),
      getRoomDismissedPollsStorageKey(),
      getRoomGapsStorageKey(),
      getRoomCoverageStorageKey(),
      getRoomNonAnonAckStorageKey(),
    ]) {
      cancel(key)
      localStorage.removeItem(key)
    }
```

replacing the six standalone `localStorage.removeItem(...)` calls. Leave `clearRoomReadState()` where it is — Step 6 gave it its own cancel.

- [ ] **Step 8: Correct the `resolveRoomReadPosition` doc comment**

At ~line 300, replace the paragraph beginning "Between the other two…" — specifically the clause claiming the row "is written synchronously on every advance" — with:

```
 * Between the other two, neither can be ahead of the user's true position, so
 * the later one is right. They are two mirrors of the same store and either can
 * be the stale one: the SDK state snapshot is debounced by 500 ms and the
 * durable `readStateStorage` row is throttled by 1000 ms, so after a crash
 * EITHER can be the older. Taking one at face value would then have
 * `persistRoomReadState` write an older position back over the row.
 *
 * The rule holds because both are LAGGING mirrors — throttling the row makes it
 * lag more, never lead — so "later" only ever recovers the freshest one.
```

- [ ] **Step 9: Adapt the existing room suites to the new timing contract**

Two suites are written against synchronous persistence and will break:

`readStateStorage.test.ts` — its `beforeEach` (line ~20) clears storage and sets
the scope but knows nothing about throttle windows, so a window left open by one
test coalesces the next test's first save. Add `_resetForTesting()` to the
`beforeEach`, and `flush()` in the tests that assert on-disk rows.

`roomStore.test.ts` — roughly fifteen assertions take the form
`expect(localStorageMock.setItem).toHaveBeenCalledWith('fluux-room-drafts', ...)`
or read `lastCall?.[0]`, at lines ~3595-3657 (drafts), ~5705-5718 (voted polls)
and ~5787 (dismissed polls). A first write still lands on the leading edge, so
some survive; any test making **two** mutations and asserting on the second, or
asserting a call count, will not. Add `flush()` before those assertions where
the test means to observe the final state, and `_resetForTesting()` to the
suite's `beforeEach`.

Run and fix until green. As in Task 2: do not add `flush()` to silence a
failure without reading what the test intended.

- [ ] **Step 10: Run tests, typecheck, lint**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/roomStore src/stores/shared/readStateStorage && npm run typecheck && npm run lint
```

Expected: PASS, no stderr. `readStateStorage` is included deliberately — it is
the suite most likely to break, and it is not covered by the `roomStore` path
filter.

- [ ] **Step 11: Commit**

```bash
git add packages/fluux-sdk/src/stores/roomStore.ts packages/fluux-sdk/src/stores/shared/readStateStorage.ts packages/fluux-sdk/src/stores/roomStore.throttledPersist.test.ts packages/fluux-sdk/src/stores/roomStore.test.ts packages/fluux-sdk/src/stores/shared/readStateStorage.test.ts
git commit -m "perf(sdk): throttle roomStore localStorage writes"
```

---

## Task 5: Public flush + Tauri quit

**Files:**
- Modify: `packages/fluux-sdk/src/index.ts`
- Modify: `apps/fluux/src/hooks/useTauriCloseHandler.ts:43-57`
- Test: `apps/fluux/src/hooks/useTauriCloseHandler.test.tsx`

**Interfaces:**
- Consumes: `flush` from Task 1.
- Produces: `flushPersistentStorage(): void`, exported from `@fluux/sdk`.

- [ ] **Step 1: Write the failing test**

In `apps/fluux/src/hooks/useTauriCloseHandler.test.tsx`, mock the SDK export and record whether the flush had happened **by the time disconnect was called** — not merely that it happened. Asserting the latter passes with the flush placed after `disconnect`, which is the exact mistake this guards.

The file uses `renderHook`, not a `Harness` component. Follow its existing
shape exactly.

Add the flush spy beside the existing `mockDisconnect` declaration:

```typescript
const mockFlush = vi.fn()

// Records whether the flush had already run at the moment disconnect fired.
let flushedAtDisconnect: boolean | null = null
const mockDisconnect = vi.fn(async () => {
  shuttingDownAtDisconnect = isShuttingDown()
  flushedAtDisconnect = mockFlush.mock.calls.length > 0
})
```

Extend the existing `@fluux/sdk` mock factory with the new export:

```typescript
vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useXMPPContext: () => ({ client: { disconnect: mockDisconnect } }),
  flushPersistentStorage: mockFlush,
}))
```

Reset both in `beforeEach`: `mockFlush.mockClear()` and
`flushedAtDisconnect = null`. Then the test:

```typescript
  it('flushes persisted storage before disconnecting', async () => {
    renderHook(() => useTauriCloseHandler())
    await waitFor(() => expect(shutdownHandler).not.toBeNull())

    await shutdownHandler!()

    // Not merely "was called" — that passes with the flush placed AFTER
    // disconnect, where a 2s race and exit_app can beat it.
    expect(flushedAtDisconnect).toBe(true)
  })
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/fluux && npx vitest run src/hooks/useTauriCloseHandler.test.tsx
```

Expected: FAIL — `flushPersistentStorage` is not exported / not called.

- [ ] **Step 3: Export it from the SDK**

In `packages/fluux-sdk/src/index.ts`, beside the other lifecycle exports:

```typescript
// Flush throttled localStorage writes. Call synchronously on app quit — the
// generic `flush` name is meaningless at the package boundary.
export { flush as flushPersistentStorage } from './stores/shared/throttledStorage'
```

- [ ] **Step 4: Rebuild the SDK**

```bash
npm run build:sdk
```

Expected: success. Required before the app typechecks against the new export.

- [ ] **Step 5: Call it on graceful shutdown**

In `apps/fluux/src/hooks/useTauriCloseHandler.ts`, add `flushPersistentStorage` to the `@fluux/sdk` import, then inside the `graceful-shutdown` listener:

```typescript
          markShuttingDown()

          // Synchronously, BEFORE the first await. `disconnectBestEffort`
          // races a 2s timeout and `exit_app` follows it, so a flush placed
          // after any await can lose up to a window of state. `pagehide` is
          // not reliable inside the webview on window close.
          flushPersistentStorage()

          await disconnectBestEffort()
```

- [ ] **Step 6: Run to verify it passes**

```bash
cd apps/fluux && npx vitest run src/hooks/useTauriCloseHandler.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Full verification**

```bash
npm test && npm run typecheck && npm run lint
```

Expected: PASS across both workspaces, no stderr.

- [ ] **Step 8: Commit**

```bash
git add packages/fluux-sdk/src/index.ts apps/fluux/src/hooks/useTauriCloseHandler.ts apps/fluux/src/hooks/useTauriCloseHandler.test.tsx
git commit -m "fix(app): flush persisted storage on Tauri graceful shutdown"
```

---

## Final verification

- [ ] **Full suite, typecheck, lint from the repo root**

```bash
npm test && npm run typecheck && npm run lint
```

- [ ] **Confirm the measured improvement**

Re-run the burst test and record the actual write count:

```bash
cd packages/fluux-sdk && npx vitest run src/stores/chatStore.persist.test.ts -t "collapses a long burst" --reporter=verbose
```

If the count is far below 25, tighten the bound to just above the observed value — a bound with a large margin is a bound that stops catching regressions. If it is above 25, the throttle is not engaging; do not loosen the bound without finding out why.

- [ ] **Open the PR**

```bash
git push -u origin mr/elastic-boyd-df5f4e
gh pr create --title "perf: throttle localStorage persistence in chatStore and roomStore" --body "$(cat <<'EOF'
Serializing the whole chat/room blob on every store mutation stalled the main thread during post-connect MAM catch-up: 180 MAM pages produced 180 synchronous `localStorage` writes, each O(conversations). On mobile WebKit, where `setItem` is a synchronous disk write, that lands in the launch window.

Adds a per-key leading+trailing throttle. It takes a lazy thunk rather than a string, so coalesced writes skip serialization entirely — the CPU cost was the `JSON.stringify`, not the `setItem`. A throttle rather than a debounce, so a sustained burst still writes at ~1/second instead of deferring the whole catch-up and putting all of it at risk on an abrupt close.

Pending retractions bypass the throttle via `flushKey`: they record a durable event rather than a lagging mirror, and a lost one leaves a message never tombstoned, since the covered range is not re-queried. Read pointers, gaps and coverage are safe to coalesce — losing a window under-advances them, which is the recoverable direction.

Also narrows the SDK's zustand peer range to `^5.0.0`. The custom `storage` adapter was never honoured on the declared v4 lower bound (v4.0.0 took `getStorage`/`serialize`/`deserialize`), so this removes a claim that was already untrue.

Not included: dropping the duplicated `conversations` compat map from the blob. It is independent of the throttle and needs all 22 conversation write paths proven before the rebuild-on-restore can be trusted; it gets its own PR.

Design: `docs/superpowers/specs/2026-07-24-throttled-persist-design.md`
EOF
)"
```

---

## Self-Review

**Spec coverage:** §1 module → Task 1. §1.1 error absorption and flush semantics → Task 1 Step 3 (`write` returning success, `flush`, `flushKey`) and its four failure tests. §1.2 retraction carve-out → Task 3. §1.3 peer range → Task 3 Step 5. §2 items 1-3 → Task 2; item 4 → Task 3. §2.1 reset behaviour left unchanged, test asserts no pre-logout data → Task 2 Step 1. §3 items 1-3 → Task 4 Steps 4-5; item 4 → Step 7; items 5-6 → Steps 6-7; item 7 → Step 8. §3.1 reference capture → Task 4 Step 5 comment. §3.2 → Steps 6-7. §3.3 → Step 8. §4.1 Tauri → Task 5. §5.1 → Task 1. §5.2 → Tasks 2-3. §5.3 → Task 4. §5.4 → Task 5. §5.5 controls → Task 1 Step 5.

**Deliberate spec gap:** §2 item 5 and the §5.2 compat/rebuild-fidelity tests are **not** covered — the compat-map removal was split into its own cycle (see the header). Nothing else in the spec is unimplemented.

**Existing-suite fallout is a named step, not an afterthought.** The throttle changes *when* writes land, which breaks suites written against synchronous persistence: `chatStore.test.ts`'s `beforeEach` opens a window via `setState` (Task 2 Step 7), and `roomStore.test.ts` has ~15 `toHaveBeenCalledWith`/`lastCall` assertions on drafts and polls plus `readStateStorage.test.ts`'s window-unaware `beforeEach` (Task 4 Step 9). Both steps warn against adding `flush()` to silence a failure rather than reading the test's intent.

**Known soft spot:** the ≤ 25 bound is calibrated from vitest numbers, not a device trace — the final verification step exists to tighten it against the observed value.

**Every identifier used in this plan's test code was checked against the source**, by extracting all `getState().*` references and grepping each one's declaration. This check found seven wrong names across two rounds — `addMessage`'s arity, `Message.isOwn`/`to`, `setRoomDraft`, `markPollVoted`, `recordRoomGap`, `recordRoomCoverage`, `markRoomAsRead`, `roomDrafts` — so re-run it after any edit that adds a store call. Confirmed:

- `chatStore`: `addConversation(conv: Conversation)` — `unreadCount` required; `addMessage(msg: Message)` — one argument, conversation comes from `msg.conversationId`; `Message` requires `type: 'chat'`, `id`, `conversationId`, `from`, `body`, `timestamp`, `isOutgoing` (no `to`, no `isOwn`); `setMAMLoading`, `recordPendingRetraction`, `reset`, `switchAccount`.
- `roomStore`: `setDraft`, `recordPollVote`, `recordPendingRetraction`, `addRoom`, `advanceReadPointer`, `clearRoomGapAnchor(roomJid, purgedStartId)`, `clearRoomCoverage(roomJid, ifBottomId?)`, `reset`, `switchAccount`. State field is `drafts`, not `roomDrafts`. There is **no** `recordRoomGap`, `recordRoomCoverage` or `markRoomAsRead`.
- Shapes: `GapInterval` is `{ start: number, end?: number, startId?: string, endId?: string }` — epoch ms, not `Date`. `CoverageRecord` is `{ bottomId: string, topId?: string }`.
- `advanceReadPointer` persists only when `connectionStore.windowVisible` is true (it defaults true), the room is in `rooms` with a `roomMeta` entry, and the message id is resident — `addRoom` with a populated `messages` array satisfies all three.
- `setStorageScopeJid` and `_resetStorageScopeForTesting` are exported from `utils/storageScope`.
