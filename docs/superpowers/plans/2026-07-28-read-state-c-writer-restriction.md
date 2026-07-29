# Read-state PR C: writer restriction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the read pointer's writers to the design's set, deleting three heuristic
writer classes (outgoing-message inference, activation snap, MAM outgoing-boundary advance)
without ever widening pointer movement except where a persisted `archiveOrderKey` proves the
position.

**Architecture:** All decision logic stays in the pure `stores/shared` modules
(`readPointer.ts`, `readState.ts`, `notificationState.ts`, `readMarkerSync.ts`); the stores
only fan the results into their maps. The `(timestamp, archiveOrderKey)` total order that PR B
introduced for *counting* becomes the single order used by the pointer side too, so divider,
count and pointer can no longer disagree about what "after" means.

**Tech Stack:** TypeScript, Zustand vanilla stores, Vitest, `fake-indexeddb`, Playwright
(`test:scroll`).

**Spec:** `docs/superpowers/specs/2026-07-28-read-state-c-writer-restriction-design.md` —
authoritative. Where this plan and the spec disagree, the spec wins; raise the conflict rather
than guessing.

## Global Constraints

- **The read pointer is forward-only and an erroneous advance is unrecoverable.** Every
  ambiguous edge resolves toward MORE unread, never less.
- **A same-millisecond tie may only be broken when BOTH positions carry an `archiveOrderKey`.**
  If either side lacks one, fall back to strict millisecond comparison. Never call
  `compareOrder` with a possibly-keyless pair on the pointer side: its "missing key sorts
  first" rule is safe for a *floor* and unsafe for a *pointer*.
- **Archive recounts must never write `mentionsCount`.**
- **Never relax an existing assertion to make a test pass.** A pre-existing test that fails is
  a signal to investigate and report, not to edit.
- **No hollow tests.** Every control gets a deliberate break that you actually run and watch
  fail, and you quote the failure in your report. Never seed `0` and assert `0`. Never verify a
  behaviour change by grep alone — see Task 5, where the guard is a test, not a search.
- **Never `git stash`.** The stash stack is shared across every worktree of this repo and holds
  other branches' work.
- **Never `git checkout` / `switch` / `reset`.** Stay on the current branch.
- Run the full suite from the **repo root** (`npm test`), never from inside
  `packages/fluux-sdk` — the Bash cwd persists between calls and would silently run only the
  SDK half.
- Commits are SSH-signed. No AI/Claude/Codex footers or co-author trailers, English only.
- Focused SDK tests: `cd packages/fluux-sdk && npx vitest run <path>`.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `packages/fluux-sdk/src/stores/shared/readPointer.ts` | `ReadPointer`, `isAhead`, `advance`, (de)serialization | 1 |
| `packages/fluux-sdk/src/stores/shared/readState.ts` | `compareOrder`, `computeFloor`, `makeArchiveOrderKey`, renderability re-export | read-only in this PR |
| `packages/fluux-sdk/src/stores/shared/notificationState.ts` | Pure notification transitions | 2, 4, 5, 6, 8 |
| `packages/fluux-sdk/src/stores/shared/readMarkerSync.ts` | XEP-0490 resolution | 3, 5 |
| `packages/fluux-sdk/src/stores/chatStore.ts` / `roomStore.ts` | Map fan-out only | 2, 5, 6, 8 |
| `packages/fluux-sdk/src/utils/mamCatchUpUtils.ts` | MAM sizing constants | 6 |
| `packages/fluux-sdk/src/core/mdsSideEffects.ts` | XEP-0490 publisher (comment only) | 7 |
| `apps/fluux/src/utils/newMessagesMarker.ts` | Dead code | 8 (delete) |

**Deviation from the spec's task order, deliberate:** the spec lists `historyFloor` plumbing
and the `onActivate` scan as separate tasks. They are merged into **Task 5**. A plumbing-only
task has no consumer yet, so its only possible test would spy on a call argument — pinning
implementation rather than behaviour, which is the hollow-test shape this codebase keeps
producing. Merged, the store-level controls bite immediately.

---

### Task 1: Align `isAhead` to the total order, with a keyless fallback

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/readPointer.ts` (`isAhead`, ~line 89)
- Test: `packages/fluux-sdk/src/stores/shared/readPointer.test.ts`

**Interfaces:**
- Consumes: `compareOrder`, `type OrderPosition` from `./readState`.
- Produces: `isAhead(candidate: ReadPointer, current: ReadPointer | undefined): boolean` —
  unchanged signature. Tasks 3 and 4 rely on the same key-presence rule but call `compareOrder`
  directly; they do NOT call `isAhead`.

`readPointer.ts` already imports from `readState.ts`, and `readState.ts` imports only
`type ReadPointer` back, so adding a value import creates no runtime cycle.

- [ ] **Step 1: Write the failing tests**

Append to `packages/fluux-sdk/src/stores/shared/readPointer.test.ts`, inside the existing
`describe('isAhead', ...)` block. Note the existing test at line 47 ("is NOT ahead when the
timestamp is equal but the id differs") uses `makeReadPointer`, which always produces a KEYED
pointer — so it becomes the "both keyed, candidate sorts lower" case and must be updated to a
candidate whose key sorts BEFORE the current one, or it will now correctly fail. Investigate
before editing: `'m2' > 'm1'`, so that test's candidate now legitimately advances. Rewrite it
as the keyed-lower case rather than deleting it.

```ts
  it('breaks a same-millisecond tie when BOTH pointers are keyed (chat: id order)', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    const candidate = makeReadPointer({ id: 'm2', timestamp: at(1000) }, 'chat')
    expect(isAhead(candidate, current)).toBe(true)
  })

  it('is NOT ahead when both are keyed and the candidate sorts LOWER at the same ms', () => {
    const current = makeReadPointer({ id: 'm2', timestamp: at(1000) }, 'chat')
    const candidate = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    expect(isAhead(candidate, current)).toBe(false)
  })

  it('breaks a room tie on (from, id), not id alone', () => {
    const current = makeReadPointer({ id: 'm9', from: 'r@c/alice', timestamp: at(1000) }, 'room')
    const candidate = makeReadPointer({ id: 'm1', from: 'r@c/bob', timestamp: at(1000) }, 'room')
    // 'bob' > 'alice' wins even though 'm1' < 'm9'.
    expect(isAhead(candidate, current)).toBe(true)
  })

  // CONTROL for the polarity inversion. compareOrder sorts a MISSING key FIRST,
  // which is safe for a floor (under-advance -> over-count) and UNSAFE for a
  // pointer: it would let any keyed candidate overtake a migrated keyless
  // pointer at the same millisecond. A naive `compareOrder(candidate, current) > 0`
  // implementation passes every test above and fails these two.
  it('is NOT ahead at an equal ms when the CURRENT pointer is keyless (migrated)', () => {
    const current: ReadPointer = { messageId: 'legacy', timestamp: at(1000) }
    const candidate = makeReadPointer({ id: 'm2', timestamp: at(1000) }, 'chat')
    expect(isAhead(candidate, current)).toBe(false)
  })

  it('is NOT ahead at an equal ms when the CANDIDATE is keyless', () => {
    const current = makeReadPointer({ id: 'm1', timestamp: at(1000) }, 'chat')
    const candidate: ReadPointer = { messageId: 'legacy', timestamp: at(1000) }
    expect(isAhead(candidate, current)).toBe(false)
  })

  it('still compares by millisecond when a keyless pointer is genuinely older/newer', () => {
    const current: ReadPointer = { messageId: 'legacy', timestamp: at(1000) }
    expect(isAhead(makeReadPointer({ id: 'm2', timestamp: at(2000) }, 'chat'), current)).toBe(true)
    expect(isAhead(makeReadPointer({ id: 'm2', timestamp: at(500) }, 'chat'), current)).toBe(false)
  })
```

Add the type import at the top of the test file:

```ts
import type { ReadPointer } from './readPointer'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/readPointer.test.ts`
Expected: the two tie-breaking tests FAIL (`expected false to be true`); the keyless controls
PASS against the current ms-only implementation (they encode today's behaviour deliberately —
their job is to fail against the *naive* implementation in Step 5, not against today's).

- [ ] **Step 3: Implement**

In `packages/fluux-sdk/src/stores/shared/readPointer.ts`, extend the existing import:

```ts
import { compareOrder, makeArchiveOrderKey, isValidArchiveOrderKey, type ArchiveOrderKey } from './readState'
```

Replace `isAhead` (and its doc comment) with:

```ts
/**
 * Is `candidate` strictly further along than `current`?
 *
 * Timestamp first. A same-millisecond tie is broken by the archive order key —
 * but ONLY when both sides carry one (read-state PR C, D2). A key is what
 * certifies that a pointer's timestamp is its named message's own: pointers
 * built by `makeReadPointer` always have one, while a pointer migrated from the
 * pre-#1081 `lastSeenMessageId` + `lastReadAt` pair carries `lastReadAt` and no
 * key at all.
 *
 * Do NOT simplify this to `compareOrder(candidate, current) > 0`. `compareOrder`
 * sorts a MISSING key FIRST, which is the safe direction for a FLOOR
 * (under-advance -> over-count) and the UNSAFE direction for a POINTER: it would
 * let any keyed candidate overtake a migrated keyless pointer sharing its
 * millisecond, advancing a forward-only position past messages nothing has
 * proven were read. Same comparator, inverted safety. When either side is
 * keyless we fall back to strict millisecond comparison — today's behaviour,
 * preserved exactly where the position is not provable.
 */
