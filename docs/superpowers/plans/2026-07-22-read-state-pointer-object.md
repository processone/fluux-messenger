# Read-state consolidation — PR A: ReadPointer, historyFloor, persistence, migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two independent read-state fields (`lastSeenMessageId`, `lastReadAt`) with one atomic `ReadPointer` object, give rooms the durable read-state persistence they never had, and migrate existing chat state — without changing how anything is counted yet.

**Architecture:** A new pure `readPointer` module owns the type and its forward-only comparison. Both metadata types gain `readPointer` and `historyFloor` *alongside* the legacy fields (strangler pattern), every writer and reader is migrated store-by-store while both stay in sync, and the final task deletes the legacy fields. Rooms gain a scoped-localStorage read-state store on the pattern roomStore already uses for gaps, coverage, retractions and drafts.

**Tech Stack:** TypeScript, Zustand (vanilla stores), Vitest, `fake-indexeddb`, `idb`.

**Spec:** [docs/superpowers/specs/2026-07-22-read-state-model-consolidation-design.md](../specs/2026-07-22-read-state-model-consolidation-design.md)
**Issue:** [#1081](https://github.com/processone/fluux-messenger/issues/1081)

## Global Constraints

- Branch off `main`. Never commit to `main` directly.
- Commits are SSH-signed — run `ssh-add -l` first; if the agent is empty, `ssh-add` before committing.
- No Claude footer in commit messages or PR descriptions.
- Before any commit: `npm test` clean (no failures **and no stderr noise**), `npm run typecheck`, lint.
- SDK type changes require `npm run build:sdk` before the app typechecks.
- The SDK's public API is `packages/fluux-sdk/src/index.ts` — anything the app imports must be exported there.
- Internal SDK modules import concrete store files, **never** the `../stores` barrel (ESLint-enforced; barrel `vi.mock`s silently no-op).
- New SDK export used by the app → add it to the app's mock in `apps/fluux/src/test-setup.ts` (`importOriginal` spread).
- **Every fallback leans toward more unread, never less.** Over-counting is a nuisance the user clears by reading; over-advancing the pointer is unrecoverable.
- **Hollow tests are the recurring defect in this codebase.** A deliberate-break check has already proven insufficient once. Every task below names a *control* — a specific wrong implementation the test must reject.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/fluux-sdk/src/stores/shared/readPointer.ts` | The `ReadPointer` type, forward-only comparison, floor computation, serialization. Pure, no I/O. |
| `packages/fluux-sdk/src/stores/shared/readPointer.test.ts` | Unit tests for the above. |
| `packages/fluux-sdk/src/stores/shared/readStateStorage.ts` | Scoped-localStorage persistence of room read state (`readPointer` + `historyFloor` per room JID). |
| `packages/fluux-sdk/src/stores/shared/readStateStorage.test.ts` | Unit tests for the above. |
| `packages/fluux-sdk/src/stores/chatStore.readPointerMigration.test.ts` | Migration tests for persisted chat state. |

**Modified:**

| File | Change |
|---|---|
| `packages/fluux-sdk/src/core/types/chat.ts:102-117` | `ConversationMetadata`: add `readPointer`, `historyFloor`; remove legacy fields in Task 6. |
| `packages/fluux-sdk/src/core/types/room.ts:258-287` | `RoomMetadata`: same, plus fix the false "persisted" doc comment. |
| `packages/fluux-sdk/src/stores/shared/notificationState.ts` | `EntityNotificationState` gains `readPointer`/`historyFloor`; legacy fields removed in Task 6. |
| `packages/fluux-sdk/src/stores/chatStore.ts` | Pointer writes/reads, rehydrate migration, stop zeroing `unreadCount`. |
| `packages/fluux-sdk/src/stores/roomStore.ts` | Pointer writes/reads, `ROOM_META_FIELDS`, read-state load/save wiring. |
| `packages/fluux-sdk/src/stores/shared/readMarkerSync.ts` | `ReadMarkerMeta` switches to `readPointer`. |
| `packages/fluux-sdk/src/core/mdsSideEffects.ts` | Read `readPointer.messageId` instead of `lastSeenMessageId`. |
| `packages/fluux-sdk/src/index.ts` | Export `ReadPointer` and its helpers. |
| `apps/fluux/src/hooks/useSessionPersistence.ts` | Delete dead `saveRooms`/`getSavedRooms` room path and read-state fields of `SerializableRoom`. |

---

### Task 1: The `ReadPointer` type and its pure helpers

**Files:**
- Create: `packages/fluux-sdk/src/stores/shared/readPointer.ts`
- Test: `packages/fluux-sdk/src/stores/shared/readPointer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ReadPointer`, `makeReadPointer(message: {id: string; timestamp: Date}): ReadPointer`, `isAhead(candidate: ReadPointer, current: ReadPointer | undefined): boolean`, `advance(current: ReadPointer | undefined, candidate: ReadPointer): ReadPointer`, `readFloor(pointer: ReadPointer | undefined, historyFloor: Date | undefined): Date | undefined`, `serializeReadPointer(p: ReadPointer): SerializedReadPointer`, `deserializeReadPointer(raw: unknown): ReadPointer | undefined`.

**Control for this task:** an implementation where `isAhead` compares `>=` instead of `>` must fail (it would let an equal-timestamp marker re-advance and republish forever), and one where `readFloor` returns the *earlier* of the two must fail (it would count already-read history as unread on a fresh join).

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/stores/shared/readPointer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  makeReadPointer,
  isAhead,
  advance,
  readFloor,
  serializeReadPointer,
  deserializeReadPointer,
} from './readPointer'

const at = (ms: number) => new Date(ms)

describe('makeReadPointer', () => {
  it('captures the id and timestamp of the message it names', () => {
    expect(makeReadPointer({ id: 'm1', timestamp: at(1000) })).toEqual({
      messageId: 'm1',
      timestamp: at(1000),
    })
  })
})

describe('isAhead', () => {
  it('treats any candidate as ahead of no pointer', () => {
    expect(isAhead(makeReadPointer({ id: 'm1', timestamp: at(1000) }), undefined)).toBe(true)
  })

  it('is ahead when strictly newer', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) })
    expect(isAhead(makeReadPointer({ id: 'm2', timestamp: at(2000) }), current)).toBe(true)
  })

  it('is NOT ahead when older', () => {
    const current = makeReadPointer({ id: 'm2', timestamp: at(2000) })
    expect(isAhead(makeReadPointer({ id: 'm1', timestamp: at(1000) }), current)).toBe(false)
  })

  // Control: a `>=` implementation passes every test above and fails this one.
  // Equal timestamps must NOT advance — a same-instant sibling is not progress,
  // and treating it as one makes the MDS publisher re-assert forever.
  it('is NOT ahead when the timestamp is equal but the id differs', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) })
    expect(isAhead(makeReadPointer({ id: 'm2', timestamp: at(1000) }), current)).toBe(false)
  })
})

describe('advance', () => {
  it('takes the candidate when it is ahead', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) })
    const next = makeReadPointer({ id: 'm2', timestamp: at(2000) })
    expect(advance(current, next)).toBe(next)
  })

  it('returns the SAME reference when the candidate is behind', () => {
    const current = makeReadPointer({ id: 'm2', timestamp: at(2000) })
    const older = makeReadPointer({ id: 'm1', timestamp: at(1000) })
    // Reference equality matters: Zustand selectors use it to skip re-renders.
    expect(advance(current, older)).toBe(current)
  })

  it('adopts the candidate when there is no current pointer', () => {
    const next = makeReadPointer({ id: 'm1', timestamp: at(1000) })
    expect(advance(undefined, next)).toBe(next)
  })
})

describe('readFloor', () => {
  it('is the pointer timestamp when there is no history floor', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(1000) })
    expect(readFloor(p, undefined)).toEqual(at(1000))
  })

  it('is the history floor when there is no pointer', () => {
    expect(readFloor(undefined, at(500))).toEqual(at(500))
  })

  it('is undefined when neither is set', () => {
    expect(readFloor(undefined, undefined)).toBeUndefined()
  })

  // Control: an implementation returning the EARLIER of the two passes the three
  // tests above and fails these. Taking the earlier value would count history the
  // user already read (or that predates the join) as unread.
  it('takes the LATER value when the pointer is ahead of the floor', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(2000) })
    expect(readFloor(p, at(500))).toEqual(at(2000))
  })

  it('takes the LATER value when the floor is ahead of the pointer', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(500) })
    expect(readFloor(p, at(2000))).toEqual(at(2000))
  })
})

describe('serialization', () => {
  it('round-trips through JSON', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: at(1000) })
    const raw = JSON.parse(JSON.stringify(serializeReadPointer(p)))
    expect(deserializeReadPointer(raw)).toEqual(p)
  })

  // Storage is untrusted input: a corrupt entry must yield "no pointer",
  // never a pointer with an Invalid Date that silently poisons comparisons.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nonsense'],
    ['a missing messageId', { timestamp: 1000 }],
    ['a missing timestamp', { messageId: 'm1' }],
    ['a non-numeric timestamp', { messageId: 'm1', timestamp: 'later' }],
  ])('returns undefined for %s', (_label, raw) => {
    expect(deserializeReadPointer(raw)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/shared/readPointer.test.ts
```

Expected: FAIL — `Failed to resolve import "./readPointer"`.

- [ ] **Step 3: Write the implementation**

Create `packages/fluux-sdk/src/stores/shared/readPointer.ts`:

```ts
/**
 * The read pointer — where the user has read to.
 *
 * This replaces the `lastSeenMessageId` + `lastReadAt` pair, which were two
 * independent fields describing one fact and drifted apart in practice (issue
 * #1081): `lastReadAt` meant "timestamp of the newest LOADED message when I last
 * activated", not "the timestamp of the message I read up to". Nothing stopped a
 * writer from moving one and not the other.
 *
 * Here they are one object. You cannot write half of it. The timestamp is
 * denormalised from the message the id names, which is what keeps ordering
 * comparisons synchronous and O(1) — the message cache is then needed only for
 * counting, not for deciding which of two positions is further along.
 *
 * All functions here are pure.
 */

/** Where the user has read to. Written atomically or not at all. */
export interface ReadPointer {
  /** Client message id of the newest message the user has read. */
  messageId: string
  /** Timestamp OF that message. */
  timestamp: Date
}

/** JSON-safe form for localStorage. */
export interface SerializedReadPointer {
  messageId: string
  timestamp: number
}

/** The minimal message shape a pointer can be built from. */
export interface PointerSource {
  id: string
  timestamp: Date
}

/** Build a pointer naming `message`. */
export function makeReadPointer(message: PointerSource): ReadPointer {
  return { messageId: message.id, timestamp: message.timestamp }
}

/**
 * Is `candidate` strictly further along than `current`?
 *
 * Equal timestamps are NOT an advance, even with a different id. Two messages
 * can share a millisecond (MAM archives routinely do), and treating a
 * same-instant sibling as progress would make the XEP-0490 publisher re-assert a
 * position it already published, forever. Refusing to advance there under-counts
 * at worst, which is the recoverable direction.
 */
export function isAhead(candidate: ReadPointer, current: ReadPointer | undefined): boolean {
  if (!current) return true
  return candidate.timestamp.getTime() > current.timestamp.getTime()
}

/**
 * Forward-only advance. Returns `current` **by reference** when the candidate is
 * not ahead, so Zustand selectors can skip the re-render.
 */
export function advance(current: ReadPointer | undefined, candidate: ReadPointer): ReadPointer {
  return isAhead(candidate, current) ? candidate : (current as ReadPointer)
}

/**
 * The floor every unread derivation counts from: the LATER of the read pointer
 * and the entity's history watermark.
 *
 * `historyFloor` records when the entity entered our world (join / creation). It
 * is not a read position — it is what stops a freshly joined room with 10k
 * messages of history from reporting 10k unread, without anyone having to write
 * the pointer to do it.
 */
export function readFloor(
  pointer: ReadPointer | undefined,
  historyFloor: Date | undefined
): Date | undefined {
  if (pointer && historyFloor) {
    return pointer.timestamp.getTime() >= historyFloor.getTime() ? pointer.timestamp : historyFloor
  }
  return pointer?.timestamp ?? historyFloor
}

export function serializeReadPointer(pointer: ReadPointer): SerializedReadPointer {
  return { messageId: pointer.messageId, timestamp: pointer.timestamp.getTime() }
}

/**
 * Rebuild a pointer from untrusted storage. Anything malformed yields
 * `undefined` — "no pointer" — rather than a pointer holding an Invalid Date,
 * which would poison every comparison it touched with silent `false`.
 */
export function deserializeReadPointer(raw: unknown): ReadPointer | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { messageId, timestamp } = raw as Partial<SerializedReadPointer>
  if (typeof messageId !== 'string' || messageId.length === 0) return undefined
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined
  return { messageId, timestamp: new Date(timestamp) }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/shared/readPointer.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Verify the controls actually bite**

Temporarily change `isAhead`'s `>` to `>=` and re-run — the equal-timestamp test MUST fail. Revert. Then change `readFloor`'s `>=` to `<=` and re-run — both "takes the LATER value" tests MUST fail. Revert, re-run, confirm green.

This step is not optional. A test that cannot fail is worse than no test, and this codebase has shipped ten of them.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/readPointer.ts packages/fluux-sdk/src/stores/shared/readPointer.test.ts
git commit -m "feat(read-state): add the ReadPointer type and its pure helpers"
```

---

### Task 2: Room read-state persistence module

**Files:**
- Create: `packages/fluux-sdk/src/stores/shared/readStateStorage.ts`
- Test: `packages/fluux-sdk/src/stores/shared/readStateStorage.test.ts`

**Interfaces:**
- Consumes: `ReadPointer`, `serializeReadPointer`, `deserializeReadPointer` from Task 1.
- Produces: `RoomReadState { readPointer?: ReadPointer; historyFloor?: Date }`, `loadRoomReadState(jid?: string | null): Map<string, RoomReadState>`, `saveRoomReadState(state: Map<string, RoomReadState>, jid?: string | null): void`.

This is the gap found while planning: `RoomMetadata.lastSeenMessageId` is documented as persisted and is not. `roomStore` has no persist middleware, and the app's `saveRooms` — sole writer of the `xmpp-rooms` sessionStorage key — has no production caller.

**Control for this task:** an implementation that swallows a corrupt entry by returning an entry with `undefined` fields (rather than omitting it) must fail; and one that persists to sessionStorage must fail the "survives across `loadRoomReadState` calls with a fresh module state" expectation via the localStorage key assertion.

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/stores/shared/readStateStorage.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { loadRoomReadState, saveRoomReadState, type RoomReadState } from './readStateStorage'
import { makeReadPointer } from './readPointer'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../../utils/storageScope'

const JID = 'me@example.com'
const at = (ms: number) => new Date(ms)

beforeEach(() => {
  localStorage.clear()
  _resetStorageScopeForTesting()
  setStorageScopeJid(JID)
})

describe('room read-state persistence', () => {
  it('round-trips a pointer and a history floor', () => {
    const state = new Map<string, RoomReadState>([
      ['room@conf.example.com', {
        readPointer: makeReadPointer({ id: 'm7', timestamp: at(7000) }),
        historyFloor: at(100),
      }],
    ])
    saveRoomReadState(state, JID)

    const restored = loadRoomReadState(JID)
    expect(restored.get('room@conf.example.com')).toEqual({
      readPointer: { messageId: 'm7', timestamp: at(7000) },
      historyFloor: at(100),
    })
  })

  it('returns an empty map when nothing was ever saved', () => {
    expect(loadRoomReadState(JID).size).toBe(0)
  })

  it('persists to localStorage under an account-scoped key', () => {
    saveRoomReadState(
      new Map([['r@c', { historyFloor: at(1) }]]),
      JID
    )
    expect(localStorage.getItem(`fluux-room-read-state:${JID}`)).not.toBeNull()
  })

  it('keeps one account’s read state out of another’s', () => {
    saveRoomReadState(new Map([['r@c', { historyFloor: at(1) }]]), JID)
    expect(loadRoomReadState('other@example.com').size).toBe(0)
  })

  it('survives a room with a floor but no pointer (joined, never read)', () => {
    saveRoomReadState(new Map([['r@c', { historyFloor: at(42) }]]), JID)
    const restored = loadRoomReadState(JID)
    expect(restored.get('r@c')).toEqual({ historyFloor: at(42) })
    expect(restored.get('r@c')?.readPointer).toBeUndefined()
  })

  // Control: an implementation that returns { readPointer: undefined } for a
  // corrupt row passes a naive `toBeUndefined()` check on the pointer while
  // still claiming the room HAS read state. Assert the row is dropped entirely,
  // so the room falls back to its history floor rather than to a phantom entry.
  it('drops a row whose pointer is corrupt rather than keeping a hollow entry', () => {
    localStorage.setItem(
      `fluux-room-read-state:${JID}`,
      JSON.stringify([['r@c', { readPointer: { messageId: 'm1' }, historyFloor: null }]])
    )
    expect(loadRoomReadState(JID).has('r@c')).toBe(false)
  })

  it('returns an empty map for unparseable storage rather than throwing', () => {
    localStorage.setItem(`fluux-room-read-state:${JID}`, '{not json')
    expect(loadRoomReadState(JID).size).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/shared/readStateStorage.test.ts
```

Expected: FAIL — `Failed to resolve import "./readStateStorage"`.

- [ ] **Step 3: Write the implementation**

Create `packages/fluux-sdk/src/stores/shared/readStateStorage.ts`:

```ts
/**
 * Durable, account-scoped persistence for ROOM read state.
 *
 * Rooms had none. `RoomMetadata.lastSeenMessageId` was documented as
 * "persisted, only advances forward" but roomStore has no persist middleware,
 * and the app's `saveRooms` — the only writer of the `xmpp-rooms` sessionStorage
 * key — has no production caller, so the restore path read a key nothing wrote.
 * Room read position was rebuilt every session from MAM catch-up plus the
 * XEP-0490 seed, which is very likely part of what issue #1076 reported.
 *
 * Follows the pattern roomStore already uses for gaps, coverage, pending
 * retractions and drafts: one scoped localStorage key holding a serialized Map.
 *
 * `unreadCount` is deliberately NOT persisted here — it is derived from the
 * archive against this pointer, and the archive is the thing worth trusting.
 */

import { buildScopedStorageKey } from '../../utils/storageScope'
import {
  deserializeReadPointer,
  serializeReadPointer,
  type ReadPointer,
  type SerializedReadPointer,
} from './readPointer'

const ROOM_READ_STATE_STORAGE_KEY_BASE = 'fluux-room-read-state'

/** Persisted read state for one room. */
export interface RoomReadState {
  readPointer?: ReadPointer
  /** When this room entered our world (join). Not a read position. */
  historyFloor?: Date
}

interface SerializedRoomReadState {
  readPointer?: SerializedReadPointer
  historyFloor?: number
}

function getRoomReadStateStorageKey(jid?: string | null): string {
  return buildScopedStorageKey(ROOM_READ_STATE_STORAGE_KEY_BASE, jid)
}

/**
 * Load persisted room read state.
 *
 * A row that cannot be fully reconstructed is DROPPED, not kept with undefined
 * fields: a hollow entry would claim the room has read state while carrying
 * none, and the caller would skip the history-floor fallback that should cover
 * exactly that case.
 */
export function loadRoomReadState(jid?: string | null): Map<string, RoomReadState> {
  const result = new Map<string, RoomReadState>()
  try {
    const stored = localStorage.getItem(getRoomReadStateStorageKey(jid))
    if (!stored) return result
    const entries = JSON.parse(stored) as [string, SerializedRoomReadState][]
    if (!Array.isArray(entries)) return result

    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const [roomJid, raw] = entry
      if (typeof roomJid !== 'string' || !raw || typeof raw !== 'object') continue

      // A pointer that was written but cannot be read back means the row is
      // corrupt — drop it rather than silently downgrading to "never read".
      let readPointer: ReadPointer | undefined
      if (raw.readPointer !== undefined) {
        readPointer = deserializeReadPointer(raw.readPointer)
        if (!readPointer) continue
      }

      const historyFloor =
        typeof raw.historyFloor === 'number' && Number.isFinite(raw.historyFloor)
          ? new Date(raw.historyFloor)
          : undefined

      if (!readPointer && !historyFloor) continue
      result.set(roomJid, { ...(readPointer ? { readPointer } : {}), ...(historyFloor ? { historyFloor } : {}) })
    }
  } catch {
    // Unparseable storage — start empty rather than throwing during store init.
  }
  return result
}

export function saveRoomReadState(state: Map<string, RoomReadState>, jid?: string | null): void {
  try {
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
    localStorage.setItem(getRoomReadStateStorageKey(jid), JSON.stringify(entries))
  } catch {
    // Ignore storage errors (quota exceeded, private mode, etc.).
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/shared/readStateStorage.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Verify the control bites**

Change the corrupt-pointer branch from `continue` to `readPointer = undefined` and re-run — the "drops a row whose pointer is corrupt" test MUST fail. Revert and confirm green.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/readStateStorage.ts packages/fluux-sdk/src/stores/shared/readStateStorage.test.ts
git commit -m "feat(read-state): persist room read state to scoped localStorage

Rooms had no durable read pointer at all: roomStore has no persist
middleware, and the app's saveRooms -- sole writer of the xmpp-rooms
sessionStorage key -- has no production caller, so the restore path read
a key nothing wrote."
```

---

### Task 3: Add `readPointer` and `historyFloor` to the metadata types

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/chat.ts:102-117`
- Modify: `packages/fluux-sdk/src/core/types/room.ts:258-287`
- Modify: `packages/fluux-sdk/src/stores/shared/notificationState.ts:26-50`
- Modify: `packages/fluux-sdk/src/index.ts`

**Interfaces:**
- Consumes: `ReadPointer` from Task 1.
- Produces: `ConversationMetadata.readPointer?`, `ConversationMetadata.historyFloor?`, `RoomMetadata.readPointer?`, `RoomMetadata.historyFloor?`, `EntityNotificationState.readPointer?`, `EntityNotificationState.historyFloor?` — all additive; legacy fields still present and still authoritative until Task 6.

This task is types-only and additive. Nothing reads the new fields yet, so behaviour cannot change.

- [ ] **Step 1: Add the fields to `ConversationMetadata`**

In `packages/fluux-sdk/src/core/types/chat.ts`, inside `ConversationMetadata`, after `lastSeenMessageId`:

```ts
  /**
   * Where the user has read to — the canonical read position.
   *
   * Supersedes the `lastSeenMessageId` + `lastReadAt` pair, which were two
   * independent fields describing one fact (issue #1081). Those two remain
   * during the migration and are removed once every reader has moved here.
   */
  readPointer?: ReadPointer
  /**
   * When this conversation entered our world. NOT a read position — it is the
   * floor that stops history predating the conversation from counting as
   * unread. Written once, at creation.
   */
  historyFloor?: Date
```

Add the import at the top of the file:

```ts
import type { ReadPointer } from '../../stores/shared/readPointer'
```

- [ ] **Step 2: Add the same fields to `RoomMetadata`, and fix the false doc comment**

In `packages/fluux-sdk/src/core/types/room.ts`, replace the `lastSeenMessageId` doc comment (line 271) — it currently claims a persistence that does not exist:

```ts
  /**
   * ID of the last message the user saw in the viewport (only advances forward).
   *
   * NOT persisted, despite what this comment claimed before #1081: roomStore has
   * no persist middleware and the app's `saveRooms` has no caller. Durable room
   * read state now lives in `readPointer` + `shared/readStateStorage`.
   *
   * @deprecated Superseded by `readPointer`; removed once all readers migrate.
   */
  lastSeenMessageId?: string
```

Then add, after it, the same `readPointer` / `historyFloor` block as Step 1 (wording adjusted for rooms — "when this room entered our world (join)"), plus the `ReadPointer` import.

- [ ] **Step 3: Add the fields to `EntityNotificationState`**

In `packages/fluux-sdk/src/stores/shared/notificationState.ts`, inside `EntityNotificationState` after `lastSeenMessageId`:

```ts
  /** Canonical read position. Supersedes lastSeenMessageId + lastReadAt (#1081). */
  readPointer?: ReadPointer
  /** Entity-creation watermark. Not a read position. */
  historyFloor?: Date
```

with `import type { ReadPointer } from './readPointer'` at the top.

- [ ] **Step 4: Export the new public surface**

In `packages/fluux-sdk/src/index.ts`, add:

```ts
export type { ReadPointer } from './stores/shared/readPointer'
export { makeReadPointer, isAhead, advance, readFloor } from './stores/shared/readPointer'
```

- [ ] **Step 5: Typecheck and run the full suite**

```bash
npm run build:sdk && npm run typecheck
```

Expected: clean. The change is additive with all fields optional, so nothing should break.

```bash
npm test
```

Expected: PASS with no stderr noise.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/types/chat.ts packages/fluux-sdk/src/core/types/room.ts packages/fluux-sdk/src/stores/shared/notificationState.ts packages/fluux-sdk/src/index.ts
git commit -m "feat(read-state): add readPointer and historyFloor to metadata types

Additive and unread by anything yet. Also corrects RoomMetadata's
lastSeenMessageId doc comment, which claimed a persistence that has never
existed."
```

---

### Task 4: Write `readPointer` alongside every existing pointer write

**Files:**
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` — every site writing `lastSeenMessageId`
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` — same
- Modify: `packages/fluux-sdk/src/stores/shared/notificationState.ts` — the transition functions that return `lastSeenMessageId`
- Test: `packages/fluux-sdk/src/stores/shared/notificationState.test.ts` (extend)

**Interfaces:**
- Consumes: `makeReadPointer`, `advance` from Task 1; the type fields from Task 3.
- Produces: the invariant that `readPointer.messageId === lastSeenMessageId` after every write, which Task 6 relies on to delete the legacy field.

The strangler step. Both fields are written; `lastSeenMessageId` stays authoritative. Every transition function in `notificationState.ts` that sets `lastSeenMessageId` must set `readPointer` in the same returned object.

`notificationState` functions receive `NotificationMessage` (which has `id` and `timestamp`), so `makeReadPointer(msg)` is available directly at each site. `onMessageSeen` receives only `messageId` plus the `messages` array — look the message up in that array to build the pointer.

**Control for this task:** a test asserting only `readPointer?.messageId` would pass against an implementation that never sets the timestamp. Every assertion below checks the WHOLE object.

- [ ] **Step 1: Write the failing tests**

Append to `packages/fluux-sdk/src/stores/shared/notificationState.test.ts`:

```ts
describe('readPointer is written with lastSeenMessageId (#1081 migration)', () => {
  const base = () => notifState.createInitialNotificationState()
  const msg = (id: string, ms: number, over = {}) => ({
    id, timestamp: new Date(ms), isOutgoing: false, ...over,
  })

  it('onMessageReceived sets both for an outgoing message', () => {
    const out = notifState.onMessageReceived(
      base(),
      msg('m1', 1000, { isOutgoing: true }),
      { isActive: false, windowVisible: false }
    )
    expect(out.lastSeenMessageId).toBe('m1')
    // Whole-object assertion: a partial write that sets only the id fails here.
    expect(out.readPointer).toEqual({ messageId: 'm1', timestamp: new Date(1000) })
  })

  it('onMessageReceived sets both when the user sees the message', () => {
    const out = notifState.onMessageReceived(
      base(),
      msg('m2', 2000),
      { isActive: true, windowVisible: true }
    )
    expect(out.lastSeenMessageId).toBe('m2')
    expect(out.readPointer).toEqual({ messageId: 'm2', timestamp: new Date(2000) })
  })

  it('onMessageSeen sets both, resolving the timestamp from the messages array', () => {
    const messages = [msg('m1', 1000), msg('m2', 2000), msg('m3', 3000)]
    const start = { ...base(), lastSeenMessageId: 'm1', readPointer: { messageId: 'm1', timestamp: new Date(1000) } }
    const out = notifState.onMessageSeen(start, 'm3', messages)
    expect(out.lastSeenMessageId).toBe('m3')
    expect(out.readPointer).toEqual({ messageId: 'm3', timestamp: new Date(3000) })
  })

  it('onMessageSeen leaves the pointer put when it does not advance', () => {
    const messages = [msg('m1', 1000), msg('m2', 2000)]
    const pointer = { messageId: 'm2', timestamp: new Date(2000) }
    const start = { ...base(), lastSeenMessageId: 'm2', readPointer: pointer }
    const out = notifState.onMessageSeen(start, 'm1', messages)
    expect(out.readPointer).toBe(pointer)
  })

  it('the two fields never disagree after any transition', () => {
    const messages = [msg('m1', 1000), msg('m2', 2000, { isOutgoing: true }), msg('m3', 3000)]
    let s = base()
    s = notifState.onMessageReceived(s, messages[0], { isActive: true, windowVisible: true })
    s = notifState.onMessageReceived(s, messages[1], { isActive: false, windowVisible: false })
    s = notifState.onMessageSeen(s, 'm3', messages)
    expect(s.readPointer?.messageId).toBe(s.lastSeenMessageId)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts -t "readPointer is written"
```

Expected: FAIL — `readPointer` is `undefined`.

- [ ] **Step 3: Implement**

In `notificationState.ts`, import the helpers:

```ts
import { makeReadPointer, advance, type ReadPointer } from './readPointer'
```

Then at each site that returns a new `lastSeenMessageId`, set `readPointer` in the same object literal:

- `onMessageReceived`, outgoing branch (around line 109): add `readPointer: makeReadPointer(msg),`
- `onMessageReceived`, `userSeesMessage` branch (around line 130): add `readPointer: makeReadPointer(msg),`
- `onMessageReceived`, unseen branch (around line 155): add `readPointer: state.readPointer,` (unchanged)
- `onActivate` return (around line 306): resolve `updatedLastSeenMessageId` to a pointer:

```ts
  const pointerMessage = updatedLastSeenMessageId
    ? messages.find((m) => m.id === updatedLastSeenMessageId)
    : undefined
  const updatedPointer = pointerMessage ? makeReadPointer(pointerMessage) : state.readPointer
```

  and return `readPointer: updatedPointer,`
- `onMarkAsRead` (around line 361): when `advanceSeenTo` is supplied the caller has the message, so add an optional 4th parameter `advanceSeenToTimestamp?: Date` and set `readPointer: advanceSeenTo && advanceSeenToTimestamp ? advance(state.readPointer, { messageId: advanceSeenTo, timestamp: advanceSeenToTimestamp }) : state.readPointer,`
- `onMessageSeen` (around lines 426, 447, 453): each branch that returns a new `lastSeenMessageId` resolves the message from `messages` and sets `readPointer` accordingly. Note `messages` is typed `Array<{ id: string }>` — widen it to `Array<{ id: string; timestamp?: Date }>` and skip the pointer write when the timestamp is absent, so the pre-existing callers that pass id-only arrays still compile.

Then update both stores so every `lastSeenMessageId:` written into `conversationMeta` / `roomMeta` / the combined maps also carries `readPointer:` from the same transition result. Enumerate the exact sites with:

```bash
grep -n "lastSeenMessageId:" packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/roomStore.ts
```

Every line that **writes** the field (as opposed to reading it into a `notifInput` literal) needs a paired `readPointer:` from the same transition result — e.g. `lastSeenMessageId: updated.lastSeenMessageId, readPointer: updated.readPointer,`. The read sites that build `notifInput` need `readPointer: meta?.readPointer ?? existing.readPointer,` added so the transition functions receive the current pointer.

Re-run the grep when done; each writing line should now have a `readPointer` sibling. The Task 4 invariant test (`the two fields never disagree after any transition`) is the backstop, but it only covers `notificationState` — the store sweep is verified by this grep plus the existing `chatStore.mds.test.ts` / `roomStore.mds.test.ts` suites.

- [ ] **Step 4: Run the tests**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts src/stores/chatStore.mds.test.ts src/stores/roomStore.mds.test.ts
```

Expected: PASS.

- [ ] **Step 5: Full suite and typecheck**

```bash
npm run build:sdk && npm run typecheck && npm test
```

Expected: PASS, no stderr.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src
git commit -m "feat(read-state): write readPointer alongside lastSeenMessageId

Strangler step -- lastSeenMessageId stays authoritative until every
reader has moved to readPointer."
```

---

### Task 5: Wire room read-state load/save, and `historyFloor` at entity creation

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` — store init, `addRoom`, and every `readPointer` write
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` — conversation creation
- Test: `packages/fluux-sdk/src/stores/roomStore.readState.test.ts` (create)

**Interfaces:**
- Consumes: `loadRoomReadState`, `saveRoomReadState`, `RoomReadState` from Task 2.
- Produces: rooms whose `readPointer` and `historyFloor` survive a store re-init.

`historyFloor` is written **once**, at entity creation, to the creation moment. It is never rewritten — that is what makes it a lifecycle fact rather than a second read position.

**Control for this task:** an implementation that rewrites `historyFloor` on every join (rather than only on first creation) passes a naive "floor is set" test. The test below re-adds an existing room and asserts the floor is unchanged.

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/stores/roomStore.readState.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { roomStore } from './roomStore'
import { loadRoomReadState } from './shared/readStateStorage'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'

const JID = 'me@example.com'
const ROOM = 'room@conf.example.com'

beforeEach(() => {
  localStorage.clear()
  _resetStorageScopeForTesting()
  setStorageScopeJid(JID)
  roomStore.getState().reset()
})

describe('room read state persistence', () => {
  it('stamps historyFloor when a room is first added', () => {
    roomStore.getState().addRoom({ jid: ROOM, name: 'Room', nickname: 'me', joined: true } as never)
    expect(roomStore.getState().roomMeta.get(ROOM)?.historyFloor).toBeInstanceOf(Date)
  })

  // Control: an implementation that stamps the floor on every addRoom (rejoin,
  // bookmark reload) passes "floor is set" but fails this. A moving floor would
  // silently erase unread history on every reconnect.
  it('does NOT restamp historyFloor when an existing room is re-added', () => {
    roomStore.getState().addRoom({ jid: ROOM, name: 'Room', nickname: 'me', joined: true } as never)
    const first = roomStore.getState().roomMeta.get(ROOM)?.historyFloor
    roomStore.getState().addRoom({ jid: ROOM, name: 'Room', nickname: 'me', joined: true } as never)
    expect(roomStore.getState().roomMeta.get(ROOM)?.historyFloor).toEqual(first)
  })

  it('persists the pointer so it survives a store reset + rehydrate', () => {
    roomStore.getState().addRoom({ jid: ROOM, name: 'Room', nickname: 'me', joined: true } as never)
    roomStore.getState().updateLastSeenMessageId(ROOM, 'm5')
    // Whatever the in-memory state, the durable copy is what matters here.
    const persisted = loadRoomReadState(JID)
    expect(persisted.get(ROOM)?.historyFloor).toBeInstanceOf(Date)
  })
})
```

Note: `updateLastSeenMessageId` is gated on `connectionStore.windowVisible` (the #1080 presence gate). Set it true in the test setup, or assert only the `historyFloor` persistence as written above.

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/roomStore.readState.test.ts
```

Expected: FAIL — `historyFloor` undefined.

- [ ] **Step 3: Implement**

In `roomStore.ts`:

1. Import `loadRoomReadState`, `saveRoomReadState` from `./shared/readStateStorage`.
2. At store init, hydrate `roomMeta` entries from `loadRoomReadState()`. Mirror `loadGapsFromStorage` / `loadCoverageFromStorage` — read their definitions at `roomStore.ts:180-226` and their init call sites (`grep -n "loadGapsFromStorage()\|loadCoverageFromStorage()" packages/fluux-sdk/src/stores/roomStore.ts`).
3. In `addRoom` (`roomStore.ts:883`), stamp `historyFloor: new Date()` **only when `state.roomMeta.get(room.jid)` is undefined**. `addRoom` runs again on rejoin and on bookmark reload; a floor that moves would silently erase unread history on every reconnect, which is what the control test in Step 5 pins down.
4. After any mutation of `readPointer` or `historyFloor`, call `saveRoomReadState` with the projected map — same placement as `saveGapsToStorage` after gap mutations (`grep -n "saveGapsToStorage(" packages/fluux-sdk/src/stores/roomStore.ts` for the call pattern).
5. Add `readPointer: true, historyFloor: true` to `ROOM_META_FIELDS` (`roomStore.ts:376-380`) so `commitRoomUpdate`'s `pickFields` routes them to meta rather than dropping them. That object is `satisfies Record<keyof RoomMetadata, true>`, so omitting them is a compile error — the typechecker enforces this step.

In `chatStore.ts`: stamp `historyFloor: new Date()` when a conversation entity is first created. Chat state already persists through the zustand `persist` middleware, so no new storage wiring is needed — just include the field in `serializeState` / `deserializeState`.

- [ ] **Step 4: Run the tests**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/roomStore.readState.test.ts src/stores/roomStore.mds.test.ts
```

Expected: PASS.

- [ ] **Step 5: Verify the control bites**

Move the `historyFloor` stamp in `addRoom` outside its "no existing meta" guard and re-run — the "does NOT restamp" test MUST fail. Revert, confirm green.

- [ ] **Step 6: Full suite, then commit**

```bash
npm run build:sdk && npm run typecheck && npm test
```

```bash
git add packages/fluux-sdk/src
git commit -m "feat(read-state): persist room read state and stamp historyFloor at creation"
```

---

### Task 6: Migrate chat persisted state, retire the legacy fields, delete dead code

**Files:**
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts:539-617` (`deserializeState`)
- Modify: `packages/fluux-sdk/src/core/types/chat.ts`, `packages/fluux-sdk/src/core/types/room.ts` — remove `lastSeenMessageId`, `lastReadAt`
- Modify: `packages/fluux-sdk/src/stores/shared/notificationState.ts`, `readMarkerSync.ts`, both stores, `core/mdsSideEffects.ts`
- Modify: `apps/fluux/src/hooks/useSessionPersistence.ts` — delete `saveRooms`, `getSavedRooms`, room read fields of `SerializableRoom`, and their call site at line 534
- Modify: `apps/fluux/src/hooks/useSessionPersistence.test.ts` — delete the corresponding tests
- Test: `packages/fluux-sdk/src/stores/chatStore.readPointerMigration.test.ts` (create)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `readPointer` as the sole read position. `lastSeenMessageId` and `lastReadAt` no longer exist on any type.

**The migration must never resolve AHEAD of the true position.** Today's `lastReadAt` means "newest *loaded* message when I last activated", so resolving it against the cache lands at-or-behind where the user actually was. Under-advancing shows extra unread, which the user clears by reading. Over-advancing is unrecoverable, because the pointer is forward-only.

**Control for this task:** an implementation resolving `lastReadAt` to the *oldest message after* that timestamp (rather than the newest at-or-before) passes a loose "a pointer exists" test and fails the explicit at-or-behind assertion below.

- [ ] **Step 1: Write the failing migration test**

Create `packages/fluux-sdk/src/stores/chatStore.readPointerMigration.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import * as messageCache from '../utils/messageCache'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { migrateReadPointer } from './chatStore'

const JID = 'me@example.com'
const CONV = 'peer@example.com'
const at = (ms: number) => new Date(ms)

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  messageCache._resetDBForTesting()
  _resetStorageScopeForTesting()
  setStorageScopeJid(JID)
  await messageCache.saveMessages([
    { type: 'chat', id: 'm1', conversationId: CONV, from: CONV, body: 'a', timestamp: at(1000), isOutgoing: false },
    { type: 'chat', id: 'm2', conversationId: CONV, from: CONV, body: 'b', timestamp: at(2000), isOutgoing: false },
    { type: 'chat', id: 'm3', conversationId: CONV, from: CONV, body: 'c', timestamp: at(3000), isOutgoing: false },
  ] as never)
})

describe('read pointer migration', () => {
  it('pairs an id with its persisted timestamp when both exist', async () => {
    const p = await migrateReadPointer(CONV, { lastSeenMessageId: 'm2', lastReadAt: at(2000) })
    expect(p).toEqual({ messageId: 'm2', timestamp: at(2000) })
  })

  it('resolves the timestamp from the cache when only the id survived', async () => {
    const p = await migrateReadPointer(CONV, { lastSeenMessageId: 'm2' })
    expect(p).toEqual({ messageId: 'm2', timestamp: at(2000) })
  })

  // Control: resolving to the OLDEST message AFTER lastReadAt would return m3
  // here. That is ahead of where the user was, and the pointer is forward-only,
  // so it would destroy the position unrecoverably.
  it('resolves lastReadAt-only to the newest message AT OR BEFORE it', async () => {
    const p = await migrateReadPointer(CONV, { lastReadAt: at(2500) })
    expect(p).toEqual({ messageId: 'm2', timestamp: at(2000) })
  })

  it('resolves exactly when lastReadAt lands on a message timestamp', async () => {
    const p = await migrateReadPointer(CONV, { lastReadAt: at(2000) })
    expect(p).toEqual({ messageId: 'm2', timestamp: at(2000) })
  })

  it('yields no pointer when lastReadAt predates every cached message', async () => {
    expect(await migrateReadPointer(CONV, { lastReadAt: at(500) })).toBeUndefined()
  })

  it('yields no pointer when there is nothing to migrate', async () => {
    expect(await migrateReadPointer(CONV, {})).toBeUndefined()
  })

  it('yields no pointer when the id is not in the cache and no timestamp survived', async () => {
    expect(await migrateReadPointer(CONV, { lastSeenMessageId: 'gone' })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/chatStore.readPointerMigration.test.ts
```

Expected: FAIL — `migrateReadPointer` is not exported.

- [ ] **Step 3: Implement the migration**

Add to `chatStore.ts` and export it:

```ts
/**
 * One-shot migration of legacy read state to a {@link ReadPointer}.
 *
 * Every branch resolves AT OR BEHIND the user's true position, never ahead.
 * Today's `lastReadAt` means "timestamp of the newest LOADED message when I last
 * activated" — not "the message I read up to" — so treating it as an upper bound
 * and taking the newest message at or before it is the closest honest reading.
 * The pointer is forward-only: under-advancing costs the user a few extra unread
 * messages, over-advancing destroys the position for good.
 */
export async function migrateReadPointer(
  conversationId: string,
  legacy: { lastSeenMessageId?: string; lastReadAt?: Date }
): Promise<ReadPointer | undefined> {
  const { lastSeenMessageId, lastReadAt } = legacy

  if (lastSeenMessageId && lastReadAt) {
    return { messageId: lastSeenMessageId, timestamp: lastReadAt }
  }

  if (lastSeenMessageId) {
    const cached = await messageCache.getMessage(lastSeenMessageId)
    if (cached) return makeReadPointer(cached)
    return undefined
  }

  if (lastReadAt) {
    // Newest message at or before the timestamp. `before` is exclusive, so probe
    // one millisecond past it to make the bound inclusive.
    const [newest] = await messageCache.getMessages(conversationId, {
      before: new Date(lastReadAt.getTime() + 1),
      limit: 1,
      latest: true,
    })
    return newest ? makeReadPointer(newest) : undefined
  }

  return undefined
}
```

Verify against `getMessages`' semantics at `messageCache.ts:445` — `before` builds `IDBKeyRange.upperBound([id, before.getTime()], true)` (exclusive) and `before` forces a backwards cursor, so `limit: 1` returns the newest matching message. If the returned order is not what this assumes, the test will catch it; fix the query, not the test.

- [ ] **Step 4: Run the migration tests**

```bash
cd packages/fluux-sdk && npx vitest run src/stores/chatStore.readPointerMigration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Verify the control bites**

Change the `lastReadAt` branch to use `{ after: lastReadAt, limit: 1 }` and re-run — the "newest message AT OR BEFORE" test MUST fail with `m3`. Revert, confirm green.

- [ ] **Step 6: Call the migration from `deserializeState` and stop zeroing the count**

In `chatStore.ts`'s `deserializeState` (line 541): drop `unreadCount: 0, // Reset unread on restore` from both the new-format branch (line 569) and the legacy branch (line 594), so the persisted count paints on cold start instead of flashing zero. Restore `historyFloor` alongside `lastReadAt` via the existing `restoreLastReadAt` date helper.

`deserializeState` is synchronous and `migrateReadPointer` is async, so run the migration as a post-rehydrate pass: restore meta synchronously with whatever legacy fields exist, then kick off a fire-and-forget migration that fills `readPointer` per conversation — the same shape as the existing localStorage-messages→IndexedDB migration at line 620.

- [ ] **Step 7: Delete the legacy fields**

Remove `lastSeenMessageId` and `lastReadAt` from `ConversationMetadata`, `RoomMetadata`, and `EntityNotificationState`. Also remove `ReadMarkerMeta.lastReadAt` / `.lastSeenMessageId` in `readMarkerSync.ts:14-20`, replacing them with `readPointer?: ReadPointer`. Fix every resulting compile error by reading `readPointer` instead. In `core/mdsSideEffects.ts`, `resolveSeenStanzaId` and `consider` read `meta.readPointer?.messageId`.

Remove `lastReadAt: true, lastSeenMessageId: true` from `ROOM_META_FIELDS` (roomStore.ts:378).

- [ ] **Step 8: Delete the dead room session-persistence path**

In `apps/fluux/src/hooks/useSessionPersistence.ts`: delete `saveRooms` (line 351), `getSavedRooms` (line 390), the `SerializableRoom` fields `unreadCount`, `mentionsCount`, `lastReadAt`, and the restore block at lines 534-539 that calls `getSavedRooms`. Rooms now rehydrate read state from `readStateStorage` inside the SDK, and their entities from bookmarks.

Delete the matching cases in `apps/fluux/src/hooks/useSessionPersistence.test.ts` (lines ~397, ~428).

- [ ] **Step 9: Full verification**

```bash
npm run build:sdk && npm run typecheck && npm test
```

Expected: PASS, no stderr.

```bash
npm run test:scroll
```

Run from the repo root. Expected: PASS — required gate for anything touching the loaded window.

- [ ] **Step 10: Manual verification — the one intended behaviour change**

PR A is otherwise behaviour-neutral, but rooms now remember their read position across a restart, which they never did. Unit tests cannot prove this end to end.

1. `npm run tauri:dev`, sign in, open a room, read to the bottom.
2. Quit the app fully and relaunch.
3. Confirm the room's read position survived: no unread badge for messages read before the quit, and the "new messages" divider is not at the top of the history.
4. Confirm `localStorage` holds `fluux-room-read-state:<your-jid>` with a plausible entry.

- [ ] **Step 11: Commit**

```bash
git add packages/fluux-sdk/src apps/fluux/src
git commit -m "refactor(read-state): retire lastSeenMessageId and lastReadAt for ReadPointer

Migrates persisted chat state one-shot, resolving every branch at or
behind the user's true position -- the pointer is forward-only, so
under-advancing costs a few extra unread and over-advancing is
unrecoverable.

Stops zeroing unreadCount on rehydrate, so cold start paints the
persisted count instead of flashing empty badges.

Deletes the dead saveRooms/getSavedRooms sessionStorage path: it read a
key nothing wrote."
```

---

## Definition of done for PR A

- `lastSeenMessageId` and `lastReadAt` appear nowhere in the SDK or app (`grep -rn "lastSeenMessageId\|lastReadAt" packages apps --include=*.ts --include=*.tsx` returns only historical comments).
- Room read state survives a full app restart (verified manually, Task 6 Step 10).
- `npm test`, `npm run typecheck`, lint and `npm run test:scroll` all pass.
- Every control listed per task has been verified to bite.
- No counting behaviour has changed — that is PR B.

## What PR A deliberately does NOT do

These belong to later PRs and must not be smuggled in:

- Deriving the unread count from the archive (PR B).
- Removing `recomputeCountsFromPointer` or the two per-store async recount blocks (PR B).
- Restricting who may write the pointer (PR C).
- Deleting `onActivate`'s fallback ladder or the `treatDelayedAsNew` option (PR C).
- Re-examining the four #1080 gates (PR C).

Plans for PR B and PR C are written once PR A lands — they modify code this PR restructures, so planning their exact edits now would produce a stale plan.
