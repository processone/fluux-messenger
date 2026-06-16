# MUC Join Error Handling + Room Password UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface *why* a MUC join failed (password required, nickname conflict, members-only, banned, …) and let the user recover — enter/correct a room password or change nickname — instead of the join silently spinning until timeout.

**Architecture:** The SDK already parses join-error presences and already sends `<password>`, but the error is dropped before the MUC handler sees it (the `handle()` gate requires `muc#user`, which join-error presences don't carry) and `joinRoom()` resolves on *send*, so nothing surfaces. We (1) route join-error presences from in-flight joins to a single `failJoin` handler, (2) add a dedicated awaitable `client.muc.joinResult(roomJid)` that resolves on self-presence (110) and rejects with a typed `RoomJoinError` on a terminal error / timeout — leaving `joinRoom()` and its other callers untouched, and (3) wire the modal to await it and map the condition to UI behavior.

**Tech Stack:** TypeScript, React, Zustand, `@xmpp/client` (ltx Element), Vitest, react-i18next. Monorepo: `packages/fluux-sdk` (SDK) + `apps/fluux` (app). Spec: [docs/superpowers/specs/2026-06-16-muc-join-error-handling-design.md](../specs/2026-06-16-muc-join-error-handling-design.md).

**Conventions for this plan:**
- Work on a feature branch (e.g. `feat/muc-join-errors`); `main` is protected. Commits are SSH-signed — run `ssh-add ~/.ssh/id_ed25519` once before the first commit.
- SDK tests run against SDK *source* (no build needed). The **app** resolves `@fluux/sdk` from `packages/fluux-sdk/dist`, so after changing SDK source you must `npm run build:sdk` before app typecheck/tests see new exports.
- Run SDK tests from the SDK workspace: `cd packages/fluux-sdk && npx vitest run <file>`. Run app tests from the app workspace: `cd apps/fluux && npx vitest run <file>`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/fluux-sdk/src/core/errors.ts` | `RoomJoinError` typed error | Create |
| `packages/fluux-sdk/src/core/errors.test.ts` | Unit test for the error | Create |
| `packages/fluux-sdk/src/index.ts` | Public SDK exports | Modify (export `RoomJoinError`) |
| `packages/fluux-sdk/src/core/modules/MUC.ts` | MUC join + error routing + `joinResult` | Modify |
| `packages/fluux-sdk/src/core/modules/MUC.test.ts` | SDK join-outcome tests | Modify (add a describe block) |
| `packages/fluux-sdk/src/hooks/useRoomActions.ts` | Expose `joinResult` to the app | Modify |
| `apps/fluux/src/i18n/locales/en.json` | English strings | Modify (add 10 `rooms.*` keys) |
| `apps/fluux/src/i18n/locales/*.json` (32 others) | Translations | Modify |
| `apps/fluux/src/components/JoinRoomModal.tsx` | Password field + condition→UX mapping | Modify |
| `apps/fluux/src/components/JoinRoomModal.test.tsx` | Modal behavior tests | Modify |

---

## Task 0: Branch setup

- [ ] **Step 1: Create the feature branch**

```bash
cd /Users/mremond/AIProjects/fluux-messenger
git checkout -b feat/muc-join-errors
```

- [ ] **Step 2: Stage and commit the already-written spec**

The spec doc is currently an untracked working-tree file from the brainstorming step.

```bash
ssh-add ~/.ssh/id_ed25519   # if not already added; SSH-signed commits
git add docs/superpowers/specs/2026-06-16-muc-join-error-handling-design.md docs/superpowers/plans/2026-06-16-muc-join-error-handling.md
git commit -m "docs: spec + plan for MUC join error handling and room password UI"
```

---

## Task 1: `RoomJoinError` typed error (SDK)

**Files:**
- Create: `packages/fluux-sdk/src/core/errors.ts`
- Create: `packages/fluux-sdk/src/core/errors.test.ts`
- Modify: `packages/fluux-sdk/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/core/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { RoomJoinError } from './errors'

describe('RoomJoinError', () => {
  it('carries roomJid, condition, errorType, and text', () => {
    const err = new RoomJoinError('room@conf.example.org', 'not-authorized', 'auth', 'Password required')
    expect(err.roomJid).toBe('room@conf.example.org')
    expect(err.condition).toBe('not-authorized')
    expect(err.errorType).toBe('auth')
    expect(err.text).toBe('Password required')
  })

  it('is an instanceof Error and RoomJoinError', () => {
    const err = new RoomJoinError('room@conf.example.org', 'conflict')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(RoomJoinError)
    expect(err.name).toBe('RoomJoinError')
  })

  it('uses server text as the message when present, else a condition fallback', () => {
    expect(new RoomJoinError('r@x', 'forbidden', 'auth', 'You are banned').message).toBe('You are banned')
    expect(new RoomJoinError('r@x', 'timeout').message).toBe('Room join failed: timeout')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/errors.test.ts`
Expected: FAIL — cannot find module `./errors`.

- [ ] **Step 3: Create the implementation**

Create `packages/fluux-sdk/src/core/errors.ts`:

```ts
/**
 * Error surfaced by {@link MUC.joinResult} when joining a MUC room fails.
 *
 * Carries the RFC 6120 §8.3 error condition so callers can react specifically:
 * prompt for a password on `not-authorized`, re-prompt the nickname on
 * `conflict`, explain `registration-required` / `forbidden`, etc.
 *
 * The synthetic condition `'timeout'` is used when the join receives no
 * response after the retry budget is exhausted (no server condition available).
 */
export class RoomJoinError extends Error {
  readonly roomJid: string
  /** RFC 6120 defined condition, e.g. 'not-authorized', 'conflict', or the synthetic 'timeout'. */
  readonly condition: string
  /** RFC 6120 error type, e.g. 'auth' | 'cancel' | 'modify' | 'wait', when available. */
  readonly errorType?: string
  /** Optional human-readable server text. */
  readonly text?: string

  constructor(roomJid: string, condition: string, errorType?: string, text?: string) {
    super(text || `Room join failed: ${condition}`)
    this.name = 'RoomJoinError'
    this.roomJid = roomJid
    this.condition = condition
    this.errorType = errorType
    this.text = text
    // Preserve the prototype chain so `instanceof RoomJoinError` works after
    // transpilation (TS targets that down-level class extends of Error).
    Object.setPrototypeOf(this, RoomJoinError.prototype)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/errors.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Export from the SDK index**

In `packages/fluux-sdk/src/index.ts`, find the block (around line 638):

```ts
// RFC 6120: XMPP Stanza Error parsing
export { parseXMPPError, formatXMPPError } from './utils/xmppError'
export type { XMPPStanzaError, XMPPErrorType } from './utils/xmppError'
```

Add immediately after it:

```ts
// MUC join failure error (rejected by client.muc.joinResult)
export { RoomJoinError } from './core/errors'
```

- [ ] **Step 6: Typecheck and commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger && npm run typecheck
git add packages/fluux-sdk/src/core/errors.ts packages/fluux-sdk/src/core/errors.test.ts packages/fluux-sdk/src/index.ts
git commit -m "feat(sdk): add RoomJoinError for MUC join failures"
```
Expected: typecheck passes; commit succeeds.

---

## Task 2: Join-outcome deferred + `joinResult()` + success/timeout settling (SDK)

This adds the outcome machinery: a per-room deferred created in `joinRoom`, resolved on self-presence (110), rejected on retry-exhaustion timeout, and read via the new public `joinResult()`. (Terminal *error* routing is Task 3.)

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/MUC.ts`
- Modify: `packages/fluux-sdk/src/core/modules/MUC.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/fluux-sdk/src/core/modules/MUC.test.ts`, add this describe block at the end of the top-level `describe('MUC', …)` (just before its closing `})`). It mirrors the existing `join timeout` block's setup (fake timers + console spies) and makes `queryRoomFeatures` deterministic via `mockSendIQ`:

```ts
  describe('joinResult - outcome surfacing', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      vi.useFakeTimers()
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // Make queryRoomFeatures resolve deterministically inside joinRoom.
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))
    })

    afterEach(() => {
      vi.useRealTimers()
      consoleErrorSpy.mockRestore()
    })

    it('resolves joinResult() on self-presence (status 110)', async () => {
      await muc.joinRoom('room@conference.example.org', 'mynick')
      const result = muc.joinResult('room@conference.example.org')

      const selfPresence = createMockElement('presence', { from: 'room@conference.example.org/mynick' }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'member', role: 'participant' } },
            { name: 'status', attrs: { code: '110' } },
          ],
        },
      ])
      muc.handle(selfPresence)

      await expect(result).resolves.toBeUndefined()
    })

    it('resolves immediately when there is no in-flight join', async () => {
      await expect(muc.joinResult('never@conference.example.org')).resolves.toBeUndefined()
    })

    it('rejects joinResult() with condition "timeout" after retries are exhausted', async () => {
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org',
        name: 'room',
        joined: false,
        isJoining: true,
        nickname: 'mynick',
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
      })

      await muc.joinRoom('room@conference.example.org', 'mynick')
      const result = muc.joinResult('room@conference.example.org')
      result.catch(() => {}) // avoid unhandled-rejection noise before we assert

      // First timeout retries, second gives up (MAX_JOIN_RETRIES = 1).
      await vi.advanceTimersByTimeAsync(30000)
      await vi.advanceTimersByTimeAsync(30000)

      await expect(result).rejects.toMatchObject({ condition: 'timeout' })
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MUC.test.ts -t "joinResult - outcome surfacing"`
Expected: FAIL — `muc.joinResult` is not a function.

- [ ] **Step 3: Import `RoomJoinError` into MUC.ts**

In `packages/fluux-sdk/src/core/modules/MUC.ts`, find (line ~39):

```ts
import { parseXMPPError, formatXMPPError, hasErrorCondition } from '../../utils/xmppError'
```

Add directly below it:

```ts
import { RoomJoinError } from '../errors'
```

- [ ] **Step 4: Add the `JoinDeferred` interface and map**

In `MUC.ts`, find the `PendingJoin` interface (lines ~101-106):

```ts
interface PendingJoin {
  timeoutId: ReturnType<typeof setTimeout>
  retryCount: number
  nickname: string
  options?: { maxHistory?: number; password?: string; isQuickChat?: boolean }
}
```

Add this interface immediately after it (before `export class MUC`):

```ts
/**
 * Awaitable outcome of an in-flight join, returned by {@link MUC.joinResult}.
 * Settled exactly once: resolved on self-presence (110), rejected on a terminal
 * error or after the retry budget is exhausted. Reused across timeout retries.
 */
interface JoinDeferred {
  promise: Promise<void>
  resolve: () => void
  reject: (err: RoomJoinError) => void
  settled: boolean
}
```

Then find the `pendingJoins` field (line ~110):

```ts
  /** Track pending room joins for timeout handling */
  private pendingJoins = new Map<string, PendingJoin>()
```

Add directly after it:

```ts
  /** Track the awaitable outcome of in-flight joins (see joinResult). */
  private joinDeferreds = new Map<string, JoinDeferred>()
```

- [ ] **Step 5: Add the deferred helpers and `joinResult()`**

In `MUC.ts`, find `clearPendingJoin` (lines ~307-317):

```ts
  /**
   * Clear a pending join timeout for a room.
   * Called when join succeeds, fails with error, or is manually cancelled.
   */
  private clearPendingJoin(roomJid: string): void {
    const pending = this.pendingJoins.get(roomJid)
    if (pending) {
      clearTimeout(pending.timeoutId)
      this.pendingJoins.delete(roomJid)
    }
  }
```

Add these methods immediately after it:

```ts
  /**
   * Get the in-flight join's outcome deferred, creating one if none is pending.
   * A retry (handleJoinTimeout re-invoking joinRoom) sees a still-pending
   * deferred and reuses it; a fresh join after a settled one replaces it.
   */
  private getOrCreateJoinDeferred(roomJid: string): JoinDeferred {
    const existing = this.joinDeferreds.get(roomJid)
    if (existing && !existing.settled) return existing

    let resolve!: () => void
    let reject!: (err: RoomJoinError) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    // Swallow rejection when nobody awaits joinResult (e.g. SDK-internal joins);
    // independent consumers still observe it via the returned promise.
    promise.catch(() => {})

    const deferred: JoinDeferred = { promise, resolve, reject, settled: false }
    this.joinDeferreds.set(roomJid, deferred)
    return deferred
  }

  private settleJoinSuccess(roomJid: string): void {
    const deferred = this.joinDeferreds.get(roomJid)
    if (deferred && !deferred.settled) {
      deferred.settled = true
      deferred.resolve()
    }
  }

  private settleJoinError(roomJid: string, error: RoomJoinError): void {
    const deferred = this.joinDeferreds.get(roomJid)
    if (deferred && !deferred.settled) {
      deferred.settled = true
      deferred.reject(error)
    }
  }

  /**
   * Await the outcome of an in-flight {@link joinRoom}.
   *
   * Resolves when the room confirms the join (self-presence, status 110) and
   * rejects with a {@link RoomJoinError} on a terminal error (password required,
   * nickname conflict, members-only, banned, …) or after the join times out.
   * Resolves immediately when there is no registered deferred for the room.
   *
   * @param roomJid - The room JID passed to joinRoom.
   */
  joinResult(roomJid: string): Promise<void> {
    return this.joinDeferreds.get(roomJid)?.promise ?? Promise.resolve()
  }
```

- [ ] **Step 6: Register the deferred in `joinRoom`**

In `MUC.ts`, find the "already joined" early return in `joinRoom` (lines ~447-451):

```ts
    // If already joined, don't send another presence (avoids leave/rejoin issues)
    if (existingRoom?.joined) {
      console.log('[MUC] Already in room, skipping join:', roomJid)
      return
    }
```

Add directly after that block:

```ts
    // Register (or reuse, on retry) the awaitable outcome for joinResult().
    this.getOrCreateJoinDeferred(roomJid)
```

- [ ] **Step 7: Resolve the deferred on successful self-presence**

In `MUC.ts`, find the self-presence success path in `handleMUCPresence` (lines ~224-226):

```ts
    if (isSelf) {
      // Clear the join timeout - we successfully joined
      this.clearPendingJoin(roomJid)
```

Change it to:

```ts
    if (isSelf) {
      // Clear the join timeout - we successfully joined
      this.clearPendingJoin(roomJid)
      this.settleJoinSuccess(roomJid)
```

- [ ] **Step 8: Reject the deferred when the join gives up after retries**

In `MUC.ts`, find the give-up branch of `handleJoinTimeout` (lines ~376-383):

```ts
    } else {
      // Max retries reached, give up
      logErr(`Room join timeout: ${roomJid} after ${MAX_JOIN_RETRIES} retries, giving up`)
      this.pendingJoins.delete(roomJid)
      this.pendingOccupants.delete(roomJid) // Clear buffered occupants on timeout
      // SDK event only - binding calls store.updateRoom
      this.deps.emitSDK('room:updated', { roomJid, updates: { isJoining: false, joined: false } })
    }
```

Change it to add the rejection:

```ts
    } else {
      // Max retries reached, give up
      logErr(`Room join timeout: ${roomJid} after ${MAX_JOIN_RETRIES} retries, giving up`)
      this.pendingJoins.delete(roomJid)
      this.pendingOccupants.delete(roomJid) // Clear buffered occupants on timeout
      // SDK event only - binding calls store.updateRoom
      this.deps.emitSDK('room:updated', { roomJid, updates: { isJoining: false, joined: false } })
      this.settleJoinError(roomJid, new RoomJoinError(roomJid, 'timeout'))
    }
```

- [ ] **Step 9: Reject pending deferreds on cleanup**

In `MUC.ts`, find `cleanup` (lines ~324-331):

```ts
  cleanup(): void {
    // Clear all pending join timeouts
    for (const pending of Array.from(this.pendingJoins.values())) {
      clearTimeout(pending.timeoutId)
    }
    this.pendingJoins.clear()
    this.pendingOccupants.clear()
  }
```

Change it to:

```ts
  cleanup(): void {
    // Clear all pending join timeouts
    for (const pending of Array.from(this.pendingJoins.values())) {
      clearTimeout(pending.timeoutId)
    }
    this.pendingJoins.clear()
    this.pendingOccupants.clear()
    // Reject any unresolved join outcomes so joinResult() awaiters don't hang.
    for (const [roomJid, deferred] of Array.from(this.joinDeferreds.entries())) {
      if (!deferred.settled) {
        deferred.settled = true
        deferred.reject(new RoomJoinError(roomJid, 'timeout'))
      }
    }
    this.joinDeferreds.clear()
  }
```

- [ ] **Step 10: Run the new tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MUC.test.ts -t "joinResult - outcome surfacing"`
Expected: PASS (3 tests).

- [ ] **Step 11: Run the whole MUC suite to confirm no regressions**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MUC.test.ts`
Expected: PASS (all pre-existing join/timeout/error tests still green — `joinRoom()` semantics are unchanged).

- [ ] **Step 12: Commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger
git add packages/fluux-sdk/src/core/modules/MUC.ts packages/fluux-sdk/src/core/modules/MUC.test.ts
git commit -m "feat(sdk): add MUC.joinResult outcome promise (resolve on 110, reject on timeout)"
```

---

## Task 3: Route join-error presences → reject `joinResult()` (SDK)

Join-error presences echo `<x muc>` (or nothing), missing the `muc#user` gate in `handle()`, so they're dropped. Route them — when a join is in flight — through a single `failJoin` helper that logs, emits the existing cleanup, and rejects the deferred. Crucially this also **clears the join timeout, stopping the pointless retry** on terminal auth/conflict/forbidden errors.

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/MUC.ts`
- Modify: `packages/fluux-sdk/src/core/modules/MUC.test.ts`

- [ ] **Step 1: Write the failing tests**

In `MUC.test.ts`, inside the `describe('joinResult - outcome surfacing', …)` block added in Task 2, add these tests:

```ts
    it('rejects joinResult() with not-authorized for an <x muc> error presence', async () => {
      await muc.joinRoom('room@conference.example.org', 'mynick')
      const result = muc.joinResult('room@conference.example.org')

      // Realistic join error: echoes the muc (request) namespace, NOT muc#user.
      const errorPresence = createMockElement('presence', {
        from: 'room@conference.example.org/mynick',
        type: 'error',
      }, [
        { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc' } },
        {
          name: 'error',
          attrs: { type: 'auth' },
          children: [
            { name: 'not-authorized', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])
      const handled = muc.handle(errorPresence)

      expect(handled).toBe(true)
      await expect(result).rejects.toMatchObject({ condition: 'not-authorized', errorType: 'auth' })
    })

    it('rejects joinResult() with conflict for an error presence carrying no <x>', async () => {
      await muc.joinRoom('room@conference.example.org', 'mynick')
      const result = muc.joinResult('room@conference.example.org')

      const errorPresence = createMockElement('presence', {
        from: 'room@conference.example.org/mynick',
        type: 'error',
      }, [
        {
          name: 'error',
          attrs: { type: 'cancel' },
          children: [
            { name: 'conflict', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])
      muc.handle(errorPresence)

      await expect(result).rejects.toMatchObject({ condition: 'conflict' })
    })

    it('does NOT retry after a terminal join error (clears the timeout)', async () => {
      await muc.joinRoom('room@conference.example.org', 'mynick')
      const result = muc.joinResult('room@conference.example.org')
      mockSendStanza.mockClear()

      const errorPresence = createMockElement('presence', {
        from: 'room@conference.example.org/mynick',
        type: 'error',
      }, [
        {
          name: 'error',
          attrs: { type: 'auth' },
          children: [
            { name: 'not-authorized', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])
      muc.handle(errorPresence)
      await expect(result).rejects.toMatchObject({ condition: 'not-authorized' })

      // Advancing well past the 30s timeout must NOT re-send a join presence.
      await vi.advanceTimersByTimeAsync(60000)
      expect(mockSendStanza).not.toHaveBeenCalled()
    })

    it('ignores an error presence for a room with no in-flight join', async () => {
      const errorPresence = createMockElement('presence', {
        from: 'stale@conference.example.org/mynick',
        type: 'error',
      }, [
        {
          name: 'error',
          attrs: { type: 'auth' },
          children: [
            { name: 'forbidden', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])
      const handled = muc.handle(errorPresence)
      expect(handled).toBe(false)
    })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MUC.test.ts -t "joinResult - outcome surfacing"`
Expected: FAIL — the `<x muc>` / no-`<x>` error presences are not routed (handle returns false / result never rejects).

- [ ] **Step 3: Add the `failJoin` helper**

In `MUC.ts`, add this method directly after `settleJoinError` (added in Task 2):

```ts
  /**
   * Handle a presence error that fails an in-flight join: log, clear timers,
   * emit the room state cleanup, and reject the joinResult() outcome.
   */
  private failJoin(stanza: Element, roomJid: string): void {
    const error = parseXMPPError(stanza)
    console.error(`[MUC] Room error for ${roomJid}: ${error ? formatXMPPError(error) : 'unknown'}`)
    this.clearPendingJoin(roomJid) // stops the retry on terminal errors
    this.pendingOccupants.delete(roomJid)
    // SDK event only - binding calls store.updateRoom
    this.deps.emitSDK('room:updated', { roomJid, updates: { joined: false, isJoining: false } })
    this.settleJoinError(
      roomJid,
      new RoomJoinError(roomJid, error?.condition ?? 'undefined-condition', error?.type, error?.text)
    )
  }
```

- [ ] **Step 4: Route `<x muc>` / no-`<x>` error presences in `handle()`**

In `MUC.ts`, find `handle` (lines ~128-137):

```ts
  handle(stanza: Element): boolean | void {
    if (stanza.is('presence')) {
      const mucUser = stanza.getChild('x', NS_MUC_USER)
      if (mucUser) {
        this.handleMUCPresence(stanza, mucUser)
        return true
      }
    }
    return false
  }
```

Change it to:

```ts
  handle(stanza: Element): boolean | void {
    if (stanza.is('presence')) {
      const mucUser = stanza.getChild('x', NS_MUC_USER)
      if (mucUser) {
        this.handleMUCPresence(stanza, mucUser)
        return true
      }
      // Join-error presences echo <x muc> (or nothing), not muc#user, so they
      // miss the gate above. Route them to fail the in-flight join.
      if (stanza.attrs.type === 'error') {
        const roomJid = getBareJid(stanza.attrs.from ?? '')
        if (roomJid && this.pendingJoins.has(roomJid)) {
          this.failJoin(stanza, roomJid)
          return true
        }
      }
    }
    return false
  }
```

- [ ] **Step 5: Route error presences that DO carry `muc#user`**

Some servers echo `muc#user` on errors; those reach `handleMUCPresence`. Update the two error branches there to funnel into `failJoin`.

Find the no-nick branch (lines ~147-158):

```ts
    if (!nick) {
      // Room-level presence (e.g. error)
      if (type === 'error') {
        const error = parseXMPPError(stanza)
        console.error(`[MUC] Room error for ${roomJid}: ${error ? formatXMPPError(error) : 'unknown'}`)
        this.clearPendingJoin(roomJid)
        this.pendingOccupants.delete(roomJid) // Clear buffered occupants on error
        // SDK event only - binding calls store.updateRoom
        this.deps.emitSDK('room:updated', { roomJid, updates: { joined: false, isJoining: false } })
      }
      return
    }
```

Change it to:

```ts
    if (!nick) {
      // Room-level presence (e.g. error)
      if (type === 'error') {
        this.failJoin(stanza, roomJid)
      }
      return
    }
```

Then find the nick-level error branch (lines ~160-163):

```ts
    if (type === 'error') {
      console.error(`[MUC] Presence error for ${from}`)
      return
    }
```

Change it to:

```ts
    if (type === 'error') {
      if (this.pendingJoins.has(roomJid)) {
        this.failJoin(stanza, roomJid)
      } else {
        console.error(`[MUC] Presence error for ${from}`)
      }
      return
    }
```

> Note: `failJoin` reproduces the no-nick branch's previous behavior exactly (same `console.error` string, `clearPendingJoin`, `pendingOccupants.delete`, and `room:updated` emit) and only *adds* the deferred rejection, so the existing `clears isJoining on room error` / `logs formatted error message…` / `logs "unknown"…` tests stay green.

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MUC.test.ts -t "joinResult - outcome surfacing"`
Expected: PASS (7 tests total in the block).

- [ ] **Step 7: Run the full MUC suite + the whole SDK suite**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MUC.test.ts`
Expected: PASS (including the pre-existing error/timeout tests).

Run: `cd packages/fluux-sdk && npx vitest run`
Expected: PASS, no stderr from unhandled rejections.

- [ ] **Step 8: Commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger
git add packages/fluux-sdk/src/core/modules/MUC.ts packages/fluux-sdk/src/core/modules/MUC.test.ts
git commit -m "fix(sdk): route MUC join-error presences and reject joinResult with the condition"
```

---

## Task 4: Expose `joinResult` on the `useRoomActions` hook (SDK)

**Files:**
- Modify: `packages/fluux-sdk/src/hooks/useRoomActions.ts`

- [ ] **Step 1: Add the `joinResult` action**

In `packages/fluux-sdk/src/hooks/useRoomActions.ts`, find the `joinRoom` callback (lines ~46-51):

```ts
  const joinRoom = useCallback(
    async (roomJid: string, nickname: string, options?: { maxHistory?: number; password?: string }) => {
      await client.muc.joinRoom(roomJid, nickname, options)
    },
    [client]
  )
```

Add directly after it:

```ts
  const joinResult = useCallback(
    async (roomJid: string): Promise<void> => {
      await client.muc.joinResult(roomJid)
    },
    [client]
  )
```

- [ ] **Step 2: Include `joinResult` in the returned actions object**

`useRoomActions` returns its actions in a `useMemo`. Find the returned object that contains `joinRoom` (there are two occurrences of `joinRoom,` in the file — the one inside the returned object literal, around line 380, and its `useMemo` dependency array around line 428). Add `joinResult,` next to `joinRoom,` in **both** the returned object and the dependency array:

In the returned object (around line 380):

```ts
      joinRoom,
      joinResult,
```

In the `useMemo` dependency array (around line 428):

```ts
      joinRoom,
      joinResult,
```

> `useRoom` and `useRoomActive` also expose `joinRoom`, but the modal consumes `useRoomActions`; leave the other two hooks unchanged (YAGNI — add `joinResult` there only if a future consumer needs it).

- [ ] **Step 3: Build the SDK and typecheck**

```bash
cd /Users/mremond/AIProjects/fluux-messenger
npm run build:sdk
npm run typecheck
```
Expected: build succeeds; typecheck passes. (`packages/fluux-sdk/dist` is gitignored and rebuilt on demand — the app now resolves `RoomJoinError` and `joinResult` from it. Do not commit `dist`.)

- [ ] **Step 4: Commit (source only — `dist` is gitignored)**

```bash
git add packages/fluux-sdk/src/hooks/useRoomActions.ts
git commit -m "feat(sdk): expose joinResult on useRoomActions"
```

---

## Task 5: English i18n keys

**Files:**
- Modify: `apps/fluux/src/i18n/locales/en.json`

- [ ] **Step 1: Add the keys**

In `apps/fluux/src/i18n/locales/en.json`, find the `rooms.failedToJoinRoom` line (~203):

```json
        "failedToJoinRoom": "Failed to join room",
```

Add these 10 keys immediately after it (keep the trailing comma on `failedToJoinRoom`):

```json
        "passwordProtected": "This room is password-protected",
        "roomPassword": "Password",
        "passwordRequired": "This room is password-protected. Enter the password to join.",
        "incorrectPassword": "Incorrect password.",
        "nicknameInUse": "That nickname is already in use in this room.",
        "membersOnly": "This room is members-only — you need to be a member to join.",
        "banned": "You've been banned from this room.",
        "roomFull": "This room is full.",
        "registeredNicknameRequired": "This room requires your registered nickname.",
        "roomNotFound": "Room not found.",
```

- [ ] **Step 2: Validate JSON**

Run: `cd /Users/mremond/AIProjects/fluux-messenger && node -e "JSON.parse(require('fs').readFileSync('apps/fluux/src/i18n/locales/en.json','utf8')); console.log('en.json OK')"`
Expected: `en.json OK`.

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/i18n/locales/en.json
git commit -m "i18n(en): add room join error + password strings"
```

---

## Task 6: Modal — password field + condition→UX mapping

**Files:**
- Modify: `apps/fluux/src/components/JoinRoomModal.tsx`
- Modify: `apps/fluux/src/components/JoinRoomModal.test.tsx`

- [ ] **Step 1: Update the test mock to include `joinResult` and `RoomJoinError`**

In `JoinRoomModal.test.tsx`, the existing `vi.mock('@fluux/sdk', …)` returns only `useConnection` and `useRoomActions` (it does **not** spread the real module), so the component's `import { RoomJoinError }` would be `undefined`. Define a local `RoomJoinError` class and wire both the new hook action and the export.

Replace the top mock setup (lines 6-21):

```ts
// Mock the SDK hooks
const mockJoinRoom = vi.fn()
const mockSetActiveRoom = vi.fn()
const mockSetActiveConversation = vi.fn()
let mockUserJid = 'testuser@example.com'
let mockOwnNickname: string | null = null

vi.mock('@fluux/sdk', () => ({
  useConnection: () => ({
    jid: mockUserJid,
    ownNickname: mockOwnNickname,
  }),
  useRoomActions: () => ({
    joinRoom: mockJoinRoom,
    setActiveRoom: mockSetActiveRoom,
  }),
}))
```

with:

```ts
// Mock the SDK hooks
const mockJoinRoom = vi.fn()
const mockJoinResult = vi.fn()
const mockSetActiveRoom = vi.fn()
const mockSetActiveConversation = vi.fn()
let mockUserJid = 'testuser@example.com'
let mockOwnNickname: string | null = null

// Minimal stand-in for the SDK's RoomJoinError so `instanceof` works in the
// component (which imports it from the mocked '@fluux/sdk').
class RoomJoinError extends Error {
  constructor(
    public roomJid: string,
    public condition: string,
    public errorType?: string,
    public text?: string,
  ) {
    super(text || `Room join failed: ${condition}`)
    this.name = 'RoomJoinError'
  }
}

vi.mock('@fluux/sdk', () => ({
  useConnection: () => ({
    jid: mockUserJid,
    ownNickname: mockOwnNickname,
  }),
  useRoomActions: () => ({
    joinRoom: mockJoinRoom,
    joinResult: mockJoinResult,
    setActiveRoom: mockSetActiveRoom,
  }),
  RoomJoinError,
}))
```

Then in the `beforeEach` (lines 45-49), default `joinResult` to resolve so existing success-path tests keep passing. Replace:

```ts
  beforeEach(() => {
    vi.clearAllMocks()
    mockUserJid = 'testuser@example.com'
    mockOwnNickname = null
  })
```

with:

```ts
  beforeEach(() => {
    vi.clearAllMocks()
    mockUserJid = 'testuser@example.com'
    mockOwnNickname = null
    mockJoinResult.mockResolvedValue(undefined)
  })
```

- [ ] **Step 2: Update existing call-assertion tests for the third `joinRoom` arg**

The modal will now call `joinRoom(jid, nick, options)` where `options` is `undefined` when no password is entered. Update the three existing `toHaveBeenCalledWith` assertions to include the third argument.

Line ~175 — change:
```ts
        expect(mockJoinRoom).toHaveBeenCalledWith('myroom@conference.example.com', 'testuser')
```
to:
```ts
        expect(mockJoinRoom).toHaveBeenCalledWith('myroom@conference.example.com', 'testuser', undefined)
```

Line ~188 — change:
```ts
        expect(mockJoinRoom).toHaveBeenCalledWith('room@conference.example.com', 'MyNick')
```
to:
```ts
        expect(mockJoinRoom).toHaveBeenCalledWith('room@conference.example.com', 'MyNick', undefined)
```

Line ~203 — change:
```ts
        expect(mockJoinRoom).toHaveBeenCalledWith('chatroom@muc.example.com', 'Alice')
```
to:
```ts
        expect(mockJoinRoom).toHaveBeenCalledWith('chatroom@muc.example.com', 'Alice', undefined)
```

- [ ] **Step 3: Write the failing tests for the new behavior**

Add this describe block inside the top-level `describe('JoinRoomModal', …)` (e.g. after the `form submission` block):

```ts
  describe('join error handling', () => {
    const fillRoom = () => {
      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), {
        target: { value: 'room@conference.example.com' },
      })
    }

    it('reveals and focuses the password field on not-authorized (password required)', async () => {
      mockJoinResult.mockRejectedValue(new RoomJoinError('room@conference.example.com', 'not-authorized', 'auth'))
      render(<JoinRoomModal onClose={mockOnClose} />)
      fillRoom()
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText('rooms.passwordRequired')).toBeInTheDocument()
      })
      const passwordInput = screen.getByLabelText('rooms.roomPassword')
      expect(passwordInput).toBeInTheDocument()
      await waitFor(() => expect(passwordInput).toHaveFocus())
      expect(mockOnClose).not.toHaveBeenCalled()
    })

    it('shows "incorrect password" when a password was already supplied', async () => {
      mockJoinResult.mockRejectedValue(new RoomJoinError('room@conference.example.com', 'not-authorized', 'auth'))
      render(<JoinRoomModal onClose={mockOnClose} />)
      fillRoom()

      // Reveal the password field via the toggle, type a password, submit.
      fireEvent.click(screen.getByText('rooms.passwordProtected'))
      fireEvent.change(screen.getByLabelText('rooms.roomPassword'), { target: { value: 'wrongpass' } })
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText('rooms.incorrectPassword')).toBeInTheDocument()
      })
    })

    it('passes the password to joinRoom when supplied', async () => {
      mockJoinRoom.mockResolvedValue(undefined)
      render(<JoinRoomModal onClose={mockOnClose} />)
      fillRoom()
      fireEvent.click(screen.getByText('rooms.passwordProtected'))
      fireEvent.change(screen.getByLabelText('rooms.roomPassword'), { target: { value: 's3cret' } })
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(mockJoinRoom).toHaveBeenCalledWith('room@conference.example.com', 'testuser', { password: 's3cret' })
      })
    })

    it('shows a nickname-conflict message and focuses the nickname field on conflict', async () => {
      mockJoinResult.mockRejectedValue(new RoomJoinError('room@conference.example.com', 'conflict', 'cancel'))
      render(<JoinRoomModal onClose={mockOnClose} />)
      fillRoom()
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText('rooms.nicknameInUse')).toBeInTheDocument()
      })
      await waitFor(() => expect(screen.getByLabelText('rooms.nickname')).toHaveFocus())
    })

    it.each([
      ['registration-required', 'rooms.membersOnly'],
      ['forbidden', 'rooms.banned'],
      ['service-unavailable', 'rooms.roomFull'],
      ['not-acceptable', 'rooms.registeredNicknameRequired'],
      ['item-not-found', 'rooms.roomNotFound'],
    ])('maps condition %s to message %s', async (condition, messageKey) => {
      mockJoinResult.mockRejectedValue(new RoomJoinError('room@conference.example.com', condition))
      render(<JoinRoomModal onClose={mockOnClose} />)
      fillRoom()
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText(messageKey)).toBeInTheDocument()
      })
      expect(mockOnClose).not.toHaveBeenCalled()
    })

    it('falls back to the server text for an unmapped condition', async () => {
      mockJoinResult.mockRejectedValue(
        new RoomJoinError('room@conference.example.com', 'resource-constraint', 'wait', 'Try later'),
      )
      render(<JoinRoomModal onClose={mockOnClose} />)
      fillRoom()
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText('Try later')).toBeInTheDocument()
      })
    })
  })
```

- [ ] **Step 4: Run the new tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/JoinRoomModal.test.tsx -t "join error handling"`
Expected: FAIL — no password field / toggle, error mapping not implemented.

- [ ] **Step 5: Rewrite `JoinRoomModal.tsx`**

Replace the entire contents of `apps/fluux/src/components/JoinRoomModal.tsx` with:

```tsx
import { useState, useRef, useEffect } from 'react'
import { TextInput } from './ui/TextInput'
import { useTranslation } from 'react-i18next'
import { useConnection, useRoomActions, RoomJoinError } from '@fluux/sdk'
import { useChatStore } from '@fluux/sdk/react'
import { useModalInput } from '@/hooks'
import { ModalShell } from './ModalShell'

interface JoinRoomModalProps {
  onClose: () => void
}

export function JoinRoomModal({ onClose }: JoinRoomModalProps) {
  const { t } = useTranslation()
  const { jid: userJid, ownNickname } = useConnection()
  const { joinRoom, joinResult, setActiveRoom } = useRoomActions()
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const [roomJid, setRoomJid] = useState('')
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [focusTarget, setFocusTarget] = useState<'password' | 'nickname' | null>(null)
  const inputRef = useModalInput<HTMLInputElement>()
  const nicknameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const nicknameInitialized = useRef(false)

  // Default nickname from PEP nickname or user JID (only once)
  useEffect(() => {
    if (!nicknameInitialized.current) {
      if (ownNickname) {
        setNickname(ownNickname)
        nicknameInitialized.current = true
      } else if (userJid) {
        setNickname(userJid.split('@')[0])
        nicknameInitialized.current = true
      }
    }
  }, [ownNickname, userJid])

  // Move focus after an error reveals/targets a field (runs post-render so the
  // password input exists when we focus it).
  useEffect(() => {
    if (focusTarget === 'password') passwordRef.current?.focus()
    else if (focusTarget === 'nickname') nicknameRef.current?.focus()
    if (focusTarget) setFocusTarget(null)
  }, [focusTarget])

  const showJoinError = (err: unknown, passwordWasSent: boolean) => {
    if (err instanceof RoomJoinError) {
      switch (err.condition) {
        case 'not-authorized':
          setShowPassword(true)
          setFocusTarget('password')
          setError(t(passwordWasSent ? 'rooms.incorrectPassword' : 'rooms.passwordRequired'))
          return
        case 'conflict':
          setFocusTarget('nickname')
          setError(t('rooms.nicknameInUse'))
          return
        case 'registration-required':
          setError(t('rooms.membersOnly'))
          return
        case 'forbidden':
          setError(t('rooms.banned'))
          return
        case 'service-unavailable':
          setError(t('rooms.roomFull'))
          return
        case 'not-acceptable':
          setError(t('rooms.registeredNicknameRequired'))
          return
        case 'item-not-found':
          setError(t('rooms.roomNotFound'))
          return
        default:
          setError(err.text || t('rooms.failedToJoinRoom'))
          return
      }
    }
    setError(err instanceof Error ? err.message : t('rooms.failedToJoinRoom'))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedRoomJid = roomJid.trim()
    const trimmedNickname = nickname.trim()
    const trimmedPassword = password.trim()

    if (!trimmedRoomJid) {
      setError(t('rooms.pleaseEnterRoomAddress'))
      return
    }

    // Basic room JID validation
    if (!trimmedRoomJid.includes('@')) {
      setError(t('rooms.invalidRoomAddress'))
      return
    }

    if (!trimmedNickname) {
      setError(t('rooms.pleaseEnterNickname'))
      return
    }

    const passwordWasSent = trimmedPassword.length > 0
    setJoining(true)
    try {
      await joinRoom(trimmedRoomJid, trimmedNickname, passwordWasSent ? { password: trimmedPassword } : undefined)
      await joinResult(trimmedRoomJid)
      void setActiveConversation(null)
      void setActiveRoom(trimmedRoomJid)
      onClose()
    } catch (err) {
      showJoinError(err, passwordWasSent)
    } finally {
      setJoining(false)
    }
  }

  return (
    <ModalShell title={t('rooms.joinRoomTitle')} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        <div>
          <label htmlFor="room-jid" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('rooms.roomAddress')}
          </label>
          <TextInput
            ref={inputRef}
            id="room-jid"
            type="text"
            value={roomJid}
            onChange={(e) => setRoomJid(e.target.value)}
            placeholder={t('rooms.roomAddressPlaceholder')}
            disabled={joining}
            className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                       border border-transparent focus:border-fluux-brand
                       placeholder:text-fluux-muted disabled:opacity-50"
          />
        </div>

        <div>
          <label htmlFor="room-nickname" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('rooms.nickname')}
          </label>
          <TextInput
            ref={nicknameRef}
            id="room-nickname"
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder={t('rooms.nicknamePlaceholder')}
            disabled={joining}
            className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                       border border-transparent focus:border-fluux-brand
                       placeholder:text-fluux-muted disabled:opacity-50"
          />
        </div>

        {showPassword ? (
          <div>
            <label htmlFor="room-password" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
              {t('rooms.roomPassword')}
            </label>
            <TextInput
              ref={passwordRef}
              id="room-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={joining}
              className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                         border border-transparent focus:border-fluux-brand
                         placeholder:text-fluux-muted disabled:opacity-50"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setShowPassword(true)
              setFocusTarget('password')
            }}
            className="text-xs text-fluux-brand hover:underline"
          >
            {t('rooms.passwordProtected')}
          </button>
        )}

        {error && (
          <p className="text-sm text-fluux-red">{error}</p>
        )}
        <p className="text-xs text-fluux-muted">
          {t('rooms.joinRoomHint')}
        </p>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 text-fluux-text bg-fluux-bg rounded hover:bg-fluux-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={joining || !roomJid.trim() || !nickname.trim()}
            className="flex-1 px-4 py-2 text-fluux-text-on-accent bg-fluux-brand rounded hover:bg-fluux-brand/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {joining ? t('rooms.joining') : t('rooms.joinRoom')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
```

- [ ] **Step 6: Run the modal test file to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/JoinRoomModal.test.tsx`
Expected: PASS (existing + new `join error handling` tests).

- [ ] **Step 7: Typecheck and commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger && npm run typecheck
git add apps/fluux/src/components/JoinRoomModal.tsx apps/fluux/src/components/JoinRoomModal.test.tsx
git commit -m "feat(app): room password field + join-error UX in JoinRoomModal"
```

---

## Task 7: Translate the new keys into the other 32 locales

Per project convention, new i18n keys must be translated into every locale (no English placeholders). The locale files are `apps/fluux/src/i18n/locales/<code>.json` for: `ar be bg ca cs da de el es et fi fr ga he hr hu is it lt lv mt nb nl pl pt ro ru sk sl sv uk zh-CN` (32 besides `en`).

**Files:**
- Modify: each `apps/fluux/src/i18n/locales/<code>.json` (32 files)

- [ ] **Step 1: Add the 10 keys to every non-English locale**

For each file, add the same 10 keys directly after that file's `"failedToJoinRoom"` entry inside the `rooms` object, with values **translated into that language** (do not copy the English). Match each file's existing indentation. The keys (English source) are:

```
passwordProtected            "This room is password-protected"
roomPassword                 "Password"
passwordRequired             "This room is password-protected. Enter the password to join."
incorrectPassword            "Incorrect password."
nicknameInUse                "That nickname is already in use in this room."
membersOnly                  "This room is members-only — you need to be a member to join."
bannedFromRoom               "You've been banned from this room."
roomFull                     "This room is full."
registeredNicknameRequired   "This room requires your registered nickname."
roomNotFound                 "Room not found."
```

Reference translations for three locales (produce the analogous quality for the rest):

French (`fr.json`):
```json
        "passwordProtected": "Ce salon est protégé par un mot de passe",
        "roomPassword": "Mot de passe",
        "passwordRequired": "Ce salon est protégé par un mot de passe. Saisissez-le pour rejoindre.",
        "incorrectPassword": "Mot de passe incorrect.",
        "nicknameInUse": "Ce surnom est déjà utilisé dans ce salon.",
        "membersOnly": "Ce salon est réservé aux membres — vous devez en être membre pour le rejoindre.",
        "bannedFromRoom": "Vous avez été banni de ce salon.",
        "roomFull": "Ce salon est complet.",
        "registeredNicknameRequired": "Ce salon exige votre surnom enregistré.",
        "roomNotFound": "Salon introuvable.",
```

German (`de.json`):
```json
        "passwordProtected": "Dieser Raum ist passwortgeschützt",
        "roomPassword": "Passwort",
        "passwordRequired": "Dieser Raum ist passwortgeschützt. Gib das Passwort ein, um beizutreten.",
        "incorrectPassword": "Falsches Passwort.",
        "nicknameInUse": "Dieser Spitzname wird in diesem Raum bereits verwendet.",
        "membersOnly": "Dieser Raum ist nur für Mitglieder — du musst Mitglied sein, um beizutreten.",
        "bannedFromRoom": "Du wurdest aus diesem Raum verbannt.",
        "roomFull": "Dieser Raum ist voll.",
        "registeredNicknameRequired": "Dieser Raum erfordert deinen registrierten Spitznamen.",
        "roomNotFound": "Raum nicht gefunden.",
```

Spanish (`es.json`):
```json
        "passwordProtected": "Esta sala está protegida con contraseña",
        "roomPassword": "Contraseña",
        "passwordRequired": "Esta sala está protegida con contraseña. Introdúcela para unirte.",
        "incorrectPassword": "Contraseña incorrecta.",
        "nicknameInUse": "Ese apodo ya está en uso en esta sala.",
        "membersOnly": "Esta sala es solo para miembros: debes ser miembro para unirte.",
        "bannedFromRoom": "Has sido expulsado de esta sala.",
        "roomFull": "Esta sala está llena.",
        "registeredNicknameRequired": "Esta sala requiere tu apodo registrado.",
        "roomNotFound": "Sala no encontrada.",
```

- [ ] **Step 2: Validate every locale parses as JSON**

Run:
```bash
cd /Users/mremond/AIProjects/fluux-messenger && node -e "
const fs=require('fs'),d='apps/fluux/src/i18n/locales';
let bad=0;
for (const f of fs.readdirSync(d).filter(f=>f.endsWith('.json'))) {
  try {
    const j=JSON.parse(fs.readFileSync(d+'/'+f,'utf8'));
    const miss=['passwordProtected','roomPassword','passwordRequired','incorrectPassword','nicknameInUse','membersOnly','bannedFromRoom','roomFull','registeredNicknameRequired','roomNotFound'].filter(k=>!(k in (j.rooms||{})));
    if (miss.length) { console.log(f,'MISSING',miss.join(',')); bad++; }
  } catch(e) { console.log(f,'PARSE ERROR',e.message); bad++; }
}
console.log(bad===0?'ALL LOCALES OK':(bad+' file(s) with issues'));
"
```
Expected: `ALL LOCALES OK`.

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/i18n/locales/
git commit -m "i18n: translate room join error + password strings (32 locales)"
```

---

## Task 8: Full verification

- [ ] **Step 1: Typecheck, lint, and run the full test suites**

```bash
cd /Users/mremond/AIProjects/fluux-messenger
npm run build:sdk
npm run typecheck
npm run lint
npm test
```
Expected: typecheck clean, lint clean, all tests pass with no stderr (no unhandled rejections from the new deferred path).

- [ ] **Step 2: Push the branch and open a PR**

```bash
git push -u origin feat/muc-join-errors
gh pr create --title "MUC join error handling + room password UI" --body "Surfaces password-required, nickname-conflict, members-only, banned, full, and not-found join failures in JoinRoomModal, and adds a room-password field (optional upfront + auto-revealed on not-authorized). SDK: routes join-error presences (which miss the muc#user gate) and adds client.muc.joinResult(jid) — a typed RoomJoinError outcome promise — leaving joinRoom() and its other callers unchanged. Stops the pointless retry loop on terminal join errors. Closes UX_REVIEW item 5.3."
```

---

## Self-Review notes

- **Spec coverage:** error routing (Task 3) ✓; `joinResult`/`RoomJoinError` (Tasks 1-2) ✓; modal password upfront-toggle + reveal-on-401 + condition→UX table (Task 6) ✓; no-retry-on-terminal (Task 3 test) ✓; i18n EN + 32 locales (Tasks 5, 7) ✓; SDK + modal tests ✓.
- **`joinRoom()` unchanged:** existing 6 callers and ~12 SDK join tests untouched (only additive settling), matching the spec's revised approach.
- **Type consistency:** `RoomJoinError(roomJid, condition, errorType?, text?)`; fields `roomJid`/`condition`/`errorType`/`text`; `joinResult(roomJid): Promise<void>`; modal switches on `err.condition` — consistent across Tasks 1, 2, 3, 4, 6.
- **Known minor edge (acceptable):** if `queryRoomFeatures`/`sendStanza` throw synchronously inside `joinRoom`, the just-registered deferred is left pending until the next join/`cleanup()`; `joinRoom()` itself rejects so the modal still shows a generic error. Not worth extra machinery (YAGNI).