export function isAhead(candidate: ReadPointer, current: ReadPointer | undefined): boolean {
  if (!current) return true
  const candidateMs = candidate.timestamp.getTime()
  const currentMs = current.timestamp.getTime()
  if (candidateMs !== currentMs) return candidateMs > currentMs

  const candidateKey = candidate.archiveOrderKey
  const currentKey = current.archiveOrderKey
  if (!candidateKey || !currentKey) return false

  return (
    compareOrder(
      { timestamp: candidateMs, archiveOrderKey: candidateKey },
      { timestamp: currentMs, archiveOrderKey: currentKey }
    ) > 0
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/readPointer.test.ts`
Expected: PASS.

- [ ] **Step 5: Run TWO deliberate breaks and watch each fail**

One mutant is not enough here: the two keyless controls guard opposite sides of the pair, and
the obvious mutant only trips one of them.

**Mutant A — the naive `compareOrder` call.** Replace the body's tail with:

```ts
  return compareOrder(
    { timestamp: candidateMs, archiveOrderKey: candidate.archiveOrderKey },
    { timestamp: currentMs, archiveOrderKey: current.archiveOrderKey }
  ) > 0
```

Expected: **"is NOT ahead at an equal ms when the CURRENT pointer is keyless"** FAILS
(`expected true to be false`) — `compareOrder` sorts the missing *current* key first, so the
candidate wins. The CANDIDATE-keyless control still passes here, because that same convention
sorts a missing *candidate* key first and correctly yields `false`. Revert.

**Mutant B — the inverted convention for an unresolved candidate.** A reviewer might plausibly
reason that a candidate we cannot place should sort *last* ("we don't know where it is, assume
it is newest"), which is the opposite of `compareOrder`'s rule and the dangerous direction:

```ts
  if (!candidateKey && !currentKey) return false
  if (!candidateKey) return true
  if (!currentKey) return false
  return compareOrder(
    { timestamp: candidateMs, archiveOrderKey: candidateKey },
    { timestamp: currentMs, archiveOrderKey: currentKey }
  ) > 0
```

Expected: **"is NOT ahead at an equal ms when the CANDIDATE is keyless"** FAILS
(`expected true to be false`). Revert.

**Quote both failures in your report.** `git diff` must be clean of both mutants before you
commit. If either mutant does NOT produce the stated failure, stop and report — the control is
hollow and needs redesigning, not the mutant.

- [ ] **Step 6: Run the full SDK suite**

Run from the repo root: `npm test`
Expected: green. `advance()` now crosses same-ms runs for keyed pointers, which may change a
pre-existing assertion — if one fails, **investigate and report it**; do not relax it.

- [ ] **Step 7: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/readPointer.ts packages/fluux-sdk/src/stores/shared/readPointer.test.ts
git commit -m "feat(read-state): break same-millisecond pointer ties on the archive order key"
```

---

### Task 2: Collapse the outgoing writer into the viewport writer

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/notificationState.ts` (`onMessageReceived`, ~lines 153-219)
- Test: `packages/fluux-sdk/src/stores/shared/notificationState.test.ts`
- Test: `packages/fluux-sdk/src/stores/roomStore.test.ts` (verify untouched)

**Interfaces:**
- Consumes: `advance`, `makeReadPointer` (Task 1's `isAhead` via `advance`).
- Produces: `onMessageReceived` keeps its signature. Its outgoing early return is gone; an
  outgoing message now takes the delayed guard, then `userSeesMessage`, then the final branch.

**Read the spec's D1 table before writing code** — the divider clear is NOT unconditional.

- [ ] **Step 1: Write the failing tests**

Append to `packages/fluux-sdk/src/stores/shared/notificationState.test.ts`, in a new
`describe('onMessageReceived — outgoing collapse (PR C, D1)', ...)`. Use the file's existing
fixture helpers if present; otherwise these literals are self-contained.

```ts
  const base = (over?: Partial<EntityNotificationState>): EntityNotificationState => ({
    unreadCount: 0,
    mentionsCount: 0,
    readPointer: undefined,
    firstNewMessageId: undefined,
    ...over,
  })
  const out = (id: string, ms: number, extra?: Partial<NotificationMessage>): NotificationMessage => ({
    id, timestamp: new Date(ms), isOutgoing: true, body: 'hi', ...extra,
  })

  it('advances the pointer on an outgoing message ONLY at the live edge', () => {
    const seen = onMessageReceived(base({ unreadCount: 5 }), out('m1', 1000),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: true }, 'chat', { treatDelayedAsNew: true })
    expect(seen.readPointer?.messageId).toBe('m1')
    expect(seen.unreadCount).toBe(0)
  })

  // The vector: a carbon of our own message, or a nick-misattributed MUC
  // reflection, arriving at a BACKGROUNDED entity must not move the pointer.
  it('does NOT advance the pointer on an outgoing message at a backgrounded entity', () => {
    const bg = onMessageReceived(base({ unreadCount: 5 }), out('m1', 1000),
      { isActive: false, windowVisible: true, viewportAtLiveEdge: false }, 'chat', { treatDelayedAsNew: true })
    expect(bg.readPointer).toBeUndefined()
    expect(bg.unreadCount).toBe(5)
  })

  it('does NOT advance the pointer on an outgoing message while active but scrolled up', () => {
    const up = onMessageReceived(base({ unreadCount: 5 }), out('m1', 1000),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: false }, 'chat', { treatDelayedAsNew: true })
    expect(up.readPointer).toBeUndefined()
    expect(up.unreadCount).toBe(5)
  })

  // CONTROL for hazard 1. chatStore.addMessage passes `incrementUnread: !noteAsTransient`,
  // NOT `!isOutgoing`, so without the guard this reaches the +1 and returns 6.
  it('never increments unread for an outgoing message, even when incrementUnread is true', () => {
    const r = onMessageReceived(base({ unreadCount: 5 }), out('m1', 1000),
      { isActive: false, windowVisible: false }, 'chat',
      { treatDelayedAsNew: true, incrementUnread: true })
    expect(r.unreadCount).toBe(5)
  })

  // CONTROL for hazard 2. active + window hidden + no existing divider is the
  // branch that would otherwise place the divider on our OWN message.
  it('never places the divider on an outgoing message', () => {
    const r = onMessageReceived(base({ unreadCount: 3 }), out('m1', 1000),
      { isActive: true, windowVisible: false }, 'chat', { treatDelayedAsNew: true })
    expect(r.firstNewMessageId).toBeUndefined()
  })

  it('never increments mentions for an outgoing message', () => {
    const r = onMessageReceived(base({ mentionsCount: 2 }), out('m1', 1000, { isMention: true }),
      { isActive: false, windowVisible: false }, 'room', { incrementMentions: true })
    expect(r.mentionsCount).toBe(2)
  })

  // The MUC vector specifically: `isOutgoing` in a room is
  // `isSentCarbon || nickname match`, so a whitespace/occupant-id impersonation
  // makes someone else's message look like ours. At a backgrounded room that
  // must not move a forward-only pointer.
  it('room: a misattributed outgoing reflection at a backgrounded room moves nothing', () => {
    const state = base({ unreadCount: 6,
      readPointer: makeReadPointer({ id: 'p0', from: 'r@c/alice', timestamp: new Date(500) }, 'room') })
    const r = onMessageReceived(state, { id: 'm1', from: 'r@c/imposter', timestamp: new Date(1000), isOutgoing: true, body: 'x' },
      { isActive: false, windowVisible: true, viewportAtLiveEdge: false }, 'room')
    expect(r.readPointer?.messageId).toBe('p0')
    expect(r.unreadCount).toBe(6)
  })

  // D1's deliberate loss, both polarities. Seeded nonzero so "unchanged" is a
  // real assertion rather than 0-to-0.
  it('mentionsCount survives a reply sent while scrolled up, and clears at the live edge', () => {
    const up = onMessageReceived(base({ mentionsCount: 3 }), out('m1', 1000),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: false }, 'room')
    expect(up.mentionsCount).toBe(3)

    const edge = onMessageReceived(base({ mentionsCount: 3 }), out('m1', 1000),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: true }, 'room')
    expect(edge.mentionsCount).toBe(0)
  })
