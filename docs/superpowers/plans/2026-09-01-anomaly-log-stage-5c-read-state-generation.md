# Anomaly log stage 5c — read-state generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the read pointer's forward-only invariant checkable from outside the SDK, by exposing
the generation a pointer belongs to, and ship `read-state/pointer-regression` on top of it.

**Architecture:** Both stores already keep the two counters the detector needs — a store-scope epoch
bumped by logout and account switch, and a per-entity epoch bumped when a conversation or room is
deleted. They are module-private. This slice exposes them read-only, and the app samples a pointer
and its generation in the same store-subscription callback, so the two cannot disagree.

**Tech Stack:** TypeScript, Zustand vanilla stores, vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-client-anomaly-detection-log-design.md` §5.1, §5.5
seam 4. Predecessors: stage 5a and 5b plans in this directory.

## What the code already provides

Verified 2026-09-01.

- `chatCacheEpoch` (`chatStore.ts:602`) is bumped by `switchAccount` (`:3540`), `reset` (`:3562`)
  and the archive-save test reset (`:623`). `roomCacheEpoch` (`roomStore.ts:405`) mirrors it.
- `chatEntityEpoch` is bumped **only** by `invalidateChatEntity` (`:697`), whose sole production
  caller is `deleteConversation` (`:1639`). `roomEntityEpoch` / `invalidateRoomEntity` /
  `removeRoom` (`:1332`) mirror it.
- **The spec's premise is out of date in the app's favour.** §5.5 argues a single global counter
  would be wrong "because the underlying `chatCacheEpoch` is bumped by conversation *deletion* as
  well as by logout and account switch". It is not: deletion bumps the **entity** epoch. The two
  scopes the seam is asked to expose already exist, correctly separated. Nothing needs restructuring
  — only exporting.
- `isAhead(candidate, current)` is **already public** (`index.ts:245`). The detector must use it
  rather than compare timestamps itself: a detector with its own ordering rule would eventually
  disagree with the store and report the disagreement as a bug in the store.
- `switchAccount` and `reset` also `chatEntityEpoch.clear()`, so an entity epoch can go **down**
  across a store-generation change. The detector therefore compares the pair, and any difference in
  either scope is a reset — never an ordering.

## Global Constraints

- **Read-only.** No counter changes meaning, no bump moves, no new bump. This slice adds two
  exported readers and nothing else to the SDK.
- **A reader, not a signal — a deliberate deviation from §5.5.** The spec proposes a
  `{ scope, gen }` event. A detector has to sample the pointer and the generation *together*: with
  an event, a generation change delivered after the pointer write it explains produces exactly the
  false positive §6.1 deletes a detector for. A reader called inside the same subscription callback
  as the pointer read cannot race. The scoping the spec asked for is preserved — the reader returns
  both scopes.
- **Registry parity** and the closed value registries, as in 5a/5b.
- The detector must **ignore the first observation** in a generation, **accept an identical
  rewrite**, and record only a strictly-behind pointer within one generation (§5.1).

---

### Task 1: Expose the generation

**Files:**
- Create: `packages/fluux-sdk/src/core/types/readStateGeneration.ts` (the type)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts`, `packages/fluux-sdk/src/stores/roomStore.ts`
- Modify: `packages/fluux-sdk/src/index.ts`
- Test: `packages/fluux-sdk/src/stores/readStateGeneration.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface ReadStateGeneration {
    /** Bumped by logout and account switch: every entity's read state is new. */
    store: number
    /** Bumped when THIS entity is deleted and later recreated. */
    entity: number
  }
  export function chatReadStateGeneration(conversationId: string): ReadStateGeneration
  export function roomReadStateGeneration(roomJid: string): ReadStateGeneration
  ```

Two functions rather than one facade: a `stores/shared/` module reading both stores would invert the
layering it belongs to (shared is imported *by* the stores), and a registry to dodge that would add
indirection for one call.

- [ ] **Step 1: Write the failing test** — a generation is stable across ordinary pointer writes;
  `deleteConversation` bumps only `entity`; `reset` bumps `store`; the room twin behaves the same;
  an unknown entity reads `entity: 0` rather than throwing.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement** the two readers next to the existing epoch helpers, and export them.
- [ ] **Step 4: Run it and watch it pass**, plus both store suites.
- [ ] **Step 5: Commit** — `feat(sdk): expose the generation a read pointer belongs to`

