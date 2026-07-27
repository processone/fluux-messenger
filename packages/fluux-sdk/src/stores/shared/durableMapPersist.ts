/**
 * Throttled persistence for the gap and coverage maps, with the STRUCTURAL
 * transitions forced out of the throttle window.
 *
 * `throttledStorage` is safe for a *lagging mirror*: losing the last window's
 * write costs a re-detection or a re-walk. Gaps and coverage are only half that
 * — both modules say so themselves:
 *
 * - `mamGap`: gaps are persisted so the "Load missing messages" marker survives
 *   a reload, "otherwise the next session's catch-up cursor (which sits *above*
 *   the gap after the session-start fix) would never re-detect it". A lost gap
 *   FORMATION is therefore never re-detected — the marker stays silent forever.
 * - `mamCoverage`: a `CoverageRecord` is "POSITIVE, DURABLE data" that "must
 *   never point past data that was never stored".
 *   `syncCoverageAfterArchiveMerge`'s fetch-latest branch, when `sawCoverageTop`
 *   is false — contiguity with the existing record actively DISPROVEN — replaces
 *   the record wholesale with the walk extent, which may be far shallower. A
 *   lost REPLACEMENT (or REMOVAL) leaves the stale deeper record on disk
 *   asserting the contiguity that was just disproven, and Phase B seeds its
 *   backward walk from it, skipping the disconnected interval.
 *
 * The two compound: one crash drops the gap that would have flagged the hole
 * *and* keeps the coverage record that denies there is one.
 *
 * ## What counts as structural
 *
 * | Map      | Transition                                     | Treatment    |
 * |----------|------------------------------------------------|--------------|
 * | gaps     | key ADDED (formation)                          | force-flush  |
 * | gaps     | shrink / close / removal                       | throttle     |
 * | coverage | key ADDED, `bottomId` CHANGED, key REMOVED     | force-flush  |
 * | coverage | `topId`-only change (re-entry marker)          | throttle     |
 *
 * `bottomId`-changed is deliberately conservative: it also force-flushes the
 * *provable* deepening in `syncCoverageAfterArchiveMerge`'s plain-backward
 * branch, which would be safe to throttle. Archive ids are NON-SEQUENTIAL
 * (`mamGap`), so this layer cannot compare two `bottomId`s to tell a deepening
 * from a replacement, and distinguishing them would mean threading a
 * "was this monotone" signal out of the pure sync functions. Not worth the
 * coupling — but the cost is flush FREQUENCY, not record size, and it is not
 * zero: the coverage bootstrap fires once per entity that has no record, so the
 * FIRST session after this ships pays one forced chat-blob serialization per
 * conversation, and Phase B's read-pointer stitch advances `bottomId` on up to
 * 10 backward pages per entity per session. Both are launch-window costs on a
 * path that previously wrote unconditionally on every mutation, and the steady
 * state is free (`if (coverage.get(id)) return coverage`). Design §4.2 has the
 * full accounting.
 *
 * ## How the transition is detected
 *
 * Per storage key, this module remembers a SNAPSHOT of the previous write's
 * structural signature — the gap ids, and each coverage id's `bottomId` — and
 * compares the next write against it. Detection therefore lives at the single
 * write funnel of each store (roomStore's two save helpers, chatStore's persist
 * adapter) instead of being an obligation ~13 mutation sites must each remember.
 *
 * - Keyed by the RESOLVED storage key, so a baseline can never be consulted
 *   across accounts: a different account is a different key (same principle as
 *   the eager key resolution in `schedule`).
 * - A snapshot, not the live map reference, so it is immune to a map mutated in
 *   place and to the reassigned-binding trap that `persistRoomReadState`
 *   documents.
 * - An UNKNOWN baseline (first write of a session, or after a reset) is treated
 *   as empty, so anything present reads as structural. That costs at most one
 *   extra flush per key per session and never a missed one.
 * - `cancelDurableMaps` drops the baseline with the pending write, because a
 *   cancelled write means the disk no longer matches the baseline: keeping it
 *   would let a later formation compare equal to a state that was never
 *   persisted and skip its flush. (Concretely: `roomStore.reset` removes the
 *   gaps key and nothing re-writes it, so a formation for the same room after a
 *   re-login would otherwise look like a no-op.)
 * - `forgetAllDurableMapBaselines` is called by both stores' `switchAccount`,
 *   which `flush()`es first — so every window is already closed and the
 *   resulting force-flush on the next write has no pending thunk to write,
 *   i.e. it costs zero writes.
 *
 * @module Stores/Shared/DurableMapPersist
 */

import { schedule, flushKey, cancel } from './throttledStorage'
import type { GapInterval } from './mamGap'
import type { CoverageRecord } from './mamCoverage'

/** The maps carried by this key's blob. Omit one to leave its baseline alone. */
export interface DurableMaps {
  gaps?: ReadonlyMap<string, GapInterval>
  coverage?: ReadonlyMap<string, CoverageRecord>
}

interface Baseline {
  /** Ids that HAD a gap at the previous write. */
  gapIds?: Set<string>
  /** Id → `bottomId` at the previous write (`topId` is deliberately absent). */
  coverageBottoms?: Map<string, string>
}

const baselines = new Map<string, Baseline>()