```

Now the D1 divider table — all three rows:

```ts
  it('a LIVE outgoing message clears an existing divider (chat and room)', () => {
    for (const kind of ['chat', 'room'] as const) {
      const r = onMessageReceived(base({ unreadCount: 4, firstNewMessageId: 'old' }), out('m1', 1000),
        { isActive: true, windowVisible: true, viewportAtLiveEdge: false }, kind,
        kind === 'chat' ? { treatDelayedAsNew: true } : undefined)
      expect(r.firstNewMessageId).toBeUndefined()
    }
  })

  it('a DELAYED outgoing message clears the divider in a CHAT (offline delivery)', () => {
    const r = onMessageReceived(base({ unreadCount: 4, firstNewMessageId: 'old' }),
      out('m1', 1000, { isDelayed: true }),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: false }, 'chat',
      { treatDelayedAsNew: true })
    expect(r.firstNewMessageId).toBeUndefined()
  })

  // Deliberate behaviour change (PR C, D1). Joining a MUC replays our own
  // <delay/>-stamped messages; a history replay is not evidence of reading, so
  // the divider must survive. Today this clears it.
  it('a DELAYED outgoing message does NOT clear the divider in a ROOM (history replay)', () => {
    const state = base({ unreadCount: 4, firstNewMessageId: 'old' })
    const r = onMessageReceived(state, out('m1', 1000, { isDelayed: true }),
      { isActive: true, windowVisible: true, viewportAtLiveEdge: false }, 'room')
    expect(r).toBe(state)
    expect(r.firstNewMessageId).toBe('old')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts -t "outgoing collapse"`
Expected: the backgrounded / scrolled-up / room-delayed-divider tests FAIL against today's
early return.

- [ ] **Step 3: Implement**

In `notificationState.ts`, DELETE this block entirely (~lines 163-171):

```ts
  // Outgoing message: user is actively engaging, clear notification state
  if (msg.isOutgoing) {
    return {
      unreadCount: 0,
      mentionsCount: 0,
      readPointer: advance(state.readPointer, makeReadPointer(msg, kind)),
      firstNewMessageId: undefined,
    }
  }
```

Change the `userSeesMessage` branch's divider line from
`firstNewMessageId: state.firstNewMessageId,` to:

```ts
      firstNewMessageId: msg.isOutgoing ? undefined : state.firstNewMessageId,
```

Change the two count lines in the final branch to:

```ts
  const newUnreadCount =
    incrementUnread && !msg.isOutgoing && isRenderableStoredMessage(msg)
      ? state.unreadCount + 1
      : state.unreadCount
  const newMentionsCount = incrementMentions && !msg.isOutgoing ? state.mentionsCount + 1 : state.mentionsCount
```

And the divider line in the final branch to:

```ts
  const newFirstNewMessageId = msg.isOutgoing
    ? undefined
    : ctx.isActive && !ctx.windowVisible && !state.firstNewMessageId
      ? msg.id
      : state.firstNewMessageId
```

Replace the function's doc-comment "Rules" list with:

```
 * - Delayed/historical: no changes (preserve existing state) unless treatDelayedAsNew
 * - Incoming or outgoing + user sees message: no unread, advance the pointer
 * - Incoming + user doesn't see + entity active + window hidden: set marker if not set
 * - Incoming + user doesn't see + entity not active: increment unread (renderable only)
 * - Outgoing: never increments unread or mentions, and always clears the divider on the
 *   branches it reaches
 *
 * There is NO outgoing early return (read-state PR C, D1). "I sent this, so I must have
 * read up to here" is an inference, and `isOutgoing` is true for a carbon from another
 * device and for a nick-misattributed MUC reflection — the vector #1081 exists to close.
 * An outgoing message now advances the pointer only via `userSeesMessage`, i.e. for the
 * same reason any VISIBLE message does. Note the consequence for a DELAYED outgoing
 * message: it returns at the delayed guard, so a MUC history replay of our own message no
 * longer dismisses the divider (deliberate — see the spec's D1 table).
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the deliberate breaks and watch them fail**

Break A — drop `!msg.isOutgoing` from `newUnreadCount`. Expected: "never increments unread for
an outgoing message" FAILS (`expected 6 to be 5`).
Break B — restore `firstNewMessageId: state.firstNewMessageId` in the `userSeesMessage` branch.
Expected: "a LIVE outgoing message clears an existing divider" FAILS.
**Quote both failures**, revert both exactly.

- [ ] **Step 6: Run the full suite and triage pre-existing tests**

First confirm the room delayed-history policy is untouched — this task must not change it:

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts -t "delayed"`
Expected: PASS with **no edits** to that file's delayed tests. If one fails, the
`!msg.isOutgoing` guards were placed wrong; fix the guards, never the test.

Then run from the repo root: `npm test`

Expect breakage in `chatStore.test.ts` / `roomStore.test.ts` around outgoing messages — e.g.
"should clear unread count when sending outgoing message". **Each one is a decision, not a
chore.** For every failure, determine whether it asserts:
(a) *the pointer/count converging at the live edge* — the fixture must now establish
    `viewportAtLiveEdge` via the real activation path (`setActiveConversation` /
    `setActiveRoom` plus the viewport-evidence action), NOT via raw `setState`, which never
    begins a generation. Update the fixture, keep the assertion.
(b) *the pointer/count converging while backgrounded or scrolled up* — the assertion itself is
    now wrong. **Do not edit it. Stop and report it to the plan owner** with the test name and
    what it asserts.

Report a list of every changed test and which category it fell into.

- [ ] **Step 7: Verify BOTH user-visible D1 changes in demo mode**

The spec requires these two to be confirmed in the running app, not only in unit tests. They are
the only behaviour in PR C a user can notice without looking at a badge count.

Run `npm run dev` and open `http://localhost:5173/demo.html?tutorial=false`. Use
`window.__demoClient` to inject the states you cannot reach by clicking.

1. **@-mention badge survives a scrolled-up reply.** Open a room carrying an unread @-mention,
   scroll UP so the viewport is off the live edge, send a message. Expected: the message sends,
   and the @-mention badge is **still showing**. (Before this change it cleared.) Then scroll to
   the bottom and send again — expected: the badge clears.
2. **Divider survives a MUC history replay of our own message.** With a room showing a
   "new messages" divider, inject a delayed outgoing room message
   (`isDelayed: true, isOutgoing: true`, timestamped in the past) the way a join-time history
   replay would deliver it. Expected: the divider is **still in place**. (Before this change it
   was dismissed.) Repeat with `isDelayed: false` — expected: the divider clears.

Report what you observed for each, at which viewport width, and note any difference from the
expectations above rather than adjusting the expectation.

- [ ] **Step 8: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/notificationState.ts packages/fluux-sdk/src/stores/shared/notificationState.test.ts packages/fluux-sdk/src/stores/chatStore.test.ts packages/fluux-sdk/src/stores/roomStore.test.ts
git commit -m "feat(read-state): advance the pointer on a sent message only at the live edge"
```

---

### Task 3: Resolve an inbound XEP-0490 marker by archive position

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/readMarkerSync.ts` (`resolveRemoteDisplayed`, ~lines 55-150)
- Test: `packages/fluux-sdk/src/stores/shared/readMarkerSync.test.ts`

**Interfaces:**
- Consumes: `compareOrder`, `makeArchiveOrderKey` from `../shared/readState`; `makeReadPointer`
  from `./readPointer`.
- Produces: `resolveRemoteDisplayed` keeps its signature and its five `RemoteDisplayedResolution`
  kinds. New private helper `resolveAdvance(...)` returning
  `ReadPointer | 'no-advance' | 'undecidable'`.

**Three branches, per spec D3.** The no-pointer case advances TODAY (`pointerInSlice` is
vacuously true when `readPointer` is undefined, so `onMessageSeen` takes its "any resolvable
message is an advancement" path). Losing it would be a silent regression.

- [ ] **Step 1: Write the failing tests**

Append to `packages/fluux-sdk/src/stores/shared/readMarkerSync.test.ts`. The existing suite only
exercises `kind: 'chat'`; add a room case here (carried minor (c) from PR B).

```ts
describe('resolveRemoteDisplayed — position resolution (PR C, D3)', () => {
  const msg = (id: string, ms: number, stanzaId?: string) => ({
    id, timestamp: new Date(ms), isOutgoing: false, body: 'x', ...(stanzaId ? { stanzaId } : {}),
  })

  // Branch 1 — REGRESSION GUARD. This works today and must keep working.
  it('advances to the marker when there is no local pointer at all', () => {
    const r = resolveRemoteDisplayed(
      { unreadCount: 3, mentionsCount: 0, readPointer: undefined },
      [msg('m1', 1000), msg('m2', 2000, 's2')],
      undefined, 's2', 'chat', { isActive: false }
    )
    expect(r.kind).toBe('advanced')
    expect(r.kind === 'advanced' && r.readPointer.messageId).toBe('m2')
  })

  // Branch 2 — the widening. The local pointer's message is NOT in the slice.
  it('advances a KEYED pointer by position even when the pointer is absent from the slice', () => {
    const pointer = makeReadPointer({ id: 'old', timestamp: new Date(500) }, 'chat')
    const r = resolveRemoteDisplayed(
      { unreadCount: 3, mentionsCount: 0, readPointer: pointer },
      [msg('m2', 2000, 's2')],
      undefined, 's2', 'chat', { isActive: false }
    )
    expect(r.kind).toBe('advanced')
    expect(r.kind === 'advanced' && r.readPointer.messageId).toBe('m2')
  })

  it('does NOT advance a KEYED pointer when the marker is behind it', () => {
    const pointer = makeReadPointer({ id: 'new', timestamp: new Date(9000) }, 'chat')
    const r = resolveRemoteDisplayed(
      { unreadCount: 0, mentionsCount: 0, readPointer: pointer },
      [msg('m2', 2000, 's2')],
      undefined, 's2', 'chat', { isActive: false }
    )
    expect(r.kind).toBe('unchanged')
  })

  it('clears a stale pending mark when a KEYED pointer is already past the marker', () => {
    const pointer = makeReadPointer({ id: 'new', timestamp: new Date(9000) }, 'chat')
    const r = resolveRemoteDisplayed(
      { unreadCount: 0, mentionsCount: 0, readPointer: pointer, pendingRemoteDisplayedStanzaId: 's2' },
      [msg('m2', 2000, 's2')],
      undefined, 's2', 'chat', { isActive: false }
    )
    expect(r.kind).toBe('clear-pending')
  })

  // Branch 3 — CONTROL. A migrated keyless pointer's timestamp is `lastReadAt`,
  // which can sit on either side of the message it names, so its position is
  // NOT provable and must keep stashing.
  it('stashes a KEYLESS pointer that is absent from the slice', () => {
    const r = resolveRemoteDisplayed(
      { unreadCount: 3, mentionsCount: 0, readPointer: { messageId: 'old', timestamp: new Date(500) } },
      [msg('m2', 2000, 's2')],
      undefined, 's2', 'chat', { isActive: false }
    )
    expect(r.kind).toBe('stash-pending')
  })

  it('room: breaks a same-millisecond marker tie on (from, id)', () => {
    const pointer = makeReadPointer({ id: 'm9', from: 'r@c/alice', timestamp: new Date(1000) }, 'room')
    const match = { id: 'm1', from: 'r@c/bob', timestamp: new Date(1000), isOutgoing: false, body: 'x', stanzaId: 's1' }
    const r = resolveRemoteDisplayed(
      { unreadCount: 1, mentionsCount: 0, readPointer: pointer },
      [match], undefined, 's1', 'room', { isActive: false }
    )
    expect(r.kind).toBe('advanced')
  })
})
```

Add to the file's imports: `import { makeReadPointer } from './readPointer'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/readMarkerSync.test.ts -t "position resolution"`
Expected: the three KEYED tests FAIL with `expected 'stash-pending' to be 'advanced'` /
`'unchanged'` / `'clear-pending'`. The no-pointer and keyless tests PASS (they encode today's
behaviour and exist to catch regressions in Step 5).

- [ ] **Step 3: Implement**

Add imports to `readMarkerSync.ts`:

```ts
import { compareOrder, makeArchiveOrderKey } from './readState'
import { makeReadPointer, type ReadPointer } from './readPointer'
```

Add this private helper above `resolveRemoteDisplayed`:

```ts
/**
 * Decide whether the remote marker `match` is a forward advance over `current`.
 *
 * Three branches (read-state PR C, D3), because the no-pointer case is NOT the
 * same as the keyless one:
 *
 * - **No pointer** — any resolvable marker is an advance. This is what the code
 *   did before PR C (an undefined pointer made the residency check vacuously
 *   true, so `onMessageSeen` took its own no-pointer path); it is preserved
 *   explicitly so it cannot be lost by refactoring.
 * - **Keyed pointer** — decide by archive position, with no residency
 *   requirement. The key certifies that the pointer's timestamp is its named
 *   message's own, which is exactly the guarantee the old comment here said we
 *   lacked.
 * - **Keyless (migrated) pointer** — its timestamp is `lastReadAt`, which can
 *   sit on EITHER side of the message it names, so nothing is provable from it.
 *   Keep the resident-index path, and stash when the pointer is off-slice.
 */
function resolveAdvance<T extends NotificationMessage & { stanzaId?: string }>(
  current: ReadPointer | undefined,
  match: T,
  messages: T[],
  meta: ReadMarkerMeta,
  currentFirstNewMessageId: string | undefined,
  kind: 'chat' | 'room'
): ReadPointer | 'no-advance' | 'undecidable' {
  if (!current) return makeReadPointer(match, kind)

  if (current.archiveOrderKey) {
    const ahead =
      compareOrder(
        { timestamp: match.timestamp.getTime(), archiveOrderKey: makeArchiveOrderKey(match, kind) },
        { timestamp: current.timestamp.getTime(), archiveOrderKey: current.archiveOrderKey }
      ) > 0
    return ahead ? makeReadPointer(match, kind) : 'no-advance'
  }

  if (!messages.some((m) => m.id === current.messageId)) return 'undecidable'

  const updated = notifState.onMessageSeen(
    {
      unreadCount: meta.unreadCount,
      mentionsCount: meta.mentionsCount,
      readPointer: current,
      firstNewMessageId: currentFirstNewMessageId,
    },
    match.id,
    messages,
    kind
  )
  const next = updated.readPointer
  return next && next.messageId !== current.messageId ? next : 'no-advance'
}
```

In `resolveRemoteDisplayed`, replace everything from `const localPointerId = ...` through the
`if (!readPointer || readPointer.messageId === meta.readPointer?.messageId) { ... }` block with:

```ts
  const outcome = resolveAdvance(meta.readPointer, match, messages, meta, currentFirstNewMessageId, kind)
  if (outcome === 'undecidable') return { kind: 'stash-pending' }
  if (outcome === 'no-advance') {
    return meta.pendingRemoteDisplayedStanzaId === undefined
      ? { kind: 'unchanged' }
      : { kind: 'clear-pending' }
  }
  const readPointer = outcome
```

Leave the `if (!options.isActive)` tail and the divider recomputation below it untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/readMarkerSync.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the deliberate breaks and watch them fail**

Break A — change the no-pointer branch to `return 'undecidable'`. Expected: "advances to the
marker when there is no local pointer at all" FAILS. This proves branch 1 is load-bearing and
not merely implied by branch 3.
Break B — drop the `current.archiveOrderKey` condition so the position path runs for keyless
pointers too. Expected: "stashes a KEYLESS pointer that is absent from the slice" FAILS.
**Quote both**, revert both.

- [ ] **Step 6: Full suite**

Run from the repo root: `npm test`. Expected: green, including
`chatStore.mds.test.ts` and `roomStore.mds.test.ts`. A pre-existing MDS test that now resolves
instead of stashing is an intended consequence — report it explicitly with your reasoning
rather than editing it silently.

- [ ] **Step 7: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/readMarkerSync.ts packages/fluux-sdk/src/stores/shared/readMarkerSync.test.ts
git commit -m "feat(read-state): resolve a remote read marker by archive position when the pointer is keyed"
```

---

### Task 4: Advance the viewport pointer by position

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/notificationState.ts` (`onMessageSeen`, ~lines 542-581)
- Test: `packages/fluux-sdk/src/stores/shared/notificationState.test.ts`

**Interfaces:**
- Consumes: `compareOrder`, `makeArchiveOrderKey`.
- Produces: `onMessageSeen` keeps its signature, including `options?: { atLiveEdge?: boolean }`,
  which now applies only to the keyless branch.

- [ ] **Step 1: Write the failing tests**

```ts
describe('onMessageSeen — position comparison (PR C, D4)', () => {
  const m = (id: string, ms: number) => ({ id, timestamp: new Date(ms) })

  it('advances a KEYED pointer that is absent from the slice', () => {
    const state = { unreadCount: 4, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'old', timestamp: new Date(500) }, 'chat'),
      firstNewMessageId: undefined }
    const r = onMessageSeen(state, 'm2', [m('m2', 2000)], 'chat')
    expect(r.readPointer?.messageId).toBe('m2')
  })

  it('does NOT advance a KEYED pointer to a message behind it', () => {
    const state = { unreadCount: 0, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'new', timestamp: new Date(9000) }, 'chat'),
      firstNewMessageId: undefined }
    const r = onMessageSeen(state, 'm2', [m('m2', 2000)], 'chat')
    expect(r).toBe(state)
  })

  it('advances a KEYED pointer across a same-millisecond sibling that sorts after it', () => {
    const state = { unreadCount: 1, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat'),
      firstNewMessageId: undefined }
    const r = onMessageSeen(state, 'm2', [m('m1', 1000), m('m2', 1000)], 'chat')
    expect(r.readPointer?.messageId).toBe('m2')
  })

  // CONTROL: the keyless branch keeps its guard AND its escape hatch.
  it('refuses a KEYLESS pointer that is absent from the slice, unless at the live edge and newest', () => {
    const state = { unreadCount: 4, mentionsCount: 0,
      readPointer: { messageId: 'old', timestamp: new Date(500) }, firstNewMessageId: undefined }
    expect(onMessageSeen(state, 'm1', [m('m1', 2000), m('m2', 3000)], 'chat')).toBe(state)
    const edge = onMessageSeen(state, 'm2', [m('m1', 2000), m('m2', 3000)], 'chat', { atLiveEdge: true })
    expect(edge.readPointer?.messageId).toBe('m2')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts -t "position comparison"`
Expected: the first and third FAIL (`expected undefined to be 'm2'` / `expected 'm1' to be 'm2'`).

- [ ] **Step 3: Implement**

Extend `notificationState.ts`'s import from `./readState` — `compareOrder` and
`makeArchiveOrderKey` are not imported there yet:

```ts
import {
  compareOrder,
  isRenderableStoredMessage,
  makeArchiveOrderKey,
  pointerlessDefers,
  type RenderabilityCheckFields,
} from './readState'
```

Replace `onMessageSeen`'s body after the `if (!state.readPointer) return advanced()` line with:

```ts
  // Keyed pointer: compare archive POSITIONS. The pointer no longer has to be
  // resident, and a same-millisecond sibling that sorts after it is a genuine
  // advance. Safe against the resident array because PR B gave
  // `messageArrayUtils` the same `compareOrder` tie-break, so array index and
  // archive order agree.
  if (state.readPointer.archiveOrderKey) {
    const target = messages[newIdx]
    return compareOrder(
      { timestamp: target.timestamp.getTime(), archiveOrderKey: makeArchiveOrderKey(target, kind) },
      { timestamp: state.readPointer.timestamp.getTime(), archiveOrderKey: state.readPointer.archiveOrderKey }
    ) > 0
      ? advanced()
      : state
  }

  // Keyless (migrated) pointer: its timestamp proves nothing about its position,
  // so keep ordering by index — including the off-slice guard and the live-edge
  // escape hatch that stops it getting stuck.
  const currentIdx = messages.findIndex((m) => m.id === state.readPointer!.messageId)
  if (currentIdx === -1) {
    if (options?.atLiveEdge && newIdx === messages.length - 1) return advanced()
    return state
  }
  if (newIdx > currentIdx) return advanced()
  return state
```

Update the doc comment's paragraph about unresolvable pointers to say the guard now applies to
the keyless branch only.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts`
Expected: PASS.

- [ ] **Step 5: Deliberate break**

Remove the `state.readPointer.archiveOrderKey` condition so every pointer takes the position
path. Expected: the keyless control FAILS. **Quote it**, revert.

- [ ] **Step 6: Full suite + scroll gate**

Run from the repo root: `npm test`, then `npm run test:scroll`.
Expected: `npm test` green; scroll 52/52. If port 5173 is busy from another worktree's dev
server, **do not kill it** — report that the gate is blocked and continue.

- [ ] **Step 7: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/notificationState.ts packages/fluux-sdk/src/stores/shared/notificationState.test.ts
git commit -m "feat(read-state): advance the viewport pointer by archive position for keyed pointers"
```

---

### Task 5: Derive the divider from the floor, with the count's own predicate

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/notificationState.ts` (`onActivate`, ~lines 277-420)
- Modify: `packages/fluux-sdk/src/stores/shared/readMarkerSync.ts` (drop `treatDelayedAsNew` from the `onActivate` call and from `options`; `ReadMarkerMeta` is NOT extended — see Step 4)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (activation ~1347, resync ~1901, recount rederive ~2643)
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (recount rederive ~2487, activation ~2683, resync ~2850)
- Test: `notificationState.test.ts`, `chatStore.test.ts`, `roomStore.test.ts`

**Interfaces:**
- Consumes: `compareOrder`, `computeFloor`, `makeArchiveOrderKey`, `isRenderableStoredMessage`
  from `./readState`.
- Produces: `onActivate(state, messages, kind)` — **the `options` parameter is REMOVED**.
  `ReadMarkerMeta` is unchanged.

This is the largest task. It merges the spec's tasks 5 and 6 (see File Structure).

**The new rule, verbatim from spec D5** — the divider is the first message the canonical count
would count:

```
!m.isOutgoing && isRenderableStoredMessage(m) && compareOrder(positionOf(m), floorPos) > 0
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('onActivate — floor-derived divider (PR C, D5)', () => {
  const inc = (id: string, ms: number, extra?: Partial<NotificationMessage>): NotificationMessage =>
    ({ id, timestamp: new Date(ms), isOutgoing: false, body: 'hi', ...extra })

  it('places the divider at the first incoming message after a KEYED pointer', () => {
    const state = { unreadCount: 2, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat'),
      firstNewMessageId: undefined }
    const r = onActivate(state, [inc('m1', 1000), inc('m2', 2000), inc('m3', 3000)], 'chat')
    expect(r.firstNewMessageId).toBe('m2')
  })

  // A non-resident pointer at a DISTINCT millisecond is not a control: today's
  // ladder already probes `timestamp > pointer.timestamp` and lands on the same
  // message. The case only the key order can settle is a non-resident pointer
  // SHARING a millisecond with a resident message.
  //
  // Pointer m2@2000 (keyed, absent from the slice); m3@2000 is resident.
  //   today  -> ladder finds the first message strictly after 2000 => 'm4'
  //   PR C   -> compareOrder ranks m3 after m2 at the same ms  => 'm3'
  it('places the divider on a same-millisecond sibling of a NON-RESIDENT pointer', () => {
    const state = { unreadCount: 2, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'm2', timestamp: new Date(2000) }, 'chat'),
      firstNewMessageId: undefined }
    const r = onActivate(state, [inc('m1', 1000), inc('m3', 2000), inc('m4', 3000)], 'chat')
    expect(r.firstNewMessageId).toBe('m3')
  })

  // Pointerless: the floor is historyFloor, and a same-ms message counts as
  // strictly after it (keyless sorts first) — matching the count exactly.
  it('uses historyFloor when there is no pointer, counting a same-millisecond message as after', () => {
    const state = { unreadCount: 1, mentionsCount: 0, readPointer: undefined,
      historyFloor: new Date(2000), firstNewMessageId: undefined }
    const r = onActivate(state, [inc('m1', 1000), inc('m2', 2000), inc('m3', 3000)], 'chat')
    expect(r.firstNewMessageId).toBe('m2')
  })

  it('yields NO divider when there is neither a pointer nor a historyFloor', () => {
    const state = { unreadCount: 5, mentionsCount: 0, readPointer: undefined, firstNewMessageId: undefined }
    const r = onActivate(state, [inc('m1', 1000), inc('m2', 2000)], 'chat')
    expect(r.firstNewMessageId).toBeUndefined()
  })

  // CONTROL: divider eligibility must match countUnreadInArchive's predicate.
  // A non-renderable row contributes nothing to the count, so it must not carry
  // the divider either. Today's isNewCandidate has no renderability check.
  it('skips a NON-RENDERABLE row and puts the divider on the next real message', () => {
    const state = { unreadCount: 1, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat'),
      firstNewMessageId: undefined }
    const ghost = { id: 'ghost', timestamp: new Date(2000), isOutgoing: false }
    const r = onActivate(state, [inc('m1', 1000), ghost, inc('m3', 3000)], 'chat')
    expect(r.firstNewMessageId).toBe('m3')
  })

  it('skips outgoing messages', () => {
    const state = { unreadCount: 1, mentionsCount: 0,
      readPointer: makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat'),
      firstNewMessageId: undefined }
    const r = onActivate(state, [inc('m1', 1000), inc('m2', 2000, { isOutgoing: true }), inc('m3', 3000)], 'chat')
    expect(r.firstNewMessageId).toBe('m3')
  })

  // Unified semantics: with a timestamp floor, a delayed message after the floor
  // simply IS new. This is why onActivate sheds treatDelayedAsNew (spec D8).
  it('treats a DELAYED message after the floor as new, for chat and room alike', () => {
    for (const kind of ['chat', 'room'] as const) {
      const state = { unreadCount: 1, mentionsCount: 0,
        readPointer: makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, kind),
        firstNewMessageId: undefined }
      const r = onActivate(state, [inc('m1', 1000), inc('m2', 2000, { isDelayed: true })], kind)
      expect(r.firstNewMessageId).toBe('m2')
    }
  })

  it('never moves the read pointer', () => {
    const pointer = makeReadPointer({ id: 'gone', timestamp: new Date(1500) }, 'chat')
    const state = { unreadCount: 2, mentionsCount: 0, readPointer: pointer, firstNewMessageId: undefined }
    const r = onActivate(state, [inc('m2', 2000)], 'chat')
    expect(r.readPointer).toBe(pointer)
  })

  it('leaves unreadCount untouched', () => {
    const state = { unreadCount: 7, mentionsCount: 3,
      readPointer: makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat'),
      firstNewMessageId: undefined }
    expect(onActivate(state, [inc('m1', 1000), inc('m2', 2000)], 'chat').unreadCount).toBe(7)
  })
})
```

Store-level controls for the `historyFloor` plumbing — **must use a pointerless entity**,
because `computeFloor` is pointer-wins and a pointer would make the break inert.

**Four controls, one per plumbed site**, all in this task. There are no controls for the
remote-marker or recount-rederivation sites because there is no plumbing there — see Step 4.

For the **activation** sites, add to `chatStore.test.ts` / `roomStore.test.ts`: seed a
conversation with `historyFloor: new Date(2000)`, no `readPointer`, resident messages at
1000/2000/3000, drive the real activation path
(`chatStore.getState().setActiveConversation(CID)` — never raw `setState`, which never begins a
viewport generation), and assert `firstNewMessageMarkers.get(CID) === 'm2'`.

For the **resync** sites, do NOT reuse the activation fixture: activation has already placed the
marker on `m2`, so an assertion of `'m2'` after a resync passes whether or not the resync did
anything — and `resyncDividerToReadPointer` deliberately *keeps* the existing marker when it
derives no divider, so dropping `historyFloor` would leave `'m2'` in place and the control would
still pass. Both ways hollow. Seed everything the action reads, park the marker on a
deliberately WRONG message, and call the action directly:

```ts
  // Needs: import type { ConversationMetadata, Message } from '../core/types'
  it('resync repositions a pointerless conversation divider using historyFloor', () => {
    const CID = 'carol@example.com'
    const msg = (id: string, ts: number): Message => ({
      type: 'chat', id, conversationId: CID, from: CID, body: 'hi',
      timestamp: new Date(ts), isOutgoing: false,
    })

    chatStore.getState().addConversation({ id: CID, name: CID, type: 'chat', unreadCount: 0 })
    chatStore.setState((s) => {
      // Pointerless meta whose ONLY boundary is the creation watermark.
      // Typed explicitly rather than cast: `as never` would hide exactly the
      // field-shape mistakes this fixture depends on being right.
      const conversationMeta = new Map(s.conversationMeta)
      const meta: ConversationMetadata = {
        ...(conversationMeta.get(CID) ?? { unreadCount: 0 }),
        unreadCount: 2,
        readPointer: undefined,
        historyFloor: new Date(2000),
      }
      conversationMeta.set(CID, meta)
      return {
        conversationMeta,
        // resyncDividerToReadPointer scans the RESIDENT array.
        messages: new Map(s.messages).set(CID, [msg('m1', 1000), msg('m2', 2000), msg('m3', 3000)]),
        // Parked on the WRONG message, so the assertion is a reversal, not a no-op.
        firstNewMessageMarkers: new Map(s.firstNewMessageMarkers).set(CID, 'm3'),
      }
    })

    chatStore.getState().resyncDividerToReadPointer(CID)

    // m2 shares the floor's exact millisecond and must still count as after it
    // (a keyless floor sorts first) — the same rule the count uses.
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m2')
  })
```

Dropping `historyFloor` at that site makes `onActivate` derive no divider, so the action
early-returns and the marker stays `'m3'` — `expected 'm3' to be 'm2'`. That bites.

Mirror in `roomStore.test.ts`, seeding `roomRuntime` rather than `messages`.

If you find yourself unable to make one of the four fail in Step 6, that site is a dead path
too: stop and report it rather than keeping a control that cannot bite.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts -t "floor-derived divider"`
Expected: the non-resident, pointerless-historyFloor, no-floor, non-renderable and room-delayed
cases FAIL.

- [ ] **Step 3: Implement the pure scan**

Replace `onActivate` entirely with:

```ts
/**
 * Compute new notification state when the user opens/activates an entity.
 *
 * The divider is **the first message the canonical count would count** (read-state
 * PR C, D5): incoming, renderable, and strictly after the read boundary in
 * `(timestamp, archiveOrderKey)` order. Sharing the count's exact predicate AND
 * its exact floor is what makes "the divider labels the count" true by
 * construction rather than by coincidence — see `countUnreadInArchive`.
 *
 * `isDelayed` plays no part: with a timestamp floor, a delayed message after the
 * boundary simply IS new. That is why this function no longer takes
 * `treatDelayedAsNew` (the live arrival paths still do — chat and room genuinely
 * differ there; see `onMessageReceived`).
 *
 * This function NEVER moves the read pointer and never changes `unreadCount`.
 * The old fallback ladder — a `lastReadAt` timestamp probe, an Nth-from-end
 * placement driven by `unreadCount`, and a resume-preserving snap — is gone. All
 * of it existed because the pointer could not be located outside the resident
 * slice, which a persisted `archiveOrderKey` now solves, and the snap was a
 * pointer write inside a function whose job is to place a divider.
 *
 * With neither a pointer nor a `historyFloor` there is no boundary, so there is
 * no divider — the same stand-down the count makes when `computeFloor` yields
 * nothing.
 */
export function onActivate(
  state: EntityNotificationState,
  messages: NotificationMessage[],
  kind: 'chat' | 'room'
): EntityNotificationState {
  const floor = computeFloor(state.readPointer, state.historyFloor)

  let firstNewMessageId: string | undefined = undefined
  if (floor) {
    const floorPos: OrderPosition = state.readPointer
      ? { timestamp: state.readPointer.timestamp.getTime(), archiveOrderKey: state.readPointer.archiveOrderKey }
      : { timestamp: floor.getTime() }

    for (const m of messages) {
      if (m.isOutgoing) continue
      if (!isRenderableStoredMessage(m)) continue
      const pos: OrderPosition = {
        timestamp: m.timestamp.getTime(),
        archiveOrderKey: makeArchiveOrderKey(m, kind),
      }
      if (compareOrder(pos, floorPos) > 0) {
        firstNewMessageId = m.id
        break
      }
    }
  }

  // mentionsCount stays zeroed here: clearing the @-mention badge on open is
  // pre-existing behaviour, unrelated to the read pointer. unreadCount is
  // DELIBERATELY left unchanged — the canonical count is archive-derived and
  // converges to 0 only through genuine live-edge convergence (PR B, FIX 2).
  return {
    unreadCount: state.unreadCount,
    mentionsCount: 0,
    readPointer: state.readPointer,
    historyFloor: state.historyFloor,
    firstNewMessageId,
  }
}
```

Update the imports at the top of `notificationState.ts`:

```ts
import {
  compareOrder,
  computeFloor,
  isRenderableStoredMessage,
  makeArchiveOrderKey,
  pointerlessDefers,
  type OrderPosition,
  type RenderabilityCheckFields,
} from './readState'
```

- [ ] **Step 4: Thread `historyFloor` to every call site**

**Two of the candidate sites are NOT plumbed, because a pointerless entity cannot reach either.**
`computeFloor` is pointer-wins, so a floor on a path that always has a pointer is a field no
code can read and a control no test can fail. Four call sites, not eight:

- **`ReadMarkerMeta` / `resolveRemoteDisplayed`** reaches `onActivate` only on the advance path,
  passing the `readPointer` it has just built.
- **The divider rederivation inside `recomputeUnreadForConversation` / `recomputeUnreadForRoom`**
  runs only when `firstNewMessageMarkers.has(id)`, and deactivation deletes the marker and
  evicts the resident array for every non-active entity (`setActiveConversation`,
  `setActiveRoom`). The only recounts reaching an entity that still holds a marker are the
  `allowActive` ones, and both triggers — a local pointer advance, and an inbound marker that
  advanced the pointer — guarantee the pointer is defined.

In `resolveRemoteDisplayed`'s divider recomputation, just drop the options argument:

```ts
  const divider = notifState.onActivate(
    { unreadCount: 0, mentionsCount: 0, readPointer, firstNewMessageId: undefined },
    messages,
    kind
  ).firstNewMessageId
```

Remove `treatDelayedAsNew` from `resolveRemoteDisplayed`'s `options` parameter type and from
both store call sites that pass it.

Then add `historyFloor` to the state literal at each of these four sites — every one of which
can genuinely reach `onActivate` with **no pointer** — and delete the `{ treatDelayedAsNew: true }`
argument from every `onActivate` call (including the two unplumbed ones):

| File | Site | Source of the floor |
|---|---|---|
| `chatStore.ts` ~1347 | `activateConversation` notifInput | `meta?.historyFloor ?? conv.historyFloor` |
| `chatStore.ts` ~1901 | `resyncDividerToReadPointer` | `meta.historyFloor` |
| `roomStore.ts` ~2683 | `activateRoom` notifInput | `meta?.historyFloor ?? room.historyFloor` |
| `roomStore.ts` ~2850 | `resyncDividerToReadPointer` | `meta?.historyFloor ?? existing?.historyFloor` |

Do **not** add `historyFloor` to:
- the `applyRemoteDisplayed` meta literals (`chatStore.ts` ~2010, `roomStore.ts` ~2961) — they
  feed `ReadMarkerMeta`, the first dead path above;
- the recount divider rederivations (`chatStore.ts` ~2643, `roomStore.ts` ~2487) — the second
  dead path. Those two literals still lose their `treatDelayedAsNew` argument, but gain nothing.

Use the typechecker to find any site this table misses:
`cd packages/fluux-sdk && npx tsc --noEmit` will flag every remaining `treatDelayedAsNew`
argument to `onActivate` as an excess property.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts src/stores/shared/readMarkerSync.test.ts`
Expected: PASS.

- [ ] **Step 6: Deliberate breaks**

Break A — drop `historyFloor` from ONE store call site (e.g. chat activation). Expected: the
activation control FAILS with the divider `undefined` instead of `'m2'` — **not** with the
divider at the top of the slice. For a resync site the marker instead stays at its seeded wrong
value (`expected 'm3' to be 'm2'`). Repeat per site, all four.
Break B — remove the `isRenderableStoredMessage(m)` line. Expected: the non-renderable control
FAILS (`expected 'ghost' to be 'm3'`).
Break C — replace `compareOrder(pos, floorPos) > 0` with a bare
`m.timestamp.getTime() > floorPos.timestamp`. Expected: the pointerless same-millisecond control
FAILS (`expected undefined to be 'm2'`).
**Quote every failure**, revert every break.

- [ ] **Step 7: Full suite, typecheck, lint, scroll**

From the repo root: `npm run build:sdk && npm run typecheck && npm run lint && npm test`, then
`npm run test:scroll`.

`onActivate`'s ladder deletion changes divider placement for entities whose pointer is off-slice,
so expect pre-existing divider tests to move. **Triage each one**: a test asserting the
Nth-from-end placement is asserting the deleted ladder and should be rewritten against the new
rule *with a nonzero, fixture-specific expected id* — never reseeded to `0`/`undefined` to make
it pass. Report every changed test.

- [ ] **Step 8: Verify in demo mode**

Run `npm run dev`, open `http://localhost:5173/demo.html?tutorial=false`. Confirm: opening a
conversation with unread shows the divider at the first genuinely unread message with the
canonical count in its label; a room with deep history shows a divider consistent with its
badge. Report what you checked and at which viewport.

- [ ] **Step 9: Commit**

```bash
git add packages/fluux-sdk/src apps/fluux/src
git commit -m "feat(read-state): derive the new-message divider from the read boundary"
```

---

### Task 6: Delete `recomputeCountsFromPointer` and its cache-window constant

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/notificationState.ts` (delete `recomputeCountsFromPointer` + `RecomputeCountsOptions`, ~lines 583-712)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (guard pass ~2484-2541, MAM hydration ~2952-2985)
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (guard pass ~2331-2387, MAM hydration ~3953-3979)
- Modify: `packages/fluux-sdk/src/utils/mamCatchUpUtils.ts` (delete `MAM_POINTER_RECOUNT_CACHE_LIMIT`, ~line 78)
- Test: `notificationState.test.ts`, `mamCatchUpUtils.test.ts`, `chatStore.archiveUnread.test.ts`, `roomStore.archiveUnread.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `recomputeCountsFromPointer`, `RecomputeCountsOptions` and
  `MAM_POINTER_RECOUNT_CACHE_LIMIT` no longer exist. #1080 gate 3 (`hasPendingRemoteMarker` as an
  *option*) disappears with them; the **defer checks** on `pendingRemoteDisplayedStanzaId` and
  `hasUnmigratedLegacyReadState` inside both derivations stay exactly as they are.

