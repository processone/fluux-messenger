# Resident-Top Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete scroll-positioning migration step 6 by moving Home / resident-top navigation from a hook-owned smooth write to a generation-aware controller-owned one-shot animation with leased observation.

**Architecture:** Add a seventh authoritative execution slice to `PositioningController`. Its executor starts the native smooth animation once, while the shared `PositionFrameLoop` only observes progress and settles, cancels, or times out the generation. `useMessageListScroll` remains the browser adapter and publishes a stable Home command.

**Tech Stack:** TypeScript, React, Vitest, Testing Library, Playwright, Chromium, WebKit.

## Global Constraints

- Preserve `scrollTo({ top: 0, behavior: 'smooth' })`; never restart it from an animation frame.
- Settle after two consecutive observations at `scrollTop <= 1`.
- Stop best-effort after 120 frames without forcing a snap.
- Native user input, conversation deactivation, and newer requests cancel stale work before it can settle.
- Preserve the existing `lastLoadTimeRef.current = Date.now()` history-load guard.
- Do not add an unleased emergency scroll write.
- Keep Home / Mod+ArrowUp listener and consumer identities stable across appends and window changes.
- Step 7 hook decomposition is outside this change.

---

### Task 1: Define and drive the resident-top controller slice

**Files:**
- Modify: `apps/fluux/src/components/conversation/scrollPositionModel.ts`
- Modify: `apps/fluux/src/components/conversation/positioningController.ts`
- Test: `apps/fluux/src/components/conversation/positioningController.test.ts`

**Interfaces:**
- Consumes: existing `PositionExecutionLease`, `PositionFrameLoop`, `ReachabilityFacts`, `acceptPositionRequest`, `resolveReachability`, and module-private `mintPositionGeneration`.
- Produces:
  - `ResidentTopRequest`
  - `ResidentTopCompletion`
  - `ResidentTopStartResult`
  - `ResidentTopExecutor`
  - `PositioningController.beginResidentTopNavigation(input)`

- [x] **Step 1: Write the failing single-write and convergence tests**

In `positioningController.test.ts`, import the not-yet-existing resident-top
types and add a harness with literal geometry:

```ts
function residentTopHarness(
  initialReachability: ReachabilityFacts = {
    kind: 'available',
    index: 0,
    mounted: true,
    placement: 'viable',
  },
) {
  const callbacks: Array<() => void> = []
  const leases: PositionExecutionLease[] = []
  const start = vi.fn(() => ({ kind: 'started' as const }))
  const finish = vi.fn()
  const recordFrame = vi.fn()
  const complete = vi.fn()
  let scrollTop = 640
  const executor: ResidentTopExecutor = {
    reachability: () => initialReachability,
    beginLoop: (lease) => {
      leases.push(lease)
      return {
        schedule: (callback) => callbacks.push(callback),
        recordFrame,
        finish,
      }
    },
    start,
    readScrollTop: () => scrollTop,
    complete,
  }
  return {
    executor,
    callbacks,
    leases,
    start,
    finish,
    recordFrame,
    complete,
    setScrollTop: (value: number) => { scrollTop = value },
    runFrame: () => callbacks.shift()!(),
  }
}
```

Add a test that begins navigation, observes `640`, `100`, `1`, and `0`, and asserts:

```ts
expect(harness.start).toHaveBeenCalledTimes(1)
expect(harness.complete).toHaveBeenLastCalledWith(
  expect.objectContaining({ desired: { kind: 'resident-top' } }),
  'settled',
)
expect(harness.recordFrame).toHaveBeenCalledWith(true)
expect(harness.recordFrame).toHaveBeenLastCalledWith(false)
expect(controller.snapshot().active?.phase).toEqual({ kind: 'settled' })
```

The test must fail because `ResidentTopExecutor` and
`beginResidentTopNavigation` do not exist. It would also fail if a frame
restarted the smooth write or if one top observation settled too early.

- [x] **Step 2: Run the controller test and verify RED**

Run:

```bash
cd apps/fluux
npx vitest run src/components/conversation/positioningController.test.ts
```

Expected: TypeScript/Vitest failure naming the missing resident-top controller API.

- [x] **Step 3: Implement the minimal resident-top lifecycle**

First add the request alias beside the other exported aliases in
`scrollPositionModel.ts`:

```ts
export type ResidentTopRequest = Extract<
  PositionRequest,
  { source: { kind: 'user-navigation'; reason: 'resident-top' } }
>
```

Then in `positioningController.ts`, add:

