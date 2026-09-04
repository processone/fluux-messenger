# Anomaly log stage 5d — unread diagnostic Implementation Plan

> **Status:** Superseded. The diagnostic this plan shipped was replaced by the recount reporting its
> own verdict. The detector was reconsidered and withdrawn a second time because its equal-count
> premise was also unsound; it is not shipped. The design's §5.1,
> `docs/ANOMALY_INVARIANTS.md`, and §5.5 seam 3 are the current record; everything below describes
> the state this plan left.

**Goal:** Expose an archive-derived unread count and the displayed badge **from one validated
snapshot** through a read-only SDK diagnostic.

**Architecture:** A read-only function per store walks the same coverage gates the real recount
walks, calls the same archive counter, and returns `exact` only when nothing moved underneath it.
It writes nothing: no recount version bump, no transient prune, no coverage invalidation.

**Tech Stack:** TypeScript, Zustand vanilla stores, vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-client-anomaly-detection-log-design.md` §5.1, §5.5
seam 3. Predecessors: the 5a, 5b and 5c plans in this directory.

> **Outcome at the time:** The diagnostic shipped and was exported; the proposed detector and its
> wiring were withdrawn by the decision recorded in the design's §5.1. A later attempt based on
> equal recount counts was withdrawn too. Read §5.1, `docs/ANOMALY_INVARIANTS.md`, and §5.5 seam 3,
> not this plan, for the current outcome.

## Why this is not a thin wrapper over the recount

`recomputeUnreadForConversation` (`chatStore.ts:2690-2855`) and `recomputeUnreadForRoom`
(`roomStore.ts:2541-2700`) cannot be reused as-is, and not for style reasons. Their prelude has
three side effects a diagnostic must not have:

1. `bumpChatRecountVersion` / `bumpRoomRecountVersion` — the latest-wins token. A diagnostic that
   bumped it would **cancel a real recount already in flight**, turning an observer into a cause.
2. `pruneTransient` — it edits the transient unread overlay.
3. `clearConversationCoverage` on an unresolvable bottom — it invalidates a persisted record.

So the diagnostic is a **second traversal of the same gates**, side-effect free, calling the same
helpers (`computeFloor`, `isCaughtUpForCounting`, `resolveCoverageBottom`, `isAfterBoundary`,
`countUnreadInArchive` / `countRoomUnreadInArchive`, `transientCounts`). Two traversals can drift
apart, and the mitigation is not a comment: **an agreement test** provokes each reachable gate and
asserts the recount's own deferral tally and the diagnostic name the same reason.

What it must NOT do is what §5.1 already rules out: counting from the resident or bounded-cache
slice. That would recreate the under-count class the diagnostic exists to expose, making its result
unreliable exactly when the discrepancy needs investigation.

## Global Constraints

- **Read-only.** No store write, no version bump, no prune, no coverage change, on any path.
- **One snapshot.** `archiveCount` and `badgeCount` are validated against the same unmoved context:
  the badge is read last, and the context check runs after it.
- **Only `exact` may be compared.** `deferred` means the coverage gate declined — the real recount
  would have declined too. `stale` means the inputs moved mid-computation. Neither is evidence of a
  bug, and treating either as a mismatch would make the detector fire during ordinary catch-up.
- **Exported seam.** `chatUnreadDiagnostic` and `roomUnreadDiagnostic` remain public SDK diagnostics.

---

### Task 1: The diagnostic

**Files:**
- Create: `packages/fluux-sdk/src/stores/shared/unreadDiagnostic.ts`
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts`, `packages/fluux-sdk/src/stores/roomStore.ts`,
  `packages/fluux-sdk/src/index.ts`
- Test: `packages/fluux-sdk/src/stores/unreadDiagnostic.test.ts`

**Interfaces:**
```typescript
export interface UnreadDiagnostic {
  status: 'exact' | 'deferred' | 'stale'
  /** Archive-derived, including the transient overlay. Only on `exact`. */
  archiveCount?: number
  /** What the badge displays. Only on `exact`. */
  badgeCount?: number
  /** Which gate stood down. Only on `deferred`. */
  reason?: RecountDeferralReason
}
export function chatUnreadDiagnostic(conversationId: string): Promise<UnreadDiagnostic>
export function roomUnreadDiagnostic(roomJid: string): Promise<UnreadDiagnostic>
```

`reason` goes beyond the spec's shape on purpose: the app already folds recount deferral tallies
(#1211), and a `deferred` with no reason would be the one diagnostic in this system that says
something is unknown without saying why.

- [x] **Step 1: Write the failing test** — `exact` returns both counts and they agree on a healthy
  conversation; a conversation with no coverage record defers with `coverage-missing`; a history
  that is not caught up defers with `history-not-caught-up`; a pointerless entity defers; a
  mismatched badge still reports `exact` with the two different numbers (the diagnostic reports, it
  does not judge); the room twin behaves the same.
- [x] **Step 2: Run it and watch it fail.**
- [x] **Step 3: Implement** both functions beside their recounts, each carrying a comment binding it
  to its twin.
- [x] **Step 4: Write the agreement test** — for each reachable gate, drive the real recount and the
  diagnostic against the same state and assert they name the same reason. Reachable here means
  observable through the store: `no-meta`, `pointerless-defer`, `no-floor`,
  `history-not-caught-up`, `coverage-missing`, `coverage-short-of-floor`, `cache-unavailable`, and
  the `exact` path. The race reasons (`recount-superseded`, `input-version-changed`,
  `context-changed`) map to `stale` by design and are stated as such rather than asserted equal.
- [x] **Step 5: Run both, plus the two store suites** — the recount is the most guarded function in
  the read-state system and must be untouched.
- [x] **Step 6: Commit** — `feat(sdk): expose the archive-derived unread count beside the badge`

---

### Task 2: The detector — withdrawn

This task and its wiring are not implemented. The reason is maintained in the
[design decision in §5.1](../specs/2026-07-29-client-anomaly-detection-log-design.md#51-read-state).
No detector id, invariant-registry row, installer wiring, or healthy-session control ships.

## Self-review

**Spec coverage.** §5.5 seam 3 → Task 1, including the "both counts from one guarded snapshot"
requirement that removes the need for a public revalidation operation. The withdrawn detector is
owned by the §5.1 decision linked from Task 2.

**Placeholders.** Every task names its cases and its exact symbols.

**Type consistency.** `UnreadDiagnostic` and `RecountDeferralReason` are the SDK's exported types.