**Why this is safe** (spec D6). Be precise about what "inert" means here, because the earlier
wording of this paragraph was wrong and would have under-tested the change:

- **All four sites currently write the read pointer.** The two guard-pass sites commit
  `legacy.readPointer` into `conversationMeta` / `roomMeta` (chatStore ~2532-2539 and the room
  twin). They are live pointer writers, and each needs its own regression test below.
- What is inert at those two sites is only the **count**: its output is discarded, and both
  derivations re-check both defer conditions immediately afterwards. So deleting the guard pass
  removes the pointer write and nothing else.

Both removed pointer effects are deliberate: the fresh-entity snap is replaced by
`historyFloor`, and the outgoing-boundary advance is the heuristic #1081 exists to kill.

- [ ] **Step 1: Write the failing tests**

Add to `chatStore.archiveUnread.test.ts` (helpers `CID`, `archiveMsg`, `setMeta`,
`seedCoverage` already exist there) and mirror in its room twin. Use
`await vi.waitFor(() => { ... }, { timeout: 2000 })` for the async recount — **never** the
fixed-tick `for (let i = 0; i < 5; i++) await setTimeout(0)` idiom, which is load-sensitive and
produced an observed flake during PR B.

```ts
describe('the guard pass no longer writes the pointer (PR C, D6)', () => {
  // The MERGE schedules its recount fire-and-forget (`void get().recompute...`),
  // so asserting the pointer straight after the merge resolves proves NOTHING —
  // the guard pass may not have run yet, and a count seeded at 0 that is still 0
  // is not evidence either. Drive the recount explicitly and await it, THEN
  // assert. Both assertions below are chosen so a surviving guard pass changes
  // them.
  it('a forward merge + recount does NOT snap a fresh conversation pointer to the newest message', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('h1', 600),
      archiveMsg('h2', 700),
    ])
    // Fresh entity: no pointer, and history predating its creation watermark.
    setMeta({ unreadCount: 0, readPointer: undefined, historyFloor: new Date(1000) })
    seedCoverage('anchor-stanza')

    await chatStore.getState().mergeMAMMessages(CID, [archiveMsg('h1', 600), archiveMsg('h2', 700)], 'forward')
    await chatStore.getState().recomputeUnreadForConversation(CID)

    // A surviving fresh-entity snap would put this at 'h2'.
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBeUndefined()
  })

  // The OTHER two call sites: the guard pass inside the derivation itself.
  // Reached with no merge at all, so it needs its own control.
  it('the recount itself does NOT snap a fresh conversation pointer to the newest message', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('h1', 600),
      archiveMsg('h2', 700),
    ])
    setMeta({ unreadCount: 0, readPointer: undefined, historyFloor: new Date(1000) })
    seedCoverage('anchor-stanza')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBeUndefined()
  })

  it('the recount itself does NOT advance the pointer to an outgoing message', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1100),
      archiveMsg('mine', 1200, { isOutgoing: true }),
      archiveMsg('u2', 1300),
    ])
    setMeta({
      unreadCount: 3,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // A surviving outgoing-boundary advance would put this at 'mine' and drop
    // the count to 1 by swallowing u1.
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.messageId).toBe('p0')
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
  })

  it('a forward merge does NOT advance the pointer to an outgoing message', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1100),
      archiveMsg('mine', 1200, { isOutgoing: true }),
      archiveMsg('u2', 1300),
      archiveMsg('u3', 1400),
    ])
    setMeta({
      unreadCount: 4,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    await chatStore.getState().mergeMAMMessages(CID, [archiveMsg('mine', 1200, { isOutgoing: true })], 'forward')
    await chatStore.getState().recomputeUnreadForConversation(CID)

    // The reply came from another device. Nothing here is evidence we read u1.
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.messageId).toBe('p0')
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
  })

  it('messages arriving after creation and merged during catch-up count as unread', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('n1', 2000),
      archiveMsg('n2', 3000),
    ])
    setMeta({ unreadCount: 0, readPointer: undefined, historyFloor: new Date(1000) })
    seedCoverage('anchor-stanza')

    await chatStore.getState().mergeMAMMessages(CID, [archiveMsg('n1', 2000), archiveMsg('n2', 3000)], 'forward')
    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
  })

  // Carried from PR B: the race the no-mistakes gate's round-2 fix already
  // closed. This PIN proves the input-version guard is load-bearing, so a later
  // refactor cannot quietly drop it.
  it('a live arrival during an in-flight recount is not clobbered by the stale result', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1100),
    ])
    setMeta({
      unreadCount: 1,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    // Let the recount reach its archive read, then land an arrival that raises
    // the count WITHOUT moving the pointer — the case the pointer-identity
    // guard alone cannot see.
    vi.mocked(messageCache.countUnreadInArchive).mockImplementationOnce(async (id, args) => {
      const actual = await vi.importActual<typeof import('../utils/messageCache')>('../utils/messageCache')
      const res = await actual.countUnreadInArchive(id, args)
      chatStore.getState().addMessage(archiveMsg('u2', 1200))
      return res
    })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // The stale snapshot said 1; the arrival made it 2. 2 must win.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
  })

  // Requirement 2 holds after the deletion, all three outcomes.
  it('never writes mentionsCount, on exact / deferred / unavailable', async () => {
    // Rooms have a real mentionsCount field; assert there. See the room twin.
  })
})
```