```ts
export type ResidentTopCompletion =
  | 'settled'
  | 'best-effort'
  | 'user-takeover'
  | 'superseded'

export type ResidentTopStartResult =
  | { kind: 'started' }
  | { kind: 'unavailable' }

export interface ResidentTopExecutor {
  reachability: () => ReachabilityFacts
  beginLoop: (lease: PositionExecutionLease) => PositionFrameLoop | null
  start: (
    request: ResidentTopRequest,
    lease: PositionExecutionLease,
  ) => ResidentTopStartResult
  readScrollTop: () => number | null
  complete: (
    request: ResidentTopRequest,
    outcome: ResidentTopCompletion,
  ) => void
}
```

Add `ResidentTopExecutionState` with `request`, `executor`, `operation`, `abortController`, `loop`, `framesLeft`, and `stableFrames`; add:

```ts
const RESIDENT_TOP_OBSERVE_FRAMES = 120
const RESIDENT_TOP_STABLE_FRAMES = 2
const RESIDENT_TOP_TOLERANCE_PX = 1
```

Implement `beginResidentTopNavigation` so it:

1. reads reachability inside `runScrollShadowSafely`;
2. rejects `empty-window` and mismatched facts before accepting;
3. creates `{ source: { kind: 'user-navigation', reason: 'resident-top' }, desired: { kind: 'resident-top' } }`;
4. cancels all older executions;
5. advances to `resolveReachability`;
6. creates the resident execution and starts a leased loop;
7. invokes `executor.start` once, records that initial write, marks applied, and schedules observation.

The frame driver must decrement the 120-frame budget, call only `readScrollTop`, record `false`, and settle after two consecutive values `<= 1`. Budget exhaustion completes `best-effort`. A null reading or unavailable start completes best-effort without a fallback write.

- [x] **Step 4: Run the controller test and verify GREEN**

Run:

```bash
cd apps/fluux
npx vitest run src/components/conversation/positioningController.test.ts
```

Expected: all controller tests pass, including the one-shot smooth start control.

- [x] **Step 5: Commit the first controller increment**

```bash
git add apps/fluux/src/components/conversation/scrollPositionModel.ts \
  apps/fluux/src/components/conversation/positioningController.ts \
  apps/fluux/src/components/conversation/positioningController.test.ts
git commit -m "Add resident-top controller execution"
```

---

### Task 2: Protect resident-top cancellation, supersession, and timeout

**Files:**
- Modify: `apps/fluux/src/components/conversation/positioningController.ts`
- Test: `apps/fluux/src/components/conversation/positioningController.test.ts`

**Interfaces:**
- Consumes: `ResidentTopExecutionState` and `beginResidentTopNavigation` from Task 1.
- Produces: resident-top participation in `observeUserInput`, `cancelExecutionsIfSuperseded`, `cancelAllExecutions`, and conversation deactivation.

- [x] **Step 1: Write failing lifecycle tests**

Add four tests using the real controller and resident harness:

1. `observeUserInput(conversationId)` followed by a queued frame leaves `start` at one call, calls `complete(request, 'user-takeover')`, finishes the loop, and leaves the lease stale.
2. A later `beginLiveEdgeRequest` followed by the queued resident frame calls `complete(request, 'superseded')` and cannot settle the older generation.
3. 120 non-top observations complete `best-effort`, call `start` once, and never mutate observed geometry.
4. `beginResidentTopNavigation` with `{ kind: 'empty-window' }` returns `null` and leaves no active resident-top request.

Each test must assert the final controller phase/watermark as well as completion. These controls fail if resident-top is omitted from any shared cancellation path or if timeout performs a second write.

- [x] **Step 2: Run the lifecycle tests and verify RED**

Run:

```bash
cd apps/fluux
npx vitest run src/components/conversation/positioningController.test.ts
```

Expected: failures showing resident-top execution remains current after user input/supersession or lacks best-effort completion.

- [x] **Step 3: Implement shared cancellation participation**

Add resident-top currentness, lease, finish, completion, and cancellation helpers following the existing live-edge/media shapes:

```ts
private cancelResidentTopExecution(outcome: ResidentTopCompletion): void
private isResidentTopExecutionCurrent(
  execution: ResidentTopExecutionState,
): boolean
private beginResidentTopOperation(
  execution: ResidentTopExecutionState,
): PositionExecutionLease
```

Capture `residentTopWasCurrent` before `cancelReconciliationForUserInput`, then cancel it with `user-takeover`. Include resident-top in `cancelExecutionsIfSuperseded` and `cancelAllExecutions('superseded')`. `deactivate` already calls `cancelExecutionsIfSuperseded`, so its stale queued frame must fail the lease without a separate direct path.

- [x] **Step 4: Run the controller tests and verify GREEN**

Run:

```bash
cd apps/fluux
npx vitest run src/components/conversation/positioningController.test.ts
```

Expected: all tests pass and every stale-frame control observes `lease.isCurrent() === false`.

- [x] **Step 5: Commit lifecycle coverage**

