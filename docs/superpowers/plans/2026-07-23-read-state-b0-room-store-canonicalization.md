# PR B0 — Room message store canonicalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every *logical* room message exactly one cached row, matched across all its copies by the room-scoped XEP-0359 identity hierarchy, with every id/stanza/origin alias still resolvable — so PR B's unread count has one unambiguous archive position per message and no existing lookup breaks.

**Architecture:** A logical room message appears as several stanzas — optimistic echo (`originId`, no `stanzaId`, a client `id` the MUC may *rewrite*), reflection, MAM copy — sharing no single stable field and sometimes carrying different timestamps. They are matched only through the tiered identity the store already uses (`stanzaId → originId → from+id`), **scoped by room** because stanza/origin values are not globally unique. B0 centralizes that identity; makes the live write path and a streaming migration resolve an incoming message against every existing row via all tiers; and merges matches into one canonical row with a **commutative, associative, field-complete** merge (total-order content selection so ties only occur when rows are identical). The row carries `identityKeys[]` and `ids[]` multi-entry indexes so no alias is lost; every mutation entry point resolves through them. A `room_ts_from_id` index gives PR B its ordered walk. The migration streams and aborts atomically.

**Tech Stack:** TypeScript, `idb`, Vitest, `fake-indexeddb`.

**Spec:** [docs/superpowers/specs/2026-07-22-read-state-model-consolidation-design.md](../specs/2026-07-22-read-state-model-consolidation-design.md) — precursor PR **B0** in the `A → B0 → B → C` stack.
**Issue:** [#1081](https://github.com/processone/fluux-messenger/issues/1081)

## Global Constraints

- **Identity is the room-scoped XEP-0359 tier hierarchy.** Two copies are the same logical message iff they share **any** of `stanzaId`, `originId`, `from+id`. Every tier key is prefixed with the room JID: `stanzaId`/`originId` are assigned per-archive and can collide across rooms, and the `identityKeys` index spans the whole store — an unscoped key would merge messages across rooms. Separator is `U+0000` (JIDs/ids/stanzaIds cannot contain it; `:` and spaces appear in nicks).
- **No alias is dropped.** The merged row keeps `identityKeys[]` (union of every tier key) and `ids[]` (union of every client `id`), each a multi-entry index. `getRoomMessage`, `getRoomMessageByStanzaId`, `updateRoomMessage`, `updateRoomMessageReactions`, `deleteRoomMessage` resolve through those — a caller holding a pre-merge id (`roomStore.ts:600/1563/1720/1809/3046`) still finds the row.
- **The merge is commutative and associative.** `merge(a,b)` deep-equals `merge(b,a)`; any 3-row grouping/order yields one result. The content owner is chosen by a *total* order ending in a stable immutable-content-projection serialization (never the whole row, whose merged fields would break associativity), so a tie occurs only when the content is identical; every other field uses a symmetric operator (min-of-defined, OR, set-union, stanza-preferring timestamp). No edit, poll closure, retraction, reaction, moderation, or alias from either copy is lost.
- **Mutation entry points go through the identity model.** A non-identity update (reactions, retraction) is authoritative — resolve by `ids`, apply, put under the same key (no merge, so a removal is not undone). An update that *adds* identity fields (`{stanzaId, originId}`) must recompute `identityKeys`/`cacheKey`, re-key, and merge with any row that already carries the new identity.
- **Ordering is the `room_ts_from_id` index** (`[roomJid, timestamp, from, id]`), never a key string's lexical order.
- **The finder scans, never `.get()`.** `identityKeys` is non-unique; use `index.getAll(key)` so every match (non-unique tiers, bridges) is found.
- **The migration is explicit-abort and streaming.** idb does **not** await the async `upgrade` callback, so a rejected promise is not a reliable abort *and* rethrowing risks an unhandled rejection. Use a **synchronous** `upgrade` callback that fires the migration promise with `.catch(() => transaction.abort())` — the abort rejects `openDB`. Cursor the source one row at a time; never `getAll()` the archive. Do not `deleteObjectStore` the legacy store from the async continuation (illegal outside the sync handler) — `clear()` it instead. `fake-indexeddb` cannot prove browser abort semantics: the abort is explicit, and a real-browser check is a manual pre-merge gate.
- SDK tests are pure Vitest against `fake-indexeddb`. One small app-side change: `getRoomMessageByStanzaId` gains a `roomJid` parameter (stanza IDs collide across rooms), so its one app caller (`useReactionNotifications.ts`) is updated to pass it — see Task 4.
- Before any commit: `npm test` clean (no failures **and no stderr noise**), `npm run typecheck`, lint. `npm run test:scroll` (repo root) is a required gate on the write/read tasks.
- SSH commit signing is broken here; use `--no-gpg-sign` if it fails and say so. No Claude footer.
- **Hollow tests are this codebase's recurring defect.** Every task names a control with an explicit break step; the break's fixture must actually reach the code path it targets.

## File Structure

**Created:** `packages/fluux-sdk/src/utils/roomMessageIdentity.ts` (+ `.test.ts`) — the one identity definition.
**Modified:** `packages/fluux-sdk/src/utils/messageCache.ts` (+ `.test.ts`); `packages/fluux-sdk/src/stores/roomStore.ts:444-450` (delegate `getRoomMessageKeys`).

---

### Task 1: Centralize the room-scoped XEP-0359 identity

**Files:** create `roomMessageIdentity.ts` + test; modify `roomStore.ts:444-450`.

**Interfaces produced:**
- `RoomIdentityFields = { roomJid; from; id; stanzaId?; originId? }`
- `roomIdentityKeys(m): string[]` — every room-scoped tier key, most-specific first.
- `roomCanonicalKey(m): string` — the highest tier (= `roomIdentityKeys(m)[0]`).

**Control:** a `roomCanonicalKey` returning the `from+id` tier fails "prefers stanzaId then originId"; an unscoped key (dropping the `room:` prefix) fails "keys are room-scoped".

- [ ] **Step 1: Write the failing tests** — create `packages/fluux-sdk/src/utils/roomMessageIdentity.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { roomIdentityKeys, roomCanonicalKey } from './roomMessageIdentity'

const base = { roomJid: 'r@c', from: 'r@c/alice', id: 'origin-1' }
const NUL = '\u0000'

describe('roomIdentityKeys', () => {
  it('returns all tiers most-specific first, each room-scoped', () => {
    expect(roomIdentityKeys({ ...base, stanzaId: 'S', originId: 'O' })).toEqual([
      `room${NUL}r@c${NUL}stanzaId${NUL}S`,
      `room${NUL}r@c${NUL}originId${NUL}O`,
      `room${NUL}r@c${NUL}from${NUL}r@c/alice${NUL}id${NUL}origin-1`,
    ])
  })
  it('always includes the from+id fallback tier', () => {
    expect(roomIdentityKeys(base)).toEqual([`room${NUL}r@c${NUL}from${NUL}r@c/alice${NUL}id${NUL}origin-1`])
  })
  // Control: an unscoped implementation (no room: prefix) fails this — two rooms
  // sharing a stanzaId would then collide in the identityKeys index.
  it('scopes stanzaId by room, so equal values in different rooms differ', () => {
    const a = roomIdentityKeys({ roomJid: 'A@c', from: 'A@c/x', id: 'i', stanzaId: '1' })[0]
    const b = roomIdentityKeys({ roomJid: 'B@c', from: 'B@c/x', id: 'i', stanzaId: '1' })[0]
    expect(a).not.toBe(b)
  })
})

describe('roomCanonicalKey', () => {
  it('prefers stanzaId', () => { expect(roomCanonicalKey({ ...base, stanzaId: 'S', originId: 'O' })).toBe(`room${NUL}r@c${NUL}stanzaId${NUL}S`) })
  it('falls back to originId', () => { expect(roomCanonicalKey({ ...base, originId: 'O' })).toBe(`room${NUL}r@c${NUL}originId${NUL}O`) })
  it('falls back to from+id', () => { expect(roomCanonicalKey(base)).toBe(`room${NUL}r@c${NUL}from${NUL}r@c/alice${NUL}id${NUL}origin-1`) })
  it('is always the first identity key', () => { const m = { ...base, stanzaId: 'S' }; expect(roomCanonicalKey(m)).toBe(roomIdentityKeys(m)[0]) })
})
```

- [ ] **Step 2: Run to verify failure** — `cd packages/fluux-sdk && npx vitest run src/utils/roomMessageIdentity.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `packages/fluux-sdk/src/utils/roomMessageIdentity.ts`:

```ts
/**
 * The one definition of a room message's identity (XEP-0359), shared by the
 * resident-window dedup (`roomStore.getRoomMessageKeys`) and the message cache.
 * One logical message appears as several stanzas (optimistic echo, MUC reflection,
 * MAM copy) with no single stable field. They are matched through a tiered
 * identity, most-specific first: stanzaId, then originId, then from+id. Two copies
 * are the same logical message iff they share ANY of these keys.
 */
export interface RoomIdentityFields {
  roomJid: string
  from: string
  id: string
  stanzaId?: string
  originId?: string
}

// U+0000 separator: JIDs/ids/stanzaIds cannot contain it, so joins never collide.
const S = '\u0000'

/**
 * Room-scope a tier key. stanzaId/originId are assigned per-archive and can repeat
 * across rooms; the identityKeys index spans the whole store, so an unscoped key
 * would let the finder merge messages from different rooms.
 */
function scoped(roomJid: string, tier: string): string {
  return `room${S}${roomJid}${S}${tier}`
}

/** Every identity key the message carries, most-specific first. For matching. */
export function roomIdentityKeys(m: RoomIdentityFields): string[] {
  const keys: string[] = []
  if (m.stanzaId) keys.push(scoped(m.roomJid, `stanzaId${S}${m.stanzaId}`))
  if (m.originId) keys.push(scoped(m.roomJid, `originId${S}${m.originId}`))
  keys.push(scoped(m.roomJid, `from${S}${m.from}${S}id${S}${m.id}`))
  return keys
}

/** The single canonical key — the highest tier present. For the primary key. */
export function roomCanonicalKey(m: RoomIdentityFields): string {
  return roomIdentityKeys(m)[0]
}
```

- [ ] **Step 4: Delegate `roomStore.getRoomMessageKeys`** — import `roomIdentityKeys` from `../utils/roomMessageIdentity` and replace the body of `getRoomMessageKeys` (roomStore.ts:444-450) with `return roomIdentityKeys(m)`. (The old inline version used an unscoped `:` join; delegating both centralizes the definition and room-scopes the timeline dedup, which is strictly safer — only this one function produces the keys it compares.)

- [ ] **Step 5: Run + controls** — `npx vitest run src/utils/roomMessageIdentity.test.ts src/stores/roomStore.mds.test.ts`. Then: (1) make `roomCanonicalKey` return `roomIdentityKeys(m).at(-1)!` (the from+id tier) → "prefers stanzaId"/"falls back to originId" MUST fail; (2) make `scoped` return `tier` (drop the room prefix) → "scopes stanzaId by room" MUST fail. Revert each, confirm green.

- [ ] **Step 6: Full suite + commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/windows-minimize-tray-setting-779fba
npm run build:sdk && npm run typecheck && npm test
git add packages/fluux-sdk/src/utils/roomMessageIdentity.ts packages/fluux-sdk/src/utils/roomMessageIdentity.test.ts packages/fluux-sdk/src/stores/roomStore.ts
git commit -m "refactor(cache): centralize the room-scoped XEP-0359 message identity"
```

---

### Task 2: Canonical serializer + commutative, field-complete, total-order merge

**Files:** modify `messageCache.ts` (`StoredRoomMessage` line 62; `serializeRoomMessage` line 219; remove `getRoomMessageCacheKey` lines 30-45; add `mergeRoomRows` near `decryptionRank` line 257); test.

**Interfaces produced:**
- `StoredRoomMessage` gains `identityKeys: string[]`, `ids: string[]` (exported).
- `serializeRoomMessage(m)` sets `cacheKey = roomCanonicalKey(m)`, `identityKeys = roomIdentityKeys(m)`, `ids = [m.id]`.
- `mergeRoomRows(a, b): StoredRoomMessage` — commutative, associative, field-complete.

- [ ] **Step 1: Write the failing tests** — append to `messageCache.test.ts`. Fixtures build `identityKeys`/`cacheKey` via the real helpers so scoping stays correct:

```ts
import { mergeRoomRows } from './messageCache'
import type { StoredRoomMessage } from './messageCache'
import { roomIdentityKeys, roomCanonicalKey } from './roomMessageIdentity'

const rrow = (over: Partial<StoredRoomMessage> = {}): StoredRoomMessage => {
  const base = { type: 'groupchat', id: 'origin-1', roomJid: 'r@c', from: 'r@c/alice', body: 'hi', timestamp: 1000, isOutgoing: false, ...over } as StoredRoomMessage
  return { ...base, cacheKey: roomCanonicalKey(base), identityKeys: roomIdentityKeys(base), ids: [base.id], ...over } as StoredRoomMessage
}
const both = (a: StoredRoomMessage, b: StoredRoomMessage) => [mergeRoomRows(a, b), mergeRoomRows(b, a)]

describe('mergeRoomRows — commutative, associative, field-complete', () => {
  it('never downgrades decrypted content, both orders', () => {
    for (const m of both(rrow({ body: 'plaintext' }), rrow({ body: '', unsupportedEncryption: { kind: 'x' } as never }))) expect(m.body).toBe('plaintext')
  })
  it('keeps an edit from either row', () => {
    for (const m of both(rrow({ body: 'v1' }), rrow({ body: 'v2', isEdited: true, originalBody: 'v1' }))) { expect(m.isEdited).toBe(true); expect(m.body).toBe('v2') }
  })
  it('keeps a poll closure from either row', () => {
    for (const m of both(rrow({}), rrow({ pollClosed: { by: 'alice' } as never, pollClosedAt: 8000 }))) expect(m.pollClosed).toBeTruthy()
  })
  it('prefers the stanza-bearing timestamp, both orders', () => {
    for (const m of both(rrow({ timestamp: 5000 }), rrow({ timestamp: 4000, stanzaId: 'S' }))) expect(m.timestamp).toBe(4000)
  })
  it('unions reactions', () => {
    for (const m of both(rrow({ reactions: { a: ['alice'] } }), rrow({ reactions: { a: ['bob'], b: ['c'] } }))) { expect(new Set(m.reactions!.a)).toEqual(new Set(['alice','bob'])); expect(m.reactions!.b).toEqual(['c']) }
  })
  it('preserves a retraction from either row', () => {
    const [m] = both(rrow({}), rrow({ isRetracted: true, retractedAt: 7000 })); expect(m.isRetracted).toBe(true); expect(m.retractedAt).toBe(7000)
  })
  it('clears a delivery error when either copy delivered cleanly', () => {
    expect(both(rrow({ deliveryError: { text: 'x' } as never }), rrow({}))[0].deliveryError).toBeUndefined()
  })
  it('unions identityKeys/ids and recomputes cacheKey to the highest tier', () => {
    const echo = rrow({ originId: 'O', id: 'client-1' })
    const refl = rrow({ originId: 'O', stanzaId: 'S', id: 'server-9' })
    const [m] = both(echo, refl)
    expect(m.cacheKey).toBe(roomCanonicalKey({ roomJid: 'r@c', from: 'r@c/alice', id: 'server-9', stanzaId: 'S', originId: 'O' }))
    expect(new Set(m.ids)).toEqual(new Set(['client-1','server-9']))
  })

  it('is commutative on a mixed pair with EQUAL ids', () => {
    const a = rrow({ body: 'plain', originId: 'O', id: 'client-1', timestamp: 5000, reactions: { a: ['alice'] } })
    const b = rrow({ body: '', unsupportedEncryption: { kind: 'x' } as never, stanzaId: 'S', id: 'client-1', timestamp: 4000, reactions: { a: ['bob'] } })
    expect(mergeRoomRows(a, b)).toEqual(mergeRoomRows(b, a))
  })

  // The tie the old contentOwner got wrong: identical id/body/rank/edit, DIFFERENT attachment.
  it('is commutative when rows tie on rank/body/id but differ in attachment', () => {
    const a = rrow({ id: 'x', body: 'same', attachment: { url: 'a://1' } as never })
    const b = rrow({ id: 'x', body: 'same', attachment: { url: 'a://2' } as never })
    expect(mergeRoomRows(a, b)).toEqual(mergeRoomRows(b, a))
  })

  it('is associative and order-independent across three rows', () => {
    const a = rrow({ originId: 'O', id: 'c1', timestamp: 5000, reactions: { a: ['a'] } })
    const b = rrow({ stanzaId: 'S', id: 'c2', timestamp: 4000, reactions: { r: ['b'] } })
    const c = rrow({ body: 'edited', isEdited: true, id: 'c1', timestamp: 4500, reactions: { a: ['d'] } })
    const rs = [mergeRoomRows(mergeRoomRows(a,b),c), mergeRoomRows(a,mergeRoomRows(b,c)), mergeRoomRows(mergeRoomRows(b,a),c), mergeRoomRows(mergeRoomRows(c,b),a)]
    for (const r of rs) expect(r).toEqual(rs[0])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/utils/messageCache.test.ts -t "commutative, associative, field-complete"` → FAIL.

- [ ] **Step 3: Implement the serializer + merge**

Export the type (`export interface StoredRoomMessage`), add `identityKeys: string[]` and `ids: string[]` to it, and import at the top of `messageCache.ts`: `import { roomCanonicalKey, roomIdentityKeys } from './roomMessageIdentity'`. Update `serializeRoomMessage` (line 219) to set `cacheKey: roomCanonicalKey(message), identityKeys: roomIdentityKeys(message), ids: [message.id],` and **delete** the now-unused `getRoomMessageCacheKey` (lines 30-45).

Add after `decryptionRank` (line 264):

```ts
function unionSorted(a: string[] = [], b: string[] = []): string[] { return [...new Set([...a, ...b])].sort() }
function minStr(a?: string, b?: string): string | undefined { if (a == null) return b; if (b == null) return a; return a <= b ? a : b }
function minNum(a?: number, b?: number): number | undefined { if (a == null) return b; if (b == null) return a; return Math.min(a, b) }
function mergeReactions(a?: Record<string, string[]>, b?: Record<string, string[]>): Record<string, string[]> | undefined {
  if (!a) return b; if (!b) return a
  const out: Record<string, string[]> = {}
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = unionSorted(a[k], b[k])
  return out
}

/** Deterministic, key-sorted serialization — a stable total order over any row. */
function stableStringify(v: unknown): string {
  // JSON.stringify(undefined) is `undefined`, not a string — return a token so the
  // declared `string` return holds (undefined-valued fields do occur in the projection).
  if (v === undefined) return '␀undefined'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

/**
 * Choose the CONTENT-owner row by a strict TOTAL order, so the choice is the same
 * regardless of argument order AND a tie happens only when the rows are identical.
 * Higher decryption rank, then edited, then non-empty body, then — the fix — a
 * full stable serialization, so two rows differing in attachment / poll / reply /
 * encryption metadata still resolve deterministically instead of picking `a`.
 */
/**
 * The IMMUTABLE content projection — everything EXCEPT the fields merged
 * separately (aliases, timestamp, reactions, retraction, moderation, poll
 * closure, delivery error, cacheKey). The tiebreak must serialize only this,
 * because those excluded fields CHANGE during a merge: an intermediate merged
 * row acquires unioned aliases/reactions and a min timestamp, so serializing the
 * whole row would make contentOwner(merge(a,b), c) differ from
 * contentOwner(a, merge(b,c)) — destroying associativity. The content projection
 * is identical between a merged row and its content-winner, so max over it is
 * genuinely associative.
 */
function contentProjection(m: StoredRoomMessage): unknown {
  const {
    stanzaId: _s, originId: _o, timestamp: _t, reactions: _r, identityKeys: _ik, ids: _ids,
    isRetracted: _rt, retractedAt: _ra, isModerated: _m, moderatedBy: _mb, moderationReason: _mr,
    pollClosed: _pc, pollClosedAt: _pca, deliveryError: _de, cacheKey: _ck, ...content
  } = m
  return content
}

function contentOwner(a: StoredRoomMessage, b: StoredRoomMessage): StoredRoomMessage {
  const ra: number[] = [decryptionRank(a), a.isEdited ? 1 : 0, a.body ? 1 : 0]
  const rb: number[] = [decryptionRank(b), b.isEdited ? 1 : 0, b.body ? 1 : 0]
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i] ? a : b
  // Tiebreak over the IMMUTABLE content only, so max is associative (see contentProjection).
  return stableStringify(contentProjection(a)) <= stableStringify(contentProjection(b)) ? a : b
}

/**
 * Merge two stored rows that are the same logical room message into one.
 * COMMUTATIVE and ASSOCIATIVE. The correlated content block comes from
 * {@link contentOwner} (total order); every other field uses a symmetric operator,
 * so no edit, poll closure, retraction, reaction, moderation, or alias is lost.
 */
export function mergeRoomRows(a: StoredRoomMessage, b: StoredRoomMessage): StoredRoomMessage {
  const owner = contentOwner(a, b)
  const aSid = a.stanzaId != null, bSid = b.stanzaId != null
  const timestamp = aSid !== bSid ? (aSid ? a.timestamp : b.timestamp) : Math.min(a.timestamp, b.timestamp)
  const retracted = !!(a.isRetracted || b.isRetracted)
  const moderated = !!(a.isModerated || b.isModerated)
  // Poll closure: symmetric even when both closed with different records.
  const pollClosed = a.pollClosed && b.pollClosed
    ? (stableStringify(a.pollClosed) <= stableStringify(b.pollClosed) ? a.pollClosed : b.pollClosed)
    : (a.pollClosed ?? b.pollClosed)

  const merged: StoredRoomMessage = {
    ...owner,
    stanzaId: minStr(a.stanzaId, b.stanzaId),
    originId: minStr(a.originId, b.originId),
    timestamp,
    reactions: mergeReactions(a.reactions, b.reactions),
    identityKeys: unionSorted(a.identityKeys, b.identityKeys),
    ids: unionSorted(a.ids, b.ids),
    deliveryError: a.deliveryError && b.deliveryError ? (stableStringify(a.deliveryError) <= stableStringify(b.deliveryError) ? a.deliveryError : b.deliveryError) : undefined,
    ...(retracted ? { isRetracted: true, retractedAt: minNum(a.retractedAt, b.retractedAt) } : {}),
    ...(moderated ? { isModerated: true, moderatedBy: minStr(a.moderatedBy, b.moderatedBy), moderationReason: minStr(a.moderationReason, b.moderationReason) } : {}),
    ...(pollClosed ? { pollClosed, pollClosedAt: minNum(a.pollClosedAt, b.pollClosedAt) } : {}),
  }
  merged.cacheKey = roomCanonicalKey(merged)
  merged.identityKeys = unionSorted(merged.identityKeys, roomIdentityKeys(merged))
  return merged
}
```

Notes: the `...owner` spread carries every correlated content field (attachment, poll, replyTo, mentions, encryption, nick, occupantId, flags, systemEvent, …) — that is what makes the merge field-complete without enumerating them; `contentOwner`'s total order guarantees the block is chosen deterministically. `timestamp`/`retractedAt`/`pollClosedAt` are epoch-ms numbers.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/utils/messageCache.test.ts -t "commutative, associative, field-complete"` → PASS.

- [ ] **Step 5: Verify the controls bite** (each break must reach the path it targets):
1. Replace `contentOwner`'s last two lines with `return a` → the **"ties on rank/body/id but differ in attachment"** test MUST fail (this fixture reaches the tiebreak — unlike a rank/body-differing fixture, which would not). Revert.
2. Drop `.sort()` from `unionSorted` → the associativity test MUST fail. Revert.
3. Make `contentOwner` serialize the whole row (`stableStringify(a)` / `stableStringify(b)`) instead of `contentProjection(...)` → the associativity test MUST fail (an intermediate merge changes reactions/aliases/timestamp, so grouping changes the winner). Revert.
4. Force `timestamp = a.timestamp` → the stanza-timestamp test MUST fail. Revert.
4. Change `pollClosed` to `a.pollClosed ? a.pollClosed : b.pollClosed` for the both-closed case (order-dependent) → add/asssert a both-closed-different test fails; or fold into the attachment-tie test by giving both rows different `pollClosed`. Revert, confirm green.

- [ ] **Step 6: Full suite + commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/windows-minimize-tray-setting-779fba
npm run typecheck && npm test
git add packages/fluux-sdk/src/utils/messageCache.ts packages/fluux-sdk/src/utils/messageCache.test.ts
git commit -m "feat(cache): canonical room serializer and total-order commutative merge"
```

---

### Task 3: Schema v4 — alias indexes, identity-resolving upsert, streaming explicit-abort migration

**Files:** modify `messageCache.ts` (`DB_VERSION` 18, `ROOM_MESSAGES_STORE` 20, `MessageCacheSchema` 92-102, `upgrade` 146-184); add `findRoomRowsByIdentity`, `upsertRoomRowByIdentity`, `migrateRoomStoreToCanonical`, `_setMigrationFaultForTesting`; test.

**Interfaces produced:** `upsertRoomRowByIdentity(store, message)` (used by the migration and Task 4's write path); a v4 DB whose canonical room store has `identityKeys` + `ids` **multi-entry** indexes plus `roomJid`/`stanzaId`/`originId`/`timestamp`/`room_timestamp`/`room_ts_from_id`.

**Store rename:** stream the legacy `'room-messages'` into a fresh destination store, then `clear()` the legacy store:

```ts
const ROOM_MESSAGES_STORE = 'room-messages-canonical'
const LEGACY_ROOM_MESSAGES_STORE = 'room-messages'
```

**Controls:** (1) the straddle migration — an `originId`-keyed echo at `t1` and a `stanzaId`-keyed reflection of the same message (shared `originId`, rewritten `id`) at `t2` — collapses to one row with **both ids resolvable**; a finder that `.get()`s one tier, or an upsert treating rows as new, fails it. (2) a migration that throws leaves the DB at v3.

- [ ] **Step 1: Write the failing migration + alias + abort tests** — append to `messageCache.test.ts`:

```ts
import { openDB } from 'idb'

describe('v4 migration — identity-resolving canonicalization (streaming)', () => {
  const JID = 'me@example.com', ROOM = 'r@c', FROM = 'r@c/alice'
  const dbName = `fluux-message-cache:${JID}`
  async function seedV3(rows: Array<Record<string, unknown>>) {
    const db = await openDB(dbName, 3, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('messages')) {
          const s = d.createObjectStore('messages', { keyPath: 'id' })
          for (const [n, kp] of [['conversationId','conversationId'],['stanzaId','stanzaId'],['timestamp','timestamp'],['conv_timestamp',['conversationId','timestamp']],['encryptedPayload','encryptedPayload']] as const) s.createIndex(n, kp as never)
        }
        const r = d.createObjectStore('room-messages', { keyPath: 'cacheKey' })
        for (const [n, kp] of [['roomJid','roomJid'],['stanzaId','stanzaId'],['timestamp','timestamp'],['room_timestamp',['roomJid','timestamp']],['id','id']] as const) r.createIndex(n, kp as never)
      },
    })
    const tx = db.transaction('room-messages', 'readwrite')
    for (const row of rows) await tx.objectStore('room-messages').put(row as never)
    await tx.done; db.close()
  }
  beforeEach(() => { globalThis.indexedDB = new IDBFactory(); messageCache._resetDBForTesting(); _resetStorageScopeForTesting(); setStorageScopeJid(JID) })

  it('collapses an originId echo pair (rewritten id) into one row; both ids + stanzaId resolvable', async () => {
    await seedV3([
      { cacheKey: 'k1', originId: 'O', type: 'groupchat', id: 'client-1', roomJid: ROOM, from: FROM, body: 'hi', timestamp: 1000, isOutgoing: true },
      { cacheKey: 'k2', stanzaId: 'S', originId: 'O', type: 'groupchat', id: 'server-9', roomJid: ROOM, from: FROM, body: 'hi', timestamp: 2000, isOutgoing: true },
    ])
    const mine = (await messageCache.getRoomMessages(ROOM, {})).filter((m) => m.originId === 'O')
    expect(mine).toHaveLength(1)
    expect(mine[0].timestamp.getTime()).toBe(2000)
    expect(await messageCache.getRoomMessage('client-1')).not.toBeNull()
    expect(await messageCache.getRoomMessage('server-9')).not.toBeNull()
    expect(await messageCache.getRoomMessageByStanzaId(ROOM, 'S')).not.toBeNull()
  })

  it('does not merge identical stanzaIds across different rooms', async () => {
    await seedV3([
      { cacheKey: 'a', stanzaId: '1', type: 'groupchat', id: 'i', roomJid: 'A@c', from: 'A@c/x', body: 'a', timestamp: 1000, isOutgoing: false },
      { cacheKey: 'b', stanzaId: '1', type: 'groupchat', id: 'i', roomJid: 'B@c', from: 'B@c/x', body: 'b', timestamp: 1000, isOutgoing: false },
    ])
    expect(await messageCache.getRoomMessages('A@c', {})).toHaveLength(1)
    expect(await messageCache.getRoomMessages('B@c', {})).toHaveLength(1)
  })

  it('does not downgrade a decrypted body during migration', async () => {
    await seedV3([
      { cacheKey: 'x', stanzaId: 'S1', type: 'groupchat', id: 'o2', roomJid: ROOM, from: FROM, body: '', unsupportedEncryption: { kind: 'x' }, timestamp: 3000, isOutgoing: false },
      { cacheKey: 'y', stanzaId: 'S1', type: 'groupchat', id: 'o2', roomJid: ROOM, from: FROM, body: 'decrypted', timestamp: 3000, isOutgoing: false },
    ])
    expect((await messageCache.getRoomMessages(ROOM, {})).find((m) => m.stanzaId === 'S1')!.body).toBe('decrypted')
  })

  it('aborts the whole upgrade if the migration throws — DB stays at v3', async () => {
    await seedV3([{ cacheKey: 'z', stanzaId: 'S9', type: 'groupchat', id: 'o9', roomJid: ROOM, from: FROM, body: 'x', timestamp: 5000, isOutgoing: false }])
    messageCache._setMigrationFaultForTesting(true)
    await expect(messageCache.getRoomMessages(ROOM, {})).resolves.toEqual([])
    messageCache._setMigrationFaultForTesting(false); messageCache._resetDBForTesting()
    const raw = await openDB(dbName)
    expect(raw.version).toBe(3)
    expect(raw.objectStoreNames.contains('room-messages-canonical')).toBe(false)
    expect(await raw.get('room-messages', 'z')).toBeTruthy()
    raw.close()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/utils/messageCache.test.ts -t "identity-resolving canonicalization"` → FAIL.

- [ ] **Step 3: Fault flag + finder + upsert**

```ts
let migrationFaultForTesting = false
/** @internal test seam — force the v4 migration to throw, to verify it aborts. */
export function _setMigrationFaultForTesting(on: boolean): void { migrationFaultForTesting = on }

type RoomStoreLike = {
  put(v: StoredRoomMessage): Promise<unknown>
  delete(key: string): Promise<void>
  index(name: 'identityKeys'): { getAll(key: string): Promise<StoredRoomMessage[]> }
}

/** Every existing row sharing ANY identity tier with `m`, de-duped by cacheKey. Scans (not .get). */
async function findRoomRowsByIdentity(store: RoomStoreLike, m: StoredRoomMessage): Promise<StoredRoomMessage[]> {
  const found = new Map<string, StoredRoomMessage>()
  for (const key of m.identityKeys) for (const row of await store.index('identityKeys').getAll(key)) found.set(row.cacheKey, row)
  return [...found.values()]
}

/**
 * Core: resolve every existing row sharing any tier with `incoming` (echo,
 * live/MAM, bridge), merge them and `incoming` into one, delete the losers, put
 * the survivor. `incoming` is an already-serialized StoredRoomMessage, so callers
 * that need to PRESERVE accumulated aliases (updateRoomMessage) union them in
 * first. `excludeKey` skips a specific existing row from the merge — used when the
 * caller already holds that row's data in `incoming` and must not merge its
 * pre-update copy back in (which the union would do, re-adding a removed reaction).
 */
async function upsertStoredRoomRow(
  store: RoomStoreLike,
  incoming: StoredRoomMessage,
  excludeKey?: string
): Promise<void> {
  const matches = (await findRoomRowsByIdentity(store, incoming)).filter((r) => r.cacheKey !== excludeKey)
  let merged = incoming
  for (const row of matches) merged = mergeRoomRows(merged, row)
  const survivorKey = merged.cacheKey
  if (excludeKey && excludeKey !== survivorKey) await store.delete(excludeKey)
  for (const row of matches) if (row.cacheKey !== survivorKey) await store.delete(row.cacheKey)
  await store.put(merged)
}

/** Insert or merge a live-arriving message by identity. */
async function upsertRoomRowByIdentity(store: RoomStoreLike, message: RoomMessage): Promise<void> {
  await upsertStoredRoomRow(store, serializeRoomMessage(message))
}
```

- [ ] **Step 4: Version, schema, and the synchronous-callback explicit-abort migration**

Set `DB_VERSION = 4`; add the store constants above. In `MessageCacheSchema`, the canonical room store's `indexes`:

```ts
    indexes: {
      roomJid: string
      stanzaId: string
      originId: string
      identityKeys: string // multiEntry over identityKeys[]
      ids: string          // multiEntry over ids[]
      timestamp: number
      room_timestamp: [string, number]
      room_ts_from_id: [string, number, string, string]
    }
```

Keep the `upgrade` callback **synchronous** (do not make it `async`). Replace the room portion (166-183):

```ts
      if (!db.objectStoreNames.contains(ROOM_MESSAGES_STORE)) {
        const s = db.createObjectStore(ROOM_MESSAGES_STORE, { keyPath: 'cacheKey' })
        s.createIndex('roomJid', 'roomJid', { unique: false })
        s.createIndex('stanzaId', 'stanzaId', { unique: false })
        s.createIndex('originId', 'originId', { unique: false })
        s.createIndex('identityKeys', 'identityKeys', { unique: false, multiEntry: true })
        s.createIndex('ids', 'ids', { unique: false, multiEntry: true })
        s.createIndex('timestamp', 'timestamp', { unique: false })
        s.createIndex('room_timestamp', ['roomJid', 'timestamp'], { unique: false })
        s.createIndex('room_ts_from_id', ['roomJid', 'timestamp', 'from', 'id'], { unique: false })

        if (db.objectStoreNames.contains(LEGACY_ROOM_MESSAGES_STORE)) {
          // idb does NOT await this callback, and rethrowing would be an unhandled
          // rejection. Fire the migration and, on ANY failure, explicitly abort the
          // version-change transaction (which rejects openDB). The transaction stays
          // alive meanwhile via the migration's chained requests, and openDB resolves
          // only after it commits. Do not deleteObjectStore here (illegal from the
          // async continuation) — the migration clear()s the legacy store instead.
          migrateRoomStoreToCanonical(transaction).catch(() => transaction.abort())
        }
      }
```

Add the streaming migration (it `clear()`s, not `deleteObjectStore`s, the legacy store):

```ts
async function migrateRoomStoreToCanonical(transaction: { objectStore(name: string): any }): Promise<void> {
  const legacy = transaction.objectStore(LEGACY_ROOM_MESSAGES_STORE)
  const dest = transaction.objectStore(ROOM_MESSAGES_STORE) as unknown as RoomStoreLike
  let cursor = await legacy.openCursor()
  while (cursor) {
    if (migrationFaultForTesting) throw new Error('migration fault (test)')
    await upsertRoomRowByIdentity(dest, deserializeRoomMessage(cursor.value))
    cursor = await cursor.continue()
  }
  await legacy.clear() // legacy store now empty; a future version bump can drop it synchronously
}
```

Typing note: `transaction.objectStore(LEGACY_ROOM_MESSAGES_STORE)` references a store not in the current schema — cast the name locally (`as never`) or add a minimal legacy entry to `MessageCacheSchema`.

- [ ] **Step 5: Run to verify pass** — `npx vitest run src/utils/messageCache.test.ts -t "identity-resolving canonicalization"` → PASS.

- [ ] **Step 6: Verify the controls bite**
1. In `upsertRoomRowByIdentity`, force `const matches = []` → the straddle test finds two rows → `toHaveLength(1)` MUST fail. Revert.
2. In `findRoomRowsByIdentity`, scan only `m.identityKeys[0]` → the straddle pair (sharing only the `originId` tier, the 2nd key) MUST fail. Revert.
3. Replace `.catch(() => transaction.abort())` with `.catch(() => {})` (swallow) → the abort test MUST fail or flake. If it does not flip reliably under `fake-indexeddb`, that is the limitation Codex named — keep the explicit abort and record real-browser abort as a manual pre-merge check. Revert, confirm green.

- [ ] **Step 7: Full suite + scroll gate + commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/windows-minimize-tray-setting-779fba
npm run build:sdk && npm run typecheck && npm test && npm run test:scroll
git add packages/fluux-sdk/src/utils/messageCache.ts packages/fluux-sdk/src/utils/messageCache.test.ts
git commit -m "feat(cache): v4 identity-resolving room store, alias indexes, abortable streaming migration"
```

---

### Task 4: Route every write/read/mutation path through the identity model

**Files:** modify `messageCache.ts` — `saveRoomMessages` (761-778); `getRoomMessage` (784-796); `getRoomMessageByStanzaId` (801-814, **signature +roomJid**); `updateRoomMessage` (939+); `updateRoomMessageReactions` (983+); `deleteRoomMessage` (1034-1047); `getRoomMessagesAround` dedup (909); `roomMessageIdentity.ts` (add `roomStanzaKey`, `roomOriginKey`); `apps/fluux/src/hooks/useReactionNotifications.ts:142` (pass `roomJid`); test.

**Controls:** a blind-`put` `saveRoomMessages` fails "optimistic then reflection converge"; a `getRoomMessage` on the old single `id` index fails "discarded id resolves"; an `updateRoomMessage({stanzaId})` that only puts-back fails "adding a stanzaId re-keys and merges".

- [ ] **Step 1: Write the failing tests** — append to `messageCache.test.ts`:

```ts
describe('live paths — identity-resolving upsert + alias lookups + mutations', () => {
  const ROOM = 'r@c', FROM = 'r@c/alice'
  const mk = (over: Partial<RoomMessage> = {}): RoomMessage => ({ type: 'groupchat', id: 'client-1', roomJid: ROOM, from: FROM, body: 'hello', timestamp: new Date(5000), isOutgoing: true, originId: 'O', ...over }) as RoomMessage

  it('merges a reflection (rewritten id + stanzaId) into the optimistic echo', async () => {
    await messageCache.saveRoomMessage(mk())
    await messageCache.saveRoomMessage(mk({ id: 'server-9', stanzaId: 'S', timestamp: new Date(4000) }))
    const mine = (await messageCache.getRoomMessages(ROOM, {})).filter((m) => m.originId === 'O')
    expect(mine).toHaveLength(1); expect(mine[0].timestamp.getTime()).toBe(4000)
  })
  it('the discarded optimistic id still resolves after the merge', async () => {
    await messageCache.saveRoomMessage(mk()); await messageCache.saveRoomMessage(mk({ id: 'server-9', stanzaId: 'S' }))
    expect(await messageCache.getRoomMessage('client-1')).not.toBeNull()
    expect(await messageCache.getRoomMessage('server-9')).not.toBeNull()
    expect(await messageCache.getRoomMessageByStanzaId(ROOM, 'S')).not.toBeNull()
  })
  it('updateRoomMessage that ADDS a stanzaId re-keys and merges with any matching row', async () => {
    // A separate MAM copy already carries stanzaId S...
    await messageCache.saveRoomMessage(mk({ id: 'server-9', stanzaId: 'S' }))
    // ...and the optimistic row is only now confirmed via an identity-adding update.
    await messageCache.saveRoomMessage(mk()) // optimistic: originId O, no stanzaId
    await messageCache.updateRoomMessage('client-1', { stanzaId: 'S', originId: 'O' })
    expect((await messageCache.getRoomMessages(ROOM, {})).filter((m) => m.originId === 'O')).toHaveLength(1)
  })
  it('updateRoomMessage that ADDS an originId (canonical key UNCHANGED) still merges a row already at that originId', async () => {
    // Row 1 has stanzaId S, no originId → canonical key stanzaId:S.
    await messageCache.saveRoomMessage(mk({ id: 'a1', stanzaId: 'S', originId: undefined }))
    // Row 2 is a separate copy already carrying originId O (no stanzaId).
    await messageCache.saveRoomMessage(mk({ id: 'a2', originId: 'O', stanzaId: undefined }))
    // Confirm row 1 also carries originId O — its canonical key stays stanzaId:S,
    // so a key-only identityChanged check would MISS this and leave two rows.
    await messageCache.updateRoomMessage('a1', { originId: 'O' })
    expect((await messageCache.getRoomMessages(ROOM, {})).filter((m) => m.stanzaId === 'S' || m.originId === 'O')).toHaveLength(1)
    expect(await messageCache.getRoomMessage('a1')).not.toBeNull()          // every alias
    expect(await messageCache.getRoomMessage('a2')).not.toBeNull()          // preserved
    expect(await messageCache.getRoomMessageByStanzaId(ROOM, 'S')).not.toBeNull()
  })
  it('removes a deliberately cleared stale stanzaId alias (clearMessageStanzaId)', async () => {
    await messageCache.saveRoomMessage(mk({ stanzaId: 'stale-S' })) // has stanzaId + originId O + id client-1
    await messageCache.updateRoomMessage('client-1', { stanzaId: undefined }) // revoke the stanzaId
    // The scoped stanza alias must be GONE — else a later message with 'stale-S' merges wrongly.
    expect(await messageCache.getRoomMessageByStanzaId(ROOM, 'stale-S')).toBeNull()
    // ...but the message itself, and its other aliases, remain.
    expect(await messageCache.getRoomMessage('client-1')).not.toBeNull()
    expect(await messageCache.getRoomMessages(ROOM, {})).toHaveLength(1)
  })
  it('updateRoomMessageReactions resolves a pre-merge id and is authoritative (does not un-remove)', async () => {
    await messageCache.saveRoomMessage(mk()); await messageCache.saveRoomMessage(mk({ id: 'server-9', stanzaId: 'S' }))
    await messageCache.updateRoomMessageReactions('client-1', 'r@c/bob', ['👍'])
    expect((await messageCache.getRoomMessage('server-9'))!.reactions?.['👍']).toContain('r@c/bob')
    await messageCache.updateRoomMessageReactions('client-1', 'r@c/bob', []) // removal
    expect((await messageCache.getRoomMessage('server-9'))!.reactions?.['👍'] ?? []).not.toContain('r@c/bob')
  })
  it('getRoomMessagesAround returns each logical message once', async () => {
    await messageCache.saveRoomMessage(mk({ stanzaId: 'S' }))
    expect((await messageCache.getRoomMessagesAround(ROOM, 'client-1', { before: 5, after: 5 })).filter((m) => m.originId === 'O')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/utils/messageCache.test.ts -t "live paths"` → FAIL.

- [ ] **Step 3: Rewire the paths**

**`saveRoomMessages`** (761-778) — sequential upsert (a same-batch optimistic+reflection pair must merge; each upsert must see the prior write):

```ts
export async function saveRoomMessages(messages: RoomMessage[]): Promise<boolean> {
  if (messages.length === 0) return true
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readwrite')
    const store = tx.objectStore(ROOM_MESSAGES_STORE)
    for (const msg of messages) await upsertRoomRowByIdentity(store, msg)
    await tx.done
    return true
  } catch (error) {
    if (isIndexedDBAvailable()) console.warn('Failed to save room messages:', error)
    return false
  }
}
```

**Reads:** `getRoomMessage(id)` → `db.getFromIndex(ROOM_MESSAGES_STORE, 'ids', id)` (id is not unique across rooms — same as the old `id`-index behaviour, first match).

`getRoomMessageByStanzaId` must become **room-scoped** — `stanzaId` collides across rooms, so the global `stanzaId` index can return the wrong room's message. Change the signature to `getRoomMessageByStanzaId(roomJid, stanzaId)` and query the room-scoped alias: `db.getFromIndex(ROOM_MESSAGES_STORE, 'identityKeys', roomStanzaKey(roomJid, stanzaId))`, where `roomStanzaKey` is a small exported helper added to `roomMessageIdentity.ts`:

```ts
/** The room-scoped stanzaId identity key (for getRoomMessageByStanzaId and revocation). */
export function roomStanzaKey(roomJid: string, stanzaId: string): string {
  return scoped(roomJid, `stanzaId${S}${stanzaId}`)
}
/** The room-scoped originId identity key (for revocation). */
export function roomOriginKey(roomJid: string, originId: string): string {
  return scoped(roomJid, `originId${S}${originId}`)
}
```

Two callers pass the change through — both already have the room JID:
- `getRoomMessagesAround(roomJid, anchorMessageId)` (messageCache.ts:892) → `getRoomMessageByStanzaId(roomJid, anchorMessageId)`.
- **App-side** `apps/fluux/src/hooks/useReactionNotifications.ts:142` (inside a `room:reactions` handler that has `roomJid` in scope) → `getCachedRoomMessageByStanzaId(roomJid, messageId)`.

`getRoomMessagesAround`'s dedup (909) → `roomCanonicalKey(m)`.

**Non-identity mutations** — `updateRoomMessageReactions(id, ...)` and `deleteRoomMessage(id)`: resolve the row via the `ids` index (`getFromIndex(ROOM_MESSAGES_STORE, 'ids', id)`), then put/delete by the returned `cacheKey`. Reactions are authoritative (apply the reaction change to the found row and put under the same key — do NOT route through `mergeRoomRows`, whose union would un-remove a removed reaction).

**`updateRoomMessage(id, updates)`** — resolve via `ids`; apply updates to a working copy; then branch:
- If no identity **field** changed: `put` under the same key, keeping the existing `ids`/`identityKeys`.
- If an identity field changed — note the canonical key may or may not differ (adding an `originId` to a `stanzaId` row does not), which is why the branch keys off the FIELDS. Two shapes:
  - **Expansion** (a new `stanzaId`/`originId`, or a changed `id`): union the existing aliases into the updated row, then re-key and merge any *other* row already at the new identity.
  - **Revocation** (an explicit `{ stanzaId: undefined }`, which `clearMessageStanzaId` sends): the scalar is gone *and* its scoped alias must be **removed** — not unioned back — or `getRoomMessageByStanzaId` keeps resolving the dead id and a later message carrying that stanzaId is wrongly merged in.

  Both route through `upsertStoredRoomRow(store, row, existing.cacheKey)` (the `excludeKey` overwrites the same key when it is unchanged, re-keys and deletes the stale row when it changed). Concretely:

```ts
export async function updateRoomMessage(id: string, updates: Partial<RoomMessage>): Promise<void> {
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readwrite')
    const store = tx.objectStore(ROOM_MESSAGES_STORE)
    const existing = await store.index('ids').get(id)
    if (!existing) { await tx.done; return }
    const updated = { ...deserializeRoomMessage(existing), ...updates } as RoomMessage
    // Compare identity FIELDS, not just the canonical key: adding an originId to a
    // row that already has a stanzaId (or changing the id) leaves the canonical key
    // unchanged yet still expands the identity — a row now matching the new tier must
    // be merged in. Key-only comparison would take the non-identity branch and miss it.
    const identityChanged =
      updated.id !== existing.id ||
      updated.from !== existing.from ||
      updated.roomJid !== existing.roomJid ||
      updated.stanzaId !== existing.stanzaId ||
      updated.originId !== existing.originId
    if (!identityChanged) {
      const row = serializeRoomMessage(updated)
      row.identityKeys = existing.identityKeys // unchanged
      row.ids = existing.ids
      await store.put(row)
    } else {
      // An identity field changed. Union the existing row's accumulated aliases in
      // (do NOT delete-then-upsert — a deleted row cannot be rediscovered, and
      // re-serialization resets ids/identityKeys). But a REVOCATION ({ stanzaId:
      // undefined }) must REMOVE the cleared scoped alias, not union it back:
      const revoked: string[] = []
      if ('stanzaId' in updates && updated.stanzaId == null && existing.stanzaId) revoked.push(roomStanzaKey(existing.roomJid, existing.stanzaId))
      if ('originId' in updates && updated.originId == null && existing.originId) revoked.push(roomOriginKey(existing.roomJid, existing.originId))

      const row = serializeRoomMessage(updated) // ids=[updated.id]; identityKeys reflect current fields (a revoked tier is already absent)
      row.ids = unionSorted(existing.ids, row.ids)
      row.identityKeys = unionSorted(existing.identityKeys, row.identityKeys).filter((k) => !revoked.includes(k))
      // excludeKey = old cacheKey: overwrites when the canonical key is unchanged,
      // re-keys + deletes the stale row when it changed; either way the pre-update
      // copy is not merged back in. The finder uses row.identityKeys (revoked tier
      // absent), so a row legitimately still carrying that stanzaId is NOT pulled in.
      await upsertStoredRoomRow(store as never, row, existing.cacheKey)
    }
    await tx.done
  } catch (error) {
    if (isIndexedDBAvailable()) console.warn('Failed to update room message:', error)
  }
}
```

(`unionSorted` and `upsertStoredRoomRow` are defined in Task 3. The existing row's aliases are preserved in `row` before re-keying; `excludeKey` removes the stale row without folding its pre-update content back in; any *other* row already at the new identity is merged in — that is a genuine duplicate.)

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/utils/messageCache.test.ts -t "live paths"` → PASS.

- [ ] **Step 5: Verify the controls bite**
1. Revert `saveRoomMessages` to `await Promise.all(messages.map((m) => store.put(serializeRoomMessage(m))))` → "merges a reflection" MUST fail. Revert.
2. Point `getRoomMessage` back at a single `id` index → "discarded id resolves" MUST fail. Revert.
3. In `updateRoomMessage`, take the `!identityChanged` branch unconditionally (never re-key) → "adds a stanzaId re-keys and merges" MUST fail (two rows). Revert.
4. Revert `identityChanged` to the key-only check (`roomCanonicalKey(updated) !== existing.cacheKey`) → the "ADDS an originId (canonical key UNCHANGED)" test MUST fail (two rows), since adding an originId to a stanzaId row leaves the canonical key unchanged. Revert.
5. Drop the `.filter((k) => !revoked.includes(k))` (restore the unconditional alias union) → the "removes a deliberately cleared stale stanzaId alias" test MUST fail (`getRoomMessageByStanzaId` still resolves the dead id). Revert, confirm green.

- [ ] **Step 6: Full suite + scroll gate + commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/windows-minimize-tray-setting-779fba
npm run build:sdk && npm run typecheck && npm test && npm run test:scroll
git add packages/fluux-sdk/src/utils/messageCache.ts packages/fluux-sdk/src/utils/messageCache.test.ts
git commit -m "feat(cache): route all room writes/reads/mutations through the identity model"
```

---

## Definition of done for PR B0

- One room-scoped identity definition, used by `roomStore.getRoomMessageKeys` and the cache.
- One cache row per logical message — live optimistic+reflection, live+MAM, migrated legacy DB — and messages with equal stanza/origin values in *different rooms* stay separate.
- The merge is provably commutative and associative including the identical-except-a-field tie (Task 2), losing no edit/poll-closure/retraction/reaction/moderation/alias.
- Every id/stanza/origin alias resolves after a merge (Task 3/4), so all mutation entry points — `updateRoomMessage` (identity **expansion** *and* **revocation** of a cleared `stanzaId`), `updateRoomMessageReactions`, `deleteRoomMessage` — work on a pre-merge id, and a deliberately cleared alias stops resolving.
- The migration streams, scans (not `.get()`), and **explicitly aborts** on failure, leaving the DB at v3. Real-browser abort is a manual pre-merge check.
- `npm test`, typecheck, lint, `npm run test:scroll` pass; every control verified to bite.

## What PR B0 deliberately does NOT do

- No unread counting / `readState` / pointer `archiveOrderKey` — that is PR B, built on the single-row store this PR guarantees.
- No chat-store change (chat keys by a stable, unique `id`).

## Scope note

This grew during review into an identity-resolving, alias-preserving upsert, because a MUC rewrites the client id on echo (copies share only `originId`), stanza/origin values collide across rooms, and existing mutation callers hold pre-merge ids. That is inherent to the correctness goal (one logical message = one row, no lookup broken) and is why B0 is its own isolated precursor PR.