Note on the divider rederivation you are about to re-point at the resident array in Step 4: it
gets **no** `historyFloor` control, here or in Task 5. It runs only when
`firstNewMessageMarkers.has(id)`, and deactivation deletes the marker for every non-active
entity, so the only recounts that reach it are the `allowActive` ones — which always follow a
pointer advance. A pointerless entity cannot get there, and pointer-wins means a floor would
change nothing if it did. Do not add one.

The `mentionsCount` assertions belong in `roomStore.archiveUnread.test.ts`, where
`mentionsCount` is a real field (chat's `ConversationMetadata` has none, so PR B had to seed a
cast property). Seed `mentionsCount: 4` and assert it is still `4` after an `exact` recount,
after a `deferred` one (break coverage), and after an `unavailable` one (make
`countRoomUnreadInArchive` return `null`).

Seed every fixture with a **nonzero, fixture-specific** count where the assertion is about a
count being preserved — never seed `0` and assert `0`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.archiveUnread.test.ts`
Expected: the pointer assertions FAIL (`expected 'm7' to be 'm1'` / `expected {...} to be
undefined`) against the surviving guard pass.

- [ ] **Step 3: Delete the pure function**

In `notificationState.ts`, delete `RecomputeCountsOptions` (interface + doc) and
`recomputeCountsFromPointer` (doc + body) entirely. Delete the now-unused `pointerlessDefers`
import if nothing else in the file uses it — the typechecker will tell you.

Update the module doc-comment's reference to `recomputeCountsFromPointer` (~line 274, in
`onActivate`'s doc) — the fresh-entity guard it names no longer exists.

- [ ] **Step 4: Delete the four call sites**

In `chatStore.recomputeUnreadForConversation`, delete the entire `--- Legacy guard pass ---`
block: the `resident` / `slice` fetch, the `if (!recountContextIsCurrent()) return`, and the
`if (slice.length > 0) { set(...) }`. **Keep** the `--- Defer conditions ---` block below it
unchanged, and keep the `afterGuard` read (rename the local to `meta1` if you prefer, but do not
change what it reads).

`slice` is also used by the divider rederivation near the end of the function. Replace that use
with the resident array:

```ts
          const slice = state.messages.get(conversationId) ?? []