```bash
git add apps/fluux/src/components/conversation/positioningController.ts \
  apps/fluux/src/components/conversation/positioningController.test.ts
git commit -m "Cancel stale resident-top positioning"
```

---

### Task 3: Route Home navigation through the controller

**Files:**
- Modify: `apps/fluux/src/components/conversation/useMessageListScroll.ts`
- Modify: `apps/fluux/src/components/conversation/MessageList.scroll.test.tsx`
- Modify: `scripts/scroll-invariants.ts`
- Modify: `docs/superpowers/specs/2026-07-27-resident-top-controller-design.md`

**Interfaces:**
- Consumes: `ResidentTopExecutor` and `beginResidentTopNavigation`.
- Produces: `createResidentTopExecutor()` and stable `scrollToTop`.

- [x] **Step 1: Write the failing runtime hook tests**

In `MessageList.scroll.test.tsx`, add a Home test using the real `MessageList` and scroller:

```ts
fireEvent.keyDown(window, { key: 'Home' })
expect(scroller.scrollTo).toHaveBeenCalledTimes(1)
expect(scroller.scrollTo).toHaveBeenCalledWith({
  top: 0,
  behavior: 'smooth',
})
```

Assert that the rAF harness has queued the controller observation loop, then
advance it while setting `scroller.scrollTop` through `500`, `20`, `1`, and
`0`; assert there is still exactly one `scrollTo` call. The current direct
implementation queues no resident-top observation frame, so this is the RED
control. Dispatch a wheel event in a sibling test before the queued frame and
assert the stale callback does not add a write or settle into a live owner.

In `scripts/scroll-invariants.ts`, add the real-engine Home scenario before the
hook cutover. Enable scroll debug capture, start away from resident top, invoke
Home through the focused message list, wait for `scrollTop <= 1`, and require
one runtime `RESIDENT TOP: controller completed` trace with zero divergence and
instrumentation errors. The current direct path reaches top but emits no
controller completion, so the test must fail on both engines.

- [x] **Step 2: Run the hook tests and verify RED**

Run:

```bash
cd apps/fluux
npx vitest run src/components/conversation/MessageList.scroll.test.tsx
cd ../..
npx playwright test \
  --config playwright.scroll.config.ts \
  --grep "Home reaches resident top"
```

Expected: the Vitest progress test fails because the current direct call has no
controller-owned observation, and Playwright fails because no resident-top
controller completion trace exists.

- [x] **Step 3: Implement the hook adapter**

Import `ResidentTopExecutor`. Add:

```ts
const createResidentTopExecutor = useCallback((): ResidentTopExecutor => ({
  reachability: () => deriveReachabilityForDesired({
    desired: { kind: 'resident-top' },
    hasRows: messageCount > 0 && firstMessageId !== undefined,
    windowAtLiveEdge: windowAtLiveEdge !== false,
    virtualizer: virtualizerRef.current,
    scroller: scrollerRef.current,
    loadAround: 'unavailable',
    canRecenter: false,
  }),
  beginLoop: (lease) => beginControllerFrameLoop('resident-top', lease),
  start: (_request, lease) => {
    const scroller = scrollerRef.current
    if (!lease.isCurrent() || !scroller) return { kind: 'unavailable' }
    scroller.scrollTo({ top: 0, behavior: 'smooth' })
    return { kind: 'started' }
  },
  readScrollTop: () => scrollerRef.current?.scrollTop ?? null,
  complete: (request, outcome) => {
    debugLog('RESIDENT TOP: controller completed', {
      conversationId: request.conversationId,
      generation: request.generation,
      outcome,
    })
  },
}), [
  beginControllerFrameLoop,
  firstMessageId,
  messageCount,
  windowAtLiveEdge,
])
```

Replace the old shadow block and direct write with:

```ts
const scrollToTopImpl = useCallback(() => {
  lastLoadTimeRef.current = Date.now()
  positioningControllerRef.current?.beginResidentTopNavigation({
    conversationId,
    executor: createResidentTopExecutor(),
  })
}, [conversationId, createResidentTopExecutor])

```

The only smooth write now lives inside the leased executor start method. Update the design spec's test paragraph to say runtime behavior, not source-text matching.

- [x] **Step 4: Run hook and real-engine tests and verify GREEN**

Run:

```bash
cd apps/fluux
npx vitest run src/components/conversation/MessageList.scroll.test.tsx
cd ../..
npx playwright test \
  --config playwright.scroll.config.ts \
  --grep "Home reaches resident top"
```

Expected: hook tests pass, resident-top issues one smooth write, and Playwright
reports 2/2 with controller completion traces.

- [x] **Step 5: Write the failing callback-stability test**

Capture `scrollToTop` from the hook consumer, rerender with an appended
message/current window change, and assert the same function identity. The
minimal cutover above closes over `createResidentTopExecutor`, so this test must
fail until a stable shell is published. The realistic mutation caught is
removing the stable shell and rebinding the global keyboard listener on every
append.