/**
 * A gap for an id that had none is a FORMATION. Shrink/close/removal is not.
 *
 * ## The invariant key-presence rests on
 *
 * Key-ADDED does not catch an in-place interval REPLACEMENT: the same id's gap
 * moving from `{ start: 1000 }` to `{ start: 99000 }` is invisible here, and a
 * hard kill in that window leaves memory at 99000 and disk at 1000. That is the
 * normal shape of a multi-page forward catch-up — each incomplete page rewrites
 * the same key with a higher hole (`syncGapAfterArchiveMerge`'s forward branch
 * mirrors `forwardGapTimestamp`, which is the page's newest fetched timestamp).
 *
 * It is survivable, and this is the reason — without it, key-presence looks
 * arbitrary:
 *
 * - A gap's `start` / `startId` for an EXISTING key only ever move UPWARD. The
 *   forward branch sets `start` from the marker (`mamState`: the newest fetched
 *   timestamp of an incomplete forward page, and each page resumes above the
 *   last), and `startId` from that merge's `rsm.last`. The backward branch never
 *   moves `start` at all — `closeGapWithBackwardPage` only lowers `end`.
 * - So a stale record's anchor always sits BELOW the true hole, never above it.
 * - And `selectCatchUpQuery` gives a recorded gap boundary PRIORITY over the
 *   cached edge ("a recorded forward gap wins", `mamCatchUpUtils.ts`), consumed
 *   via `io.getGapStart()` / `io.getGapStartId()` in `MAM.ts`. So the next
 *   session resumes at the stale, lower anchor — BELOW the lost hole — and
 *   re-detects it.
 *
 * That is exactly the property a lost FORMATION does not have: with nothing
 * recorded, `selectCatchUpQuery` falls through to the cached edge, which sits
 * ABOVE the hole, and the gap is never re-detected. Hence "key added" is
 * sufficient rather than arbitrary.
 *
 * Adding `start` to the signature was considered and REJECTED: it would
 * force-flush every intermediate page of a forward catch-up, which is precisely
 * the burst the throttle exists to collapse.
 *
 * **Accepted residual risk.** The re-detection depends on the stale gap still
 * being there next session. If a backward "load older" page CLOSES it first —
 * `closeGapWithBackwardPage` returns `undefined` on `complete`, or when the page
 * reaches below `gap.start` — before any forward catch-up runs, the true hole
 * above the stale anchor is silent forever. It needs a crash inside the window
 * plus a scroll-up before the next catch-up; judged acceptable rather than
 * unnoticed.
 */
function hasGapFormation(previous: Set<string> | undefined, gaps: ReadonlyMap<string, GapInterval>): boolean {
  for (const id of gaps.keys()) {
    if (!previous?.has(id)) return true
  }
  return false
}

/**
 * A record appearing, its `bottomId` changing, or the record disappearing.
 *
 * `previous.get(id) !== bottomId` covers both the appearance (undefined never
 * equals a string) and the change; there is no ordering comparison here, by
 * necessity — archive ids are non-sequential.
 */
function hasCoverageStructuralChange(
  previous: Map<string, string> | undefined,
  coverage: ReadonlyMap<string, CoverageRecord>,
): boolean {
  for (const [id, record] of coverage) {
    if (previous?.get(id) !== record.bottomId) return true
  }
  if (previous) {
    for (const id of previous.keys()) {
      if (!coverage.has(id)) return true
    }
  }
  return false
}

/**
 * `schedule`, plus a `flushKey` when this write carries a structural gap or
 * coverage transition.
 *
 * `flushKey` (rather than a second serialization) is the same mechanism
 * `recordPendingRetraction` uses: the thunk `schedule` just registered is
 * either already on disk from its leading edge — in which case the flush writes
 * nothing — or sitting in the pending slot, in which case it lands now.
 */
export function scheduleDurableMaps(key: string, maps: DurableMaps, produce: () => string): void {
  const baseline = baselines.get(key)

  // Both halves are evaluated: short-circuiting would leave the skipped map
  // comparing against an older baseline, which can hide a there-and-back
  // transition (A → B → A reads as "unchanged" against the pre-A baseline).
  const gapFormed = maps.gaps !== undefined && hasGapFormation(baseline?.gapIds, maps.gaps)
  const coverageMoved = maps.coverage !== undefined && hasCoverageStructuralChange(baseline?.coverageBottoms, maps.coverage)

  const next: Baseline = { ...baseline }
  if (maps.gaps !== undefined) next.gapIds = new Set(maps.gaps.keys())
  if (maps.coverage !== undefined) {
    const bottoms = new Map<string, string>()
    for (const [id, record] of maps.coverage) bottoms.set(id, record.bottomId)
    next.coverageBottoms = bottoms
  }
  baselines.set(key, next)

  schedule(key, produce)
  if (gapFormed || coverageMoved) flushKey(key)
}

/**
 * `cancel`, plus the baseline — for every clear path that follows a `cancel`
 * with a `removeItem`. See the module doc for why the baseline cannot outlive
 * the write it describes.
 */
export function cancelDurableMaps(key: string): void {
  cancel(key)
  baselines.delete(key)
}

/**
 * Drop every baseline. Called from both stores' `switchAccount` (after their
 * `flush()`), and by the test reset.
 */
export function forgetAllDurableMapBaselines(): void {
  baselines.clear()
}