```

read inside the final `set()`, so the rederivation still has messages to scan.

Do the same in `roomStore.recomputeUnreadForRoom`, using
`state.roomRuntime.get(roomJid)?.messages ?? []`.

In `chatStore.mergeMAMMessages`, delete the `hydratedPointer` computation entirely — the
`if (direction === 'forward' && meta && conv) { ... }` block — keeping
`if (newMessages.length > 0) shouldRecountAfterMerge = true`, which must now run for a forward
merge regardless. Simplify the following write to `previewUpdate` only:

```ts
            if (previewUpdate) {
              const draft = draftConversationMaps(state)
              draft.patchMeta(conversationId, { lastMessage })
              return { mamQueryStates: newStates, ...draft.commit(), conversationGaps: gapsAfterMerge, conversationCoverage: coverageAfterMerge }
            }
```

Apply the room twin in `roomStore.ts`.

- [ ] **Step 5: Delete the constant**

In `mamCatchUpUtils.ts`, delete `MAM_POINTER_RECOUNT_CACHE_LIMIT` and its doc comment. Remove
its import from both stores. In `mamCatchUpUtils.test.ts`, delete the import and the whole
`it('sizes the exact-recount window to everything one catch-up pass can download', ...)` test —
it asserts only the deleted constant's arithmetic, so it has nothing left to protect.

- [ ] **Step 6: Delete the pure function's tests**

In `notificationState.test.ts`, delete the `describe('recomputeCountsFromPointer', ...)` block
and the two `recomputeCountsFromPointer` cases inside the pointer-coherence describe (~lines
1535-1545) and the coherence sweep entry (~1588). Do **not** delete neighbouring tests for
other functions.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.archiveUnread.test.ts src/stores/roomStore.archiveUnread.test.ts src/stores/shared/notificationState.test.ts src/utils/mamCatchUpUtils.test.ts`
Expected: PASS.