- [x] **Step 6: Run the stability test and verify RED**

Run:

```bash
cd apps/fluux
npx vitest run src/components/conversation/MessageList.scroll.test.tsx
```

Expected: the new identity assertion fails while the resident-top behavior
tests remain green.

- [x] **Step 7: Publish the stable command and verify GREEN**

Add:

```ts
const scrollToTop = useStableCallback(scrollToTopImpl)
```

Then run:

```bash
cd apps/fluux
npx vitest run \
  src/components/conversation/MessageList.scroll.test.tsx \
  src/components/roomRowPresenceMemo.test.tsx
```

Expected: all tests pass and appends do not invalidate the Home command or
mounted room rows.

- [x] **Step 8: Commit the hook cutover**

```bash
git add apps/fluux/src/components/conversation/useMessageListScroll.ts \
  apps/fluux/src/components/conversation/MessageList.scroll.test.tsx \
  scripts/scroll-invariants.ts \
  docs/superpowers/specs/2026-07-27-resident-top-controller-design.md
git commit -m "Route Home positioning through the controller"
```

---

### Task 4: Add real-engine coverage and close migration step 6

**Files:**
- Modify: `docs/2026-07-23-scroll-positioning-contract.md`
- Modify: `docs/superpowers/plans/2026-07-27-resident-top-controller.md`

**Interfaces:**
- Consumes: controller-owned Home behavior and invariant from Task 3.
- Produces: completed step-6 contract.

- [x] **Step 1: Update the positioning contract**

In `docs/2026-07-23-scroll-positioning-contract.md`:

- change step 6 to `[x]`;
- replace “One positioning owner remains” with a statement that all live-list semantic positioning owners are controller-owned;
- document resident-top as a one-shot smooth write plus leased observation, with no per-frame reassert;
- retain the two isolated-context bullets unchanged;
- update “all six authoritative slices” to “all seven authoritative slices”.

- [x] **Step 2: Mark completed plan checkboxes**

As each step is completed, replace its `- [ ]` with `- [x]` in this plan so the committed plan accurately records execution.

- [x] **Step 3: Run focused controller, hook, and real-engine tests**

Run:

```bash
cd apps/fluux
npx vitest run \
  src/components/conversation/positioningController.test.ts \
  src/components/conversation/MessageList.scroll.test.tsx \
  src/components/roomRowPresenceMemo.test.tsx
cd ../..
npx playwright test \
  --config playwright.scroll.config.ts \
  --grep "Home reaches resident top"
```

Expected: all focused Vitest tests pass and Playwright reports 2/2.

- [x] **Step 4: Commit the contract**

```bash
git add docs/2026-07-23-scroll-positioning-contract.md \
  docs/superpowers/plans/2026-07-27-resident-top-controller.md
git commit -m "Complete scroll positioning migration step 6"
```

---

### Task 5: Full verification

**Files:**
- Verify only; modify production files only if a failing check exposes a real defect and add a failing regression test before the fix.

**Interfaces:**
- Consumes: complete branch state from Tasks 1–4.
- Produces: evidence that the exact branch is ready for review.

- [x] **Step 1: Run the full unit/integration suite**

```bash
npm test
```

Expected: all SDK and app tests pass; existing environment warnings do not change the exit code.

- [x] **Step 2: Run static checks**

```bash
npm run typecheck
npm run lint
git diff --check origin/main...HEAD
```

Expected: typecheck passes, lint has zero errors, and the diff check is clean.

- [x] **Step 3: Run the complete scroll-invariant suite**

```bash
npm run test:scroll
```

Expected: all existing 52 scenarios plus the two new engine cases pass.

- [x] **Step 4: Audit ownership and scope**

Review:

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
git status -sb
```

Confirm the hook has no shadow `home-key` observation or direct Home write outside `ResidentTopExecutor.start`, static preview and selection scrolling are unchanged, and no unrelated files are present.

- [x] **Step 5: Commit any final plan-state update**

If marking Task 5 checkboxes changes the plan:

```bash
git add docs/superpowers/plans/2026-07-27-resident-top-controller.md
git commit -m "Record resident-top migration validation"
```

Otherwise leave the verified branch unchanged.

Validation recorded on 2026-07-27:

- `npm test`: SDK 5,325 passed; app 5,339 passed and 22 skipped.
- `npm run typecheck`: passed for both workspaces.
- `npm run lint`: zero errors; 34 pre-existing warnings.
- `npm run test:scroll`: 54/54 passed across Chromium and WebKit.
- Ownership audit: the only live-list resident-top write is
  `ResidentTopExecutor.start`; static preview center positioning and keyboard
  selection remain explicitly isolated.
