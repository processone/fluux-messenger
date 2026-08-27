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
 *   A lost BOUNDARY advance is the same class one step removed: the restored
 *   stale anchor is closable by a later backward page, and the true hole above
 *   it is then unrecorded (see `hasGapStructuralChange`).
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
 * | gaps     | `start` / `startId` CHANGED (boundary moves up) | force-flush |
 * | gaps     | shrink / close / removal (`end` moves down)    | throttle     |
 * | coverage | record REPLACED (contiguity disproven)         | force-flush  |
 * | coverage | key REMOVED                                    | force-flush  |
 * | coverage | key ADDED (bootstrap / first-ever walk)        | throttle     |
 * | coverage | `bottomId` DEEPENED (Phase B, id-exact resume) | throttle     |
 * | coverage | `topId`-only change (re-entry marker)          | throttle     |
 *
 * The coverage half of that table is #1138's change. #1133 shipped it as
 * "key added, `bottomId` changed, or key removed → force-flush", because this
 * layer cannot order two `bottomId`s (archive ids are NON-SEQUENTIAL, see
 * `mamGap`) and so could not tell a safe deepening from an unsafe replacement.
 * Measurement showed that conservatism erased the throttle's first-session
 * benefit. The method and numbers are owned by
 * `docs/superpowers/specs/2026-07-28-coverage-persistence-cost-design.md`.
 *
 * The fix is not a cleverer comparison — no comparison exists. It is
 * {@link CoverageTransition}, computed by `syncCoverageAfterArchiveMerge`, which
 * is the only place that knows whether a walk PROVED contiguity with the record
 * it is overwriting. Creation and deepening err SHALLOW when lost (the next
 * session re-seeds or re-walks); only replacement can leave disk asserting
 * coverage that memory has disproven. See that type for the per-branch analysis.
 *
 * ## How the transition is detected
 *
 * Two mechanisms, because the two maps differ in what is derivable here:
 *
 * - **Gaps, and coverage REMOVAL, are detected locally.** Per storage key, this
 *   module remembers a SNAPSHOT of the previous write's structural signature —
 *   each gap id's lower boundary (`start` + `startId`), and the set of coverage
 *   ids — and compares the next write against it. Detection therefore lives at
 *   the single write funnel of each store (roomStore's two save helpers,
 *   chatStore's persist adapter) instead of being an obligation ~13 mutation
 *   sites must each remember.
 * - **Coverage REPLACEMENT is signalled**, via {@link noteCoverageTransition},
 *   by the one caller that can classify it. The signal is consumed by the next
 *   write on that key — which for both stores is the write the same mutation
 *   triggers, synchronously: roomStore calls `saveCoverageToStorage` on the next
 *   line, and zustand's persist adapter runs inside chatStore's `set()`. A
 *   signal that somehow found no write to attach to would force one extra flush
 *   on the following write, never skip one.
 *
 * - Keyed by the RESOLVED storage key, so a baseline can never be consulted
 *   across accounts: a different account is a different key (same principle as
 *   the eager key resolution in `schedule`).
 * - A snapshot, not the live map reference, so it is immune to a map mutated in
 *   place and to the reassigned-binding trap that `persistRoomReadState`
 *   documents.
 * - An UNKNOWN baseline (first write of a session, or after a reset) makes
 *   anything present read as structural — including a non-empty coverage map,
 *   whose ids cannot be told apart from a removal without a baseline to remove
 *   them from. That costs at most one extra flush per key per session and never
 *   a missed one.
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
import type { CoverageRecord, CoverageTransition } from './mamCoverage'

/** The maps carried by this key's blob. Omit one to leave its baseline alone. */
export interface DurableMaps {
  gaps?: ReadonlyMap<string, GapInterval>
  coverage?: ReadonlyMap<string, CoverageRecord>
}

/** A gap's lower BOUNDARY, flattened for comparison. `end`/`endId` are
 *  deliberately absent — see `hasGapStructuralChange`. */
type GapAnchor = string

function gapAnchor(gap: GapInterval): GapAnchor {
  return `${gap.start} ${gap.startId ?? ''}`
}

interface Baseline {
  /** Id → lower-boundary anchor at the previous write. */
  gapAnchors?: Map<string, GapAnchor>
  /**
   * Ids carrying a record at the previous write.
   *
   * Deliberately not the `bottomId`s: a `bottomId` change is not a
   * durability signal on its own (see the module doc), and keeping the values
   * would invite a future reader to resurrect the comparison that #1138
   * measured out.
   */
  coverageIds?: Set<string>
}

const baselines = new Map<string, Baseline>()

/**
 * Storage key → ids whose coverage record was invalidated since that key's last
 * write. Consumed and cleared by the next {@link scheduleDurableMaps} on the key.
 */
const invalidatedCoverage = new Map<string, Set<string>>()

/**
 * Report what a merge did to `id`'s coverage record, so the next write on `key`
 * can be forced out of the throttle window if it has to be.
 *
 * Callers pass the transition UNCONDITIONALLY and this decides — the policy
 * ("which transitions are unsafe to lose") belongs to the durability layer, not
 * repeated as an `=== 'replaced'` literal at each of the three call sites, where
 * adding a fourth unsafe transition would mean remembering all of them.
 *
 * Must be called BEFORE the write that carries the transition. Both stores do
 * this on the same synchronous path as the `set()` that commits it; a
 * transition that is DEFERRED behind an IndexedDB commit must be reported at
 * the deferred commit instead, not at the merge, or the signal is consumed by a
 * write that does not carry the new record yet.
 */
export function noteCoverageTransition(key: string, id: string, transition: CoverageTransition): void {
  // `created` / `deepened` / `topRefreshed` all err SHALLOW when lost, and
  // `none` changed nothing. Only a replacement can leave disk asserting
  // coverage that memory has disproven — see CoverageTransition's table.
  if (transition !== 'replaced') return
  const ids = invalidatedCoverage.get(key)
  if (ids) ids.add(id)
  else invalidatedCoverage.set(key, new Set([id]))
}

/**
 * A gap APPEARING for an id that had none, or an existing gap's lower BOUNDARY
 * (`start` / `startId`) moving. Shrink/close/removal is not structural.
 *
 * ## Why the boundary, and not just the key
 *
 * Key-presence alone does not catch an in-place interval advance: the same id's
 * gap moving from `{ start: 1000 }` to `{ start: 99000 }`. That is the normal
 * shape of a multi-page forward catch-up — each incomplete page rewrites the
 * same key with a higher hole (`syncGapAfterArchiveMerge`'s forward branch
 * mirrors `forwardGapTimestamp`, the page's newest fetched timestamp). A hard
 * kill in that window would leave memory at 99000 and disk at 1000.
 *
 * A stale LOWER anchor is not self-healing. `selectCatchUpQuery` gives a
 * recorded gap boundary priority over the cached edge ("a recorded forward gap
 * wins", `mamCatchUpUtils.ts`), so a session restored onto the stale anchor does
 * resume below the true hole — but only for as long as the stale interval
 * survives. A backward "load older" page that lands between the stale anchor and
 * the true one CLOSES it outright (`closeGapWithBackwardPage`: `oldestTs <=
 * gap.start` → `undefined`), where the true anchor would have left it standing
 * (`newestTs <= start` → unchanged). The hole above is then unrecorded while the
 * forward cursor already sits above it: silent, permanent history loss. So the
 * boundary is force-flushed too.
 *
 * ## Why `end` / `endId` are NOT in the signature
 *
 * The asymmetry is the point. `start` advancing is the hole moving UP, and its
 * loss is unrecoverable per the paragraph above. `end` shrinking is the hole
 * closing from BELOW — a stale, un-closed gap only costs a redundant re-heal,
 * which is the lagging-mirror case the throttle exists for. Design §4.2's
 * "gaps: shrink / close / removal → throttle" row still holds.
 *
 * ## Cost
 *
 * Bounded, because forward catch-up auto-pagination is bounded:
 * `MAM_CATCHUP_FORWARD_BAIL_PAGES` = 3 (`mamCatchUpUtils.ts`), and a page only
 * writes an advancing boundary when it came back INCOMPLETE. The common
 * reconnect completes on page 1 and records no gap at all. So the ceiling is
 * ≤ 3 forced writes per gapped entity per catch-up. Measured on the room gaps
 * key, boundary rule vs key-presence-only rule:
 *
 * | Scenario                                    | boundary | key-only |
 * |---------------------------------------------|----------|----------|
 * | 1 gapped room, 3-page walk                  | 3        | 3        |
 * | 10 gapped rooms, 3-page walks interleaved   | 30 (3/room) | 12 (1.2/room) |
 * | reconnect completing on page 1 (no gap)     | 0        | 0        |
 *
 * The single-room walk costs nothing extra: the formation already force-flushes
 * and CLOSES the window, so each later page takes a fresh leading edge either
 * way. The delta only appears when several gapped entities page concurrently and
 * could otherwise have shared a window — and it stays at the ≤ 3 ceiling.
 *
 * One non-catch-up path also became structural: `clearRoomGapAnchor` strips
 * `startId` when the archive purges the anchor. Rare, and one forced write.
 */
function hasGapStructuralChange(
  previous: Map<string, GapAnchor> | undefined,
  gaps: ReadonlyMap<string, GapInterval>,
): boolean {
  for (const [id, gap] of gaps) {
    if (previous?.get(id) !== gapAnchor(gap)) return true
  }
  return false
}

/**
 * A record being invalidated: REPLACED (signalled) or REMOVED (derived).
 *
 * Additions and `bottomId` advances are deliberately absent — see the module
 * doc's table and {@link CoverageTransition}. Both leave disk holding either no
 * record or a shallower one, and neither can assert coverage that does not
 * exist; force-flushing them was #1133's conservatism and #1138's measured cost.
 */
function hasCoverageRemoval(
  previous: Set<string> | undefined,
  coverage: ReadonlyMap<string, CoverageRecord>,
): boolean {
  // No baseline: a removal is undetectable (nothing to be missing FROM), so
  // anything present has to be treated as structural. One flush per key per
  // session.
  if (!previous) return coverage.size > 0
  for (const id of previous) {
    if (!coverage.has(id)) return true
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
  const gapFormed = maps.gaps !== undefined && hasGapStructuralChange(baseline?.gapAnchors, maps.gaps)
  // The signal stands on its own, independent of whether this write declares
  // the coverage map: it means "the next write on this key must be durable",
  // and consuming it without acting would silently drop a replacement. The
  // derived half (removal) still needs the map, like the gap half.
  const invalidated = invalidatedCoverage.get(key)
  invalidatedCoverage.delete(key)
  const coverageInvalidated =
    (invalidated !== undefined && invalidated.size > 0) ||
    (maps.coverage !== undefined && hasCoverageRemoval(baseline?.coverageIds, maps.coverage))

  const next: Baseline = { ...baseline }
  if (maps.gaps !== undefined) {
    const anchors = new Map<string, GapAnchor>()
    for (const [id, gap] of maps.gaps) anchors.set(id, gapAnchor(gap))
    next.gapAnchors = anchors
  }
  if (maps.coverage !== undefined) {
    next.coverageIds = new Set(maps.coverage.keys())
  }
  baselines.set(key, next)

  schedule(key, produce)
  if (gapFormed || coverageInvalidated) flushKey(key)
}

/**
 * `cancel`, plus the baseline — for every clear path that follows a `cancel`
 * with a `removeItem`. See the module doc for why the baseline cannot outlive
 * the write it describes.
 */
export function cancelDurableMaps(key: string): void {
  cancel(key)
  baselines.delete(key)
  // The cancelled write is what the signal was waiting for. Keeping it would
  // force-flush the next unrelated write on this key for a record the clear
  // path has just removed anyway.
  invalidatedCoverage.delete(key)
}

/**
 * Drop every baseline. Called from both stores' `switchAccount` (after their
 * `flush()`), and by the test reset.
 */
export function forgetAllDurableMapBaselines(): void {
  baselines.clear()
  invalidatedCoverage.clear()
}