- [ ] **Step 8: Deliberate breaks**

Break A — re-add a minimal fresh-entity snap to `mergeMAMMessages` (set the pointer to the
newest merged message when `meta.readPointer` is undefined). Expected: "a forward merge +
recount does NOT snap a fresh conversation pointer to the newest message" FAILS.

Break B — re-add the same snap inside `recomputeUnreadForConversation` before the defer checks.
Expected: "the recount itself does NOT snap a fresh conversation pointer to the newest message"
FAILS.

**Quote both**, revert each exactly.

- [ ] **Step 9: Full gates**

From the repo root: `npm run build:sdk && npm run typecheck && npm run lint && npm test`.

PR B's Task 10 found that removing the constant alone broke five tests that deliberately seed a
NON-RESIDENT entity to prove the guard-pass fallback fires. Those tests are now asserting a
mechanism that no longer exists. **Rewrite each against the archive derivation** — same entity,
same seeded data, asserting the derived count — and report each one. If a test cannot be
rewritten without weakening it, stop and report rather than deleting it.

- [ ] **Step 10: Commit**

```bash
git add packages/fluux-sdk/src
git commit -m "refactor(read-state): delete the pointer-writing recount and its cache window"
```

---

### Task 7: Re-justify the surviving #1080 gates

**Files:**
- Modify: `packages/fluux-sdk/src/core/mdsSideEffects.ts` (`archiveIsTrustworthy` doc, ~lines 204-228)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (`advanceReadPointer` presence-gate comment, ~1925)
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (twin, ~2869)

**Interfaces:** No signature changes. Comments and one verification checklist only.

Gate 3 already disappeared with Task 6. This task closes the remaining two decisions so no
gate is left standing on a rationale that no longer holds — the spec's stated reason for doing
this at all: a dead guard is its own liability.

- [ ] **Step 1: Verify gates 1 and 2 are intact**

Confirm by reading, and record the result in your report:
- `chatStore.advanceReadPointer` and `roomStore.advanceReadPointer` still begin with
  `if (!connectionStore.getState().windowVisible) return`.
- `apps/fluux/src/hooks/useWindowVisibility.ts` still calls `isViewportAtBottom` before
  `markAsRead` for both stores.

If either is missing, STOP and report — that is a regression from an earlier task.

- [ ] **Step 2: Rewrite gate 4's rationale**

Replace the second paragraph of `archiveIsTrustworthy`'s doc comment:

```
   * A read position derived mid-catch-up is computed against a partial window,
   * and MDS positions are forward-only — publishing a wrong one makes every
   * other device adopt it and leaves the real position unrecoverable.
```

with:

```
   * The original reason — "a read position derived mid-catch-up is computed
   * against a partial window" — no longer applies: catch-up stopped being a
   * pointer writer in read-state PR C, so no position originates here any more.
   *
   * The gate stays as a PUBLISH-SIDE backstop, which is a different and still
   * valid job. Every local writer that remains (viewport, remote marker,
   * mark-read) can fire while the archive is incomplete, and an MDS marker is
   * adopted by every other device and is forward-only there too. Speaking for
   * the user from an archive we know is partial is the one thing this gate
   * prevents, independently of where the position came from.
```

- [ ] **Step 3: Refresh the presence-gate comments**

In both stores' `advanceReadPointer`, the comment cites issue #1076. Append one sentence so a
later reader knows it was re-decided rather than merely inherited:

```ts
        // Re-decided in read-state PR C (D7): kept. This gate is independent of
        // where the count comes from — painted is not seen — so nothing in the
        // derived-count model makes it redundant.
```

- [ ] **Step 4: Verify nothing else changed**

Run: `git diff --stat`
Expected: three files, comments only. If any non-comment line moved, revert it — this task
changes no behaviour.

- [ ] **Step 5: Gates**

From the repo root: `npm run typecheck && npm run lint && npm test`
Expected: green, with no test changes at all.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/mdsSideEffects.ts packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/roomStore.ts
git commit -m "docs(read-state): re-justify the surviving read-position guards"
```

---

### Task 8: Fold mark-read's evidence decision inward, and delete dead code

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/notificationState.ts` (`onMarkAsRead`, ~lines 438-479)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (`markAsRead`, ~1781-1834)
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (`markAsRead`, ~2530-2570)
- Delete: `apps/fluux/src/utils/newMessagesMarker.ts`, `apps/fluux/src/utils/newMessagesMarker.test.ts`
- Test: `notificationState.test.ts`, `chatStore.mds.test.ts`, `roomStore.mds.test.ts`

**Interfaces:**
- Produces: `onMarkAsRead(state, messages: PointerSource[], kind, options:
  { windowAtLiveEdge: boolean; viewportAtLiveEdge: boolean })`.
  The `advanceSeenTo?: PointerSource` parameter is gone. `markReadToNewest` is NOT affected — it
  builds its pointer directly and keeps its own
  `messages ?? meta.lastMessage ?? existing.lastMessage` fallback chain.

- [ ] **Step 1: Confirm the dead code is still dead**

Run: `grep -rn "newMessagesMarker" apps/fluux/src packages --include="*.ts" --include="*.tsx"`
Expected: hits only in `newMessagesMarker.ts` and its own test. If anything else imports it,
STOP and report.

- [ ] **Step 2: Write the failing tests**