---

### Task 2: The pointer-regression detector

**Files:**
- Create: `apps/fluux/src/anomaly/detectors/pointerRegression.ts`
- Test: `apps/fluux/src/anomaly/detectors/pointerRegression.test.ts`
- Modify: `apps/fluux/src/anomaly/values.ts` (`ID.pointerRegression`)
- Modify: `docs/ANOMALY_INVARIANTS.md`

**Interfaces:**
- Produces:
  ```typescript
  export interface PointerObservation {
    kind: 'chat' | 'room'
    id: string
    pointer: ReadPointer | undefined
    generation: ReadStateGeneration
  }
  export function createPointerRegressionDetector(opts: {
    record: (input: RecordInput) => void
    token: (kind: 'chat' | 'room', id: string) => Opaque
    isAhead: (candidate: ReadPointer, current: ReadPointer | undefined) => boolean
    maxTracked?: number
  }): { observe(o: PointerObservation): void; reset(): void }
  ```

`isAhead` is injected rather than imported so the detector's test states the ordering rule it is
testing against instead of inheriting it silently; `install.ts` passes the SDK's own.

The rule, in one line: record when `isAhead(previous, next)` — the pointer that was already there is
strictly ahead of the one just written — and the generation is unchanged.

- [ ] **Step 1: Write the failing test.** Cases, each named for the behaviour it protects:
  a strictly-behind write inside one generation records `bug`; an identical rewrite is silent; an
  advance is silent; the first pointer for an entity is silent; a pointer replaced after a `store`
  bump is silent; after an `entity` bump is silent; a second regression for the same entity is
  recorded again (the state follows the pointer, it does not latch); two entities are independent;
  a pointer going from defined to `undefined` is silent (a cleared pointer is a different event and
  `isAhead` has no answer for it); tracking is bounded.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement**, then add `ID.pointerRegression = 'read-state/pointer-regression'`.
- [ ] **Step 4: Add the registry row** — severity `bug`, meaning, and the named non-cases (generation
  change, identical rewrite, first observation, cleared pointer).
- [ ] **Step 5: Run it and watch it pass**, plus the parity test.
- [ ] **Step 6: Commit** — `feat(anomaly): detect a read pointer moving backwards`

---

### Task 3: Sample pointers from the stores

**Files:**
- Modify: `apps/fluux/src/anomaly/install.ts`
- Modify: `apps/fluux/src/anomaly/install.test.ts`

The chat and room subscriptions already exist. The pointer scan hangs off them, guarded on the meta
map's identity: `next.conversationMeta !== prev.conversationMeta` skips almost every store event,
since the map is only recreated when metadata actually changes.

- [ ] **Step 1: Write the failing test** — a regression driven through the mocked store
  subscription reaches the log; an advance does not.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement** the scan: for each entity whose meta reference changed, observe
  `{ kind, id, pointer, generation }`.
- [ ] **Step 4: Run it and watch it pass**, then `npx vitest run src/anomaly`.
- [ ] **Step 5: Commit** — `feat(anomaly): watch every read pointer write for a regression`

---

### Task 4: Close the slice

- [ ] **Step 1:** Add the new id to the healthy-session control in `scripts/anomaly-smoke.ts`.
- [ ] **Step 2:** Update §5.1 and §5.5 of the spec: `pointer-regression` shipped, the deletion-bump
  premise corrected, and the reader-versus-signal deviation with its reason.
- [ ] **Step 3:** Full verification — `npm test`, `npm run typecheck`, `npm run lint`, the anomaly
  Playwright project, `npm run check:anomaly:prod`.

## Self-review

**Spec coverage.** §5.5 seam 4 → Task 1, with the scoping preserved and the deviation argued.
§5.1 `pointer-regression`'s three stated rules (reset on generation, ignore the first observation,
accept an identical rewrite) → Task 2's named test cases. §6.1 (a false-positive detector is
deleted) → the generation reset and the smoke control in Task 4.

**Placeholders.** Task 1 and 2 name every case to test and the exact rule; no step says "add
appropriate handling".

**Type consistency.** `ReadStateGeneration` is defined in Task 1 and consumed under that name in
Tasks 2 and 3. `PointerObservation.pointer` is `ReadPointer | undefined`, matching
`conversationMeta.readPointer`'s optionality.