```ts
describe('onMarkAsRead — live-edge decision (PR C, D8)', () => {
  const m = (id: string, ms: number) => ({ id, timestamp: new Date(ms) })

  it('advances when both the loaded window and viewport are at the live edge', () => {
    const state = { unreadCount: 5, mentionsCount: 2, readPointer: undefined, firstNewMessageId: 'x' }
    const r = onMarkAsRead(state, [m('m1', 1000), m('m2', 2000)], 'chat', {
      windowAtLiveEdge: true,
      viewportAtLiveEdge: true,
    })
    expect(r.readPointer?.messageId).toBe('m2')
    expect(r.unreadCount).toBe(0)
    expect(r.mentionsCount).toBe(0)
    expect(r.firstNewMessageId).toBe('x')
  })

  it('clears the counts WITHOUT moving the pointer off the live edge', () => {
    const pointer = makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat')
    const state = { unreadCount: 5, mentionsCount: 0, readPointer: pointer, firstNewMessageId: undefined }
    const r = onMarkAsRead(state, [m('m1', 1000), m('m2', 2000)], 'chat', {
      windowAtLiveEdge: false,
      viewportAtLiveEdge: true,
    })
    expect(r.readPointer).toBe(pointer)
    expect(r.unreadCount).toBe(0)
  })

  it('clears the counts WITHOUT moving the pointer when the viewport is away', () => {
    const pointer = makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat')
    const state = { unreadCount: 5, mentionsCount: 0, readPointer: pointer, firstNewMessageId: undefined }
    const r = onMarkAsRead(state, [m('m1', 1000), m('m2', 2000)], 'chat', {
      windowAtLiveEdge: true,
      viewportAtLiveEdge: false,
    })
    expect(r.readPointer).toBe(pointer)
    expect(r.unreadCount).toBe(0)
  })

  it('is a no-op on an already-read entity at the live edge', () => {
    const pointer = makeReadPointer({ id: 'm2', timestamp: new Date(2000) }, 'chat')
    const state = { unreadCount: 0, mentionsCount: 0, readPointer: pointer, firstNewMessageId: undefined }
    expect(onMarkAsRead(state, [m('m1', 1000), m('m2', 2000)], 'chat', {
      windowAtLiveEdge: true,
      viewportAtLiveEdge: true,
    })).toBe(state)
  })

  it('clears the counts on an empty slice without inventing a pointer', () => {
    const state = { unreadCount: 3, mentionsCount: 0, readPointer: undefined, firstNewMessageId: undefined }
    const r = onMarkAsRead(state, [], 'chat', {
      windowAtLiveEdge: true,
      viewportAtLiveEdge: true,
    })
    expect(r.unreadCount).toBe(0)
    expect(r.readPointer).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts -t "live-edge decision"`
Expected: FAIL — `onMarkAsRead` does not accept these arguments (TypeScript compile error is an
acceptable failure here; note it as compiler-enforced in your report).

- [ ] **Step 4: Implement**

```ts
/**
 * Compute new notification state when an entity is explicitly marked as read.
 *
 * Clears unreadCount and mentionsCount. Preserves firstNewMessageId — the marker
 * has a separate lifecycle (set on activate, cleared on deactivate or explicit
 * clear).
 *
 * The pointer advances to the newest loaded message ONLY when the loaded window
 * and the current-generation viewport are both at the live edge. Otherwise the
 * counts clear but the position stays where the user actually read, so the
 * XEP-0490 publisher never speaks past what they saw.
 *
 * Picking the message from the two independent live-edge facts is this
 * function's job (read-state PR C, D8).
 */
export function onMarkAsRead(
  state: EntityNotificationState,
  messages: Array<PointerSource>,
  kind: 'chat' | 'room',
  options: { windowAtLiveEdge: boolean; viewportAtLiveEdge: boolean }
): EntityNotificationState {
  const newest =
    options.windowAtLiveEdge && options.viewportAtLiveEdge
      ? messages[messages.length - 1]
      : undefined
  const seenUnchanged = newest === undefined || newest.id === state.readPointer?.messageId
  if (state.unreadCount === 0 && state.mentionsCount === 0 && seenUnchanged) {
    return state
  }
  return {
    ...state,
    unreadCount: 0,
    mentionsCount: 0,
    readPointer: newest ? makeReadPointer(newest, kind) : state.readPointer,
  }
}
```

In `chatStore.markAsRead`, delete the `lastMessage` and `advanceSeenTo` locals and call:

```ts
          const windowAtLiveEdge = state.windowAtLiveEdge.get(conversationId) !== false
          const viewportAtLiveEdge =
            currentViewportEvidence(chatViewportEvidenceKey(conversationId)) === 'at-edge'
          const updated = notifState.onMarkAsRead(notifInput, messages, 'chat', {
            windowAtLiveEdge,
            viewportAtLiveEdge,
          })
```

Apply the room twin. Leave both `markReadToNewest` implementations untouched.

- [ ] **Step 5: Delete the dead module**

```bash
git rm apps/fluux/src/utils/newMessagesMarker.ts apps/fluux/src/utils/newMessagesMarker.test.ts
```

- [ ] **Step 6: Run to verify passing**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/notificationState.test.ts
src/stores/chatStore.mds.test.ts src/stores/roomStore.mds.test.ts`
Expected: PASS.

- [ ] **Step 7: Deliberate break**

Change the two-fact condition to always take the newest. Expected: both "clears the counts
WITHOUT moving the pointer" tests FAIL (`expected {...m2} to be {...m1}`). **Quote them**,
revert.

- [ ] **Step 8: Full gates**

From the repo root: `npm run build:sdk && npm run typecheck && npm run lint && npm test`.

- [ ] **Step 9: Commit**

```bash
git add -A packages/fluux-sdk/src apps/fluux/src
git commit -m "refactor(read-state): let mark-read own its live-edge decision; drop dead marker util"
```

---

### Task 9: Update the design record and close the tracking issue

**Files:**
- Modify: `docs/superpowers/specs/2026-07-22-read-state-model-consolidation-design.md`
- Modify: `docs/superpowers/specs/2026-07-28-read-state-c-writer-restriction-design.md` (status line)

**Interfaces:** Documentation only.

- [ ] **Step 1: Reconcile the spec with what was actually built, THEN mark it implemented**

Do not change the status line alone. Read the spec's D5 section and its Testing list against
the delivered code and correct any statement that no longer holds — a spec marked "Implemented"
while still describing something else is worse than one marked stale, because the next reader
trusts it.

As of this plan's last revision the spec was already corrected for the two unplumbed
`historyFloor` sites (`ReadMarkerMeta` and the recount rederivation). Verify that correction
still matches the code you shipped, and check the rest of D5 and the Testing list the same way.

Then change `**Status:** Design approved, pending spec review` to `**Status:** Implemented` and
add the PR link once it exists.

- [ ] **Step 2: Correct the parent design's stale claims**

In `2026-07-22-read-state-model-consolidation-design.md`, fix the two statements the
re-grounding proved wrong, so the document is not left misleading a future reader:
- The Deletions table row for `treatDelayedAsNew` says "both stores already pass `true`". They
  do not — the room live-arrival path relies on the `false` default. Change it to record that
  only `onActivate` shed the option.
- The Deletions table row for `onMessageSeen`'s guard says "There is no unresolvable pointer any
  more". True only for keyed pointers. Change it to say the guard was narrowed to the keyless
  branch, not deleted.

- [ ] **Step 3: Verify the deletions actually happened**

Run: `grep -rn "recomputeCountsFromPointer\|MAM_POINTER_RECOUNT_CACHE_LIMIT" packages apps --include="*.ts" --include="*.tsx"`
Expected: no hits outside `docs/`. Any code hit means a task was left incomplete — report it.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs
git commit -m "docs(read-state): record PR C as implemented"
```

- [ ] **Step 5: Hand back to the plan owner**

Do NOT open the PR or close #1081 yourself. Report to the plan owner:
- every gate result (`build:sdk`, `typecheck`, `lint`, SDK suite, app suite, `test:scroll`),
  run from the repo root, with pass counts;
- every pre-existing test that changed, and why each was a genuine consequence rather than a
  relaxed assertion;
- the demo-mode observations from Task 5 and the `mentionsCount` check from Task 2;
- that #1081 is ready to close once the PR merges, and that the four "After PR C" items in the
  spec's Out of scope section are still outstanding — in particular the **Gajim-on-real-ejabberd
  validation**, which is the only check that has ever caught this bug class.

---

## Whole-branch review

After Task 9, before opening the PR, run a whole-branch review over the full diff. On PR B this
caught three defects that lived *between* tasks and that twelve clean per-task reviews each
correctly missed. Give the reviewer the spec, the full `git diff main...HEAD`, and these seams:

1. **Writer inventory** — enumerate every surviving write to `readPointer` in production code
   and check each against the spec's writer table. Anything not on it is a defect.
2. **Order agreement — on the KEYED path only.** Where two positions are both keyed, the
   resident sort (`messageArrayUtils`), the archive cursor (`countUnreadInArchive`), `isAhead`,
   `onMessageSeen`, `onActivate` and `resolveRemoteDisplayed` must order them identically; a
   disagreement there is an under-count. The keyless paths deliberately do **not** converge, and
   demanding that they do would be wrong — each preserves its own pre-PR-C behaviour:
   `isAhead` compares milliseconds, `resolveRemoteDisplayed` uses the resident index or stashes,
   `onMessageSeen` uses the resident index plus its live-edge escape hatch. Check each keyless
   path against what it did *before* this branch, not against the others.
3. **Keyed/keyless polarity** — only the NEW positional comparison requires both keys. "Refuses
   when keyless" is the wrong summary: a keyless `isAhead` still advances on a strictly newer
   millisecond, and a keyless `onMessageSeen` still advances by index. What each must have is a
   test proving its *preserved* fallback, not only a test of the new keyed advance. A widening
   that silently swallowed its fallback is the defect to hunt for.
4. **Divider/count parity** — the divider predicate and the count predicate must be the same
   three conditions against the same floor.
5. **Safety direction** — for every changed branch, does an ambiguous case resolve toward more
   unread?
6. **`mentionsCount`** — no archive recount writes it, in either store.
7. **Hollow tests** — any new test that would still pass against the pre-task code, or that
   seeds `0` and asserts `0`.

Tell the reviewer explicitly: **do not `git checkout`, `switch`, `reset`, or `stash`.**
