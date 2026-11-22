import {
  advancePhaseIfCurrent,
  cancelReconciliationForUserInput,
  resolveReachability,
  type AnchorPreservationRequest,
  type DirectionalHistoryRequest,
  type ExplicitTargetRequest,
  type LiveEdgeRequest,
  type PositioningPhase,
  type ReachabilityFacts,
  type ResidentTopRequest,
  type SavedPositionRequest,
  type UnavailablePolicy,
  type UnreadMarkerRequest,
} from './scrollPositionModel'
import type {
  AnchorPreservationCompletion,
  AnchorPreservationExecutor,
  AnchorPreservationFrameResult,
  DirectionalHistoryCompletion,
  DirectionalHistoryExecutor,
  DirectionalHistoryFrameResult,
  ExplicitTargetCompletion,
  ExplicitTargetExecutor,
  ExplicitTargetFrameResult,
  LiveEdgeCompletion,
  LiveEdgeExecutor,
  LiveEdgeFrameResult,
  PositionExecutionLease,
  ResidentTopCompletion,
  ResidentTopExecutor,
  ResidentTopStartResult,
  SavedPositionCompletion,
  SavedPositionExecutor,
  SavedPositionFrameResult,
  UnreadMarkerCompletion,
  UnreadMarkerExecutor,
  UnreadMarkerFrameResult,
  UnreadMarkerGeometry,
} from './positionExecutors'
import {
  advanceDriftConvergence,
  HELD_WRITE_FRAMES,
  mintPositionGeneration,
  reachabilityMatchesRequest,
  waitForHeldWrite,
  withIdentity,
  type PlacementStrategy,
  type PositionRequestDraft,
  type PositionRun,
  type PositionRunner,
} from './positionRunner'

/**
 * The seven placement strategies. Each states only what makes its path that path: how a frame is
 * judged, when the run is done, and what it tells its executor. The runner owns the rest.
 *
 * The budgets, tolerances and ordering below are the values the former path-named lifecycle
 * methods carried; the frame-by-frame trace test pins them.
 */

const EXPLICIT_TARGET_REASSERT_FRAMES = 30
const EXPLICIT_TARGET_STABLE_FRAMES = 4
const EXPLICIT_TARGET_DRIFT_PX = 16
const RESIDENT_TOP_OBSERVE_FRAMES = 120
const RESIDENT_TOP_STABLE_FRAMES = 2
const RESIDENT_TOP_TOLERANCE_PX = 1
// Preserved from the former hook-local restore-anchor loop.
const SAVED_POSITION_REASSERT_FRAMES = 90
const SAVED_POSITION_STABLE_FRAMES = 8
const SAVED_POSITION_DRIFT_PX = 8
const UNREAD_MARKER_REASSERT_FRAMES = 120
const UNREAD_MARKER_STABLE_FRAMES = 8
const UNREAD_MARKER_DRIFT_PX = 16
const UNREAD_MARKER_TAKEOVER_DRIFT_PX = 300
// Preserved from the former hook-local pinVirtualizedBottom loop.
const LIVE_EDGE_REASSERT_FRAMES = 60
const LIVE_EDGE_STABLE_FRAMES = 8
// Preserved from the former standalone media-anchor loop.
const ANCHOR_PRESERVATION_REASSERT_FRAMES = 90
const ANCHOR_PRESERVATION_STABLE_FRAMES = 8
const ANCHOR_PRESERVATION_DRIFT_PX = 8
// Preserved from the former hook-local prepend/window-shift loop. It intentionally has no
// early-stable exit because virtualizer measurements can arrive late after several quiet frames.
const DIRECTIONAL_HISTORY_REASSERT_FRAMES = 60

type Runner = PositionRunner
type Lease = PositionExecutionLease
type PendingNotIndexed = Extract<PositioningPhase, { kind: 'pending' }>
const TARGET_NOT_INDEXED: PendingNotIndexed = { kind: 'pending', reason: 'target-not-indexed' }

type SavedRun = PositionRun<SavedPositionRequest, SavedPositionExecutor>
type UnreadRun = PositionRun<UnreadMarkerRequest, UnreadMarkerExecutor>
type ExplicitRun = PositionRun<ExplicitTargetRequest, ExplicitTargetExecutor>
type ResidentTopRun = PositionRun<ResidentTopRequest, ResidentTopExecutor>
type LiveEdgeRun = PositionRun<LiveEdgeRequest, LiveEdgeExecutor>
type AnchorRun = PositionRun<AnchorPreservationRequest, AnchorPreservationExecutor>
type DirectionalRun = PositionRun<DirectionalHistoryRequest, DirectionalHistoryExecutor>

/** The conversation a run belongs to, for the shadow records it makes. */
function conversationOf(run: { request: { conversationId: string } }): string {
  return run.request.conversationId
}

// ── Live edge ──────────────────────────────────────────────────────────────────────────────────

export function acceptLiveEdge(
  r: Runner,
  conversationId: string,
  source: LiveEdgeRequest['source'],
  executor: LiveEdgeExecutor,
  purpose: LiveEdgeRun['purpose'] = 'maintenance',
): LiveEdgeRequest | null {
  const request = {
    generation: mintPositionGeneration(),
    conversationId,
    source,
    desired: { kind: 'live-edge', follow: true },
  } as LiveEdgeRequest
  const reachability = r.probe<ReachabilityFacts | null>(
    conversationId,
    'live-edge-reachability',
    null,
    () => executor.reachability(),
  )
  if (!reachability || !reachabilityMatchesRequest(request, reachability)) return null
  if (!r.admit(request, resolveReachability(request, reachability))) return null
  startLiveEdgeRun(r, request, executor, purpose)
  return request
}

/** Install a live-edge run for `request` and drive it. */
export function startLiveEdgeRun(
  r: Runner,
  request: LiveEdgeRequest,
  executor: LiveEdgeExecutor,
  purpose: LiveEdgeRun['purpose'] = 'maintenance',
): LiveEdgeRun {
  const run = r.create(liveEdgeStrategy, request, executor, LIVE_EDGE_REASSERT_FRAMES, { purpose })
  r.install(run)
  driveLiveEdge(r, run)
  return run
}

/** Run a new live-edge operation on a run the reader's append already placed once. */
export function restartLiveEdge(r: Runner, run: LiveEdgeRun, executor: LiveEdgeExecutor): void {
  r.finishLoop(run)
  run.abortController?.abort()
  completeLiveEdge(r, run, 'restarted')
  run.executor = executor
  run.operation += 1
  run.abortController = null
  run.lastRecenterVersion = null
  run.framesLeft = LIVE_EDGE_REASSERT_FRAMES
  run.heldFramesLeft = HELD_WRITE_FRAMES
  run.stableFrames = 0
  run.completed = false
  driveLiveEdge(r, run)
}

export function driveLiveEdge(r: Runner, run: LiveEdgeRun): void {
  if (!r.isCurrent(run) || run.loop) return
  const reachability = r.probe<ReachabilityFacts | null>(
    conversationOf(run),
    'live-edge-drive-reachability',
    null,
    () => run.executor.reachability(),
  )
  if (!reachability || !reachabilityMatchesRequest(run.request, reachability)) {
    settleLiveEdgeBestEffort(r, run)
    return
  }
  const phase = resolveReachability(run.request, reachability)
  r.advance(run, phase)
  if (!r.isCurrent(run)) return
  if (phase.kind === 'recentering-live-edge') {
    r.recenter(run, 'live-edge-recenter', run.executor.recenter, run.executor.recenterVersion, () =>
      startLiveEdgeLoop(r, run),
    )
  } else if (
    phase.kind === 'mounting' ||
    phase.kind === 'reconciling' ||
    // Preserve the legacy best-resident-edge fallback when the sliding window cannot recenter.
    phase.kind === 'unavailable'
  ) {
    startLiveEdgeLoop(r, run)
  }
}

function startLiveEdgeLoop(r: Runner, run: LiveEdgeRun): void {
  if (!r.isCurrent(run) || run.loop) return
  run.framesLeft = LIVE_EDGE_REASSERT_FRAMES
  run.heldFramesLeft = HELD_WRITE_FRAMES
  run.stableFrames = 0
  run.completed = false
  const lease = r.beginOperation(run)

  // Preserve the immediate write used by entry, FAB, outgoing send, and layout stimuli. Only
  // virtualized measurement settling moves to scheduled controller frames.
  const initial = r.position<LiveEdgeFrameResult>(run, 'live-edge-frame', lease, { kind: 'unavailable' })
  if (!lease.isCurrent()) return
  if (initial.kind === 'unavailable') {
    settleLiveEdgeBestEffort(r, run, lease)
    return
  }
  lease.markApplied()
  if (!lease.isCurrent()) return
  // A held first write lands once the fling ends: the frame loop waits for it.
  if (initial.kind === 'positioned' && !initial.reassert) {
    settleLiveEdge(r, run, lease, 'settled')
    return
  }
  if (!r.adopt(run, lease)) return
  r.schedule(run, lease)
}

function liveEdgeFrame(r: Runner, run: LiveEdgeRun, lease: Lease): void {
  if (!lease.isCurrent()) return
  if (run.framesLeft-- <= 0) {
    settleLiveEdge(r, run, lease, 'best-effort')
    return
  }
  const result = r.position<LiveEdgeFrameResult>(run, 'live-edge-frame', lease, { kind: 'unavailable' })
  if (!lease.isCurrent()) return
  if (result.kind === 'unavailable') {
    settleLiveEdge(r, run, lease, 'best-effort')
    return
  }
  // The list is not at the edge yet, so the frame is not stable either.
  if (result.kind === 'held') {
    waitForHeldWrite(run)
    run.stableFrames = 0
    r.record(run, false)
    r.schedule(run, lease)
    return
  }
  if (!result.reassert) {
    r.record(run, result.wrote)
    settleLiveEdge(r, run, lease, 'settled')
    return
  }
  run.stableFrames = result.wrote ? 0 : run.stableFrames + 1
  r.record(run, result.wrote)
  if (run.stableFrames >= LIVE_EDGE_STABLE_FRAMES) {
    settleLiveEdge(r, run, lease, 'settled')
    return
  }
  r.schedule(run, lease)
}

function settleLiveEdgeBestEffort(r: Runner, run: LiveEdgeRun, existingLease?: Lease): void {
  if (!r.isCurrent(run)) return
  settleLiveEdge(r, run, existingLease ?? r.beginOperation(run), 'best-effort')
}

function settleLiveEdge(
  r: Runner,
  run: LiveEdgeRun,
  lease: Lease,
  outcome: Extract<LiveEdgeCompletion, 'settled' | 'best-effort'>,
): void {
  if (!lease.isCurrent()) return
  // From here on the edge is only maintained: a later re-pin does not own the reader's fling.
  run.purpose = 'maintenance'
  r.finishLoop(run)
  completeLiveEdge(r, run, outcome)
  lease.settle()
}

function completeLiveEdge(r: Runner, run: LiveEdgeRun, outcome: LiveEdgeCompletion): void {
  if (run.completed) return
  run.completed = true
  r.probe(conversationOf(run), 'live-edge-complete', undefined, () =>
    run.executor.complete(run.request, outcome),
  )
}

/** A live-edge run drives while idle: used when the executor changes under a pending run. */
export function refreshLiveEdge(r: Runner, run: LiveEdgeRun, executor: LiveEdgeExecutor): void {
  if (run.loop) return
  run.executor = executor
  const phase = r.model.active?.phase.kind
  if (
    phase === 'resolving' ||
    phase === 'pending' ||
    phase === 'recentering-live-edge' ||
    phase === 'mounting' ||
    phase === 'reconciling' ||
    phase === 'unavailable'
  ) {
    driveLiveEdge(r, run)
  }
}

export const liveEdgeStrategy: PlacementStrategy = {
  kind: 'live-edge',
  events: {
    loopStart: 'live-edge-loop-start',
    loopStaleFinish: 'live-edge-loop-stale-finish',
    loopFinish: 'live-edge-loop-finish',
    frameSchedule: 'live-edge-frame-schedule',
    frameMonitor: 'live-edge-frame-monitor',
  },
  frame: liveEdgeFrame,
  abandon: (r, run, lease) => settleLiveEdge(r, run, lease, 'best-effort'),
  cancel: (r, run, outcome) =>
    r.teardown(run, () => completeLiveEdge(r, run, outcome as LiveEdgeCompletion)),
}

// ── Anchor preservation (media, layout and interaction hold) ──────────────────────────────────

export function beginAnchorRun(
  r: Runner,
  input: {
    conversationId: string
    source: AnchorPreservationRequest['source']
    desired: AnchorPreservationRequest['desired']
    executor: AnchorPreservationExecutor
  },
): AnchorPreservationRequest | null {
  const request = withIdentity(input.conversationId, mintPositionGeneration(), {
    source: input.source,
    desired: input.desired,
    onUnavailable: { kind: 'warn-and-stop' },
  } as PositionRequestDraft) as AnchorPreservationRequest
  const reachability = r.probe<ReachabilityFacts | null>(
    input.conversationId,
    `${input.source.kind}-reachability`,
    null,
    () => input.executor.reachability(request.desired),
  )
  if (!reachability) return null
  if (!reachabilityMatchesRequest(request, reachability)) return null
  if (!r.admit(request, resolveReachability(request, reachability))) return null
  driveAnchor(r, installAnchorRun(r, request, input.executor))
  return request
}

/** Install an anchor run for a request the model already holds. The caller drives it. */
export function installAnchorRun(
  r: Runner,
  request: AnchorPreservationRequest,
  executor: AnchorPreservationExecutor,
): AnchorRun {
  const run = r.create(anchorStrategy, request, executor, ANCHOR_PRESERVATION_REASSERT_FRAMES)
  r.install(run)
  return run
}

export function driveAnchor(r: Runner, run: AnchorRun): void {
  if (!r.isCurrent(run)) return
  const phase = r.model.active?.phase
  if (!phase) return
  if (phase.kind === 'mounting' || phase.kind === 'reconciling') {
    startAnchorLoop(r, run)
    return
  }
  if (phase.kind === 'unavailable' || phase.kind === 'pending') {
    settleAnchor(r, run, r.beginOperation(run), 'best-effort')
  }
}

function startAnchorLoop(r: Runner, run: AnchorRun): void {
  if (!r.isCurrent(run) || run.loop) return
  run.framesLeft = ANCHOR_PRESERVATION_REASSERT_FRAMES
  run.stableFrames = 0
  run.landedTarget = null
  const lease = r.beginOperation(run)
  const initial = positionAnchorFrame(r, run, lease)
  if (!lease.isCurrent()) return
  if (initial.kind === 'unavailable') {
    settleAnchor(r, run, lease, 'best-effort')
    return
  }
  lease.markApplied()
  if (!lease.isCurrent()) return
  if (!initial.reassert) {
    settleAnchor(r, run, lease, 'settled')
    return
  }
  if (!r.adopt(run, lease)) return
  r.schedule(run, lease)
}

function anchorFrame(r: Runner, run: AnchorRun, lease: Lease): void {
  if (!lease.isCurrent()) return
  if (run.framesLeft-- <= 0) {
    settleAnchor(r, run, lease, 'best-effort')
    return
  }
  const result = positionAnchorFrame(r, run, lease)
  if (!lease.isCurrent()) return
  if (result.kind === 'unavailable') {
    settleAnchor(r, run, lease, 'best-effort')
    return
  }
  if (!result.reassert) {
    settleAnchor(r, run, lease, 'settled')
    return
  }
  const step = advanceDriftConvergence(
    run,
    result.scrollTop,
    ANCHOR_PRESERVATION_DRIFT_PX,
    ANCHOR_PRESERVATION_STABLE_FRAMES,
  )
  r.record(run, step.moved)
  if (step.settles) {
    settleAnchor(r, run, lease, 'settled')
    return
  }
  r.schedule(run, lease)
}

function positionAnchorFrame(r: Runner, run: AnchorRun, lease: Lease): AnchorPreservationFrameResult {
  r.probe(conversationOf(run), 'anchor-preservation-observe-geometry', undefined, () =>
    run.executor.observeGeometry(),
  )
  if (!lease.isCurrent()) return { kind: 'unavailable' }
  return r.position<AnchorPreservationFrameResult>(run, 'anchor-preservation-frame', lease, {
    kind: 'unavailable',
  })
}

function completeAnchor(r: Runner, run: AnchorRun, outcome: AnchorPreservationCompletion): void {
  r.probe(conversationOf(run), 'anchor-preservation-complete', undefined, () =>
    run.executor.complete(run.request, outcome),
  )
}

function settleAnchor(
  r: Runner,
  run: AnchorRun,
  lease: Lease,
  outcome: Extract<AnchorPreservationCompletion, 'settled' | 'best-effort'>,
): void {
  if (!lease.isCurrent()) return
  r.finishLoop(run)
  completeAnchor(r, run, outcome)
  lease.settle()
  run.abortController?.abort()
  r.release(run)
}

export const anchorStrategy: PlacementStrategy = {
  kind: 'anchor-preservation',
  events: {
    loopStart: 'anchor-preservation-loop-start',
    loopStaleFinish: 'anchor-preservation-loop-stale-finish',
    loopFinish: 'anchor-preservation-loop-finish',
    frameSchedule: 'anchor-preservation-frame-schedule',
    frameMonitor: 'anchor-preservation-frame-monitor',
  },
  frame: anchorFrame,
  abandon: (r, run, lease) => settleAnchor(r, run, lease, 'best-effort'),
  cancel: (r, run, outcome) =>
    r.teardown(run, () => completeAnchor(r, run, outcome as AnchorPreservationCompletion)),
}

// ── Directional history ───────────────────────────────────────────────────────────────────────

export function beginDirectionalRun(
  r: Runner,
  input: {
    conversationId: string
    desired: DirectionalHistoryRequest['desired']
    distanceFromBottom: number
    executor: DirectionalHistoryExecutor
  },
): DirectionalHistoryRequest | null {
  const request = withIdentity(input.conversationId, mintPositionGeneration(), {
    source: { kind: 'history-preservation', reason: 'window-shift' },
    desired: input.desired,
    onUnavailable: { kind: 'distance-from-bottom', distancePx: input.distanceFromBottom },
  } as PositionRequestDraft) as DirectionalHistoryRequest
  if (!r.admit(request, { kind: 'pending', reason: 'window-shift' })) return null
  r.install(
    r.create(directionalStrategy, request, input.executor, DIRECTIONAL_HISTORY_REASSERT_FRAMES),
  )
  return request
}

/** Resume a pending directional restore once its window shift landed. */
export function reconcileDirectional(
  r: Runner,
  run: DirectionalRun,
  executor: DirectionalHistoryExecutor,
): boolean {
  run.executor = executor
  const reachability = run.executor.reachability(run.request.desired)
  if (!reachabilityMatchesRequest(run.request, reachability)) {
    r.cancel('directional-history', 'superseded')
    return false
  }
  const phase = resolveReachability(run.request, reachability)
  r.advance(run, phase)
  if (phase.kind !== 'mounting' && phase.kind !== 'reconciling' && phase.kind !== 'unavailable') {
    return false
  }
  startDirectionalLoop(r, run)
  return run.applied
}

function startDirectionalLoop(r: Runner, run: DirectionalRun): void {
  if (!r.isCurrent(run) || run.loop || run.applied) return
  run.framesLeft = DIRECTIONAL_HISTORY_REASSERT_FRAMES
  const lease = r.beginOperation(run)
  const initial = r.position<DirectionalHistoryFrameResult>(run, 'directional-history-frame', lease, {
    kind: 'unavailable',
  })
  if (!lease.isCurrent()) return
  if (initial.kind === 'unavailable') {
    settleDirectional(r, run, lease, 'best-effort')
    return
  }
  run.applied = true
  lease.markApplied()
  if (!lease.isCurrent()) return
  completeDirectional(r, run, 'applied')
  if (!initial.reassert) {
    settleDirectional(r, run, lease, 'settled')
    return
  }
  if (!r.adopt(run, lease)) return
  r.schedule(run, lease)
}

function directionalFrame(r: Runner, run: DirectionalRun, lease: Lease): void {
  if (!lease.isCurrent()) return
  if (run.framesLeft-- <= 0) {
    settleDirectional(r, run, lease, 'best-effort')
    return
  }
  const result = r.position<DirectionalHistoryFrameResult>(run, 'directional-history-frame', lease, {
    kind: 'unavailable',
  })
  if (!lease.isCurrent()) return
  if (result.kind === 'unavailable') {
    settleDirectional(r, run, lease, 'best-effort')
    return
  }
  r.record(run, result.wrote)
  if (!result.reassert) {
    settleDirectional(r, run, lease, 'settled')
    return
  }
  r.schedule(run, lease)
}

function completeDirectional(
  r: Runner,
  run: DirectionalRun,
  outcome: DirectionalHistoryCompletion,
): void {
  r.probe(conversationOf(run), 'directional-history-complete', undefined, () =>
    run.executor.complete(run.request, outcome),
  )
}

function settleDirectional(
  r: Runner,
  run: DirectionalRun,
  lease: Lease,
  outcome: Extract<DirectionalHistoryCompletion, 'settled' | 'best-effort'>,
): void {
  if (!lease.isCurrent()) return
  r.finishLoop(run)
  completeDirectional(r, run, outcome)
  lease.settle()
  run.abortController?.abort()
  r.release(run)
}

export const directionalStrategy: PlacementStrategy = {
  kind: 'directional-history',
  events: {
    loopStart: 'directional-history-loop-start',
    loopStaleFinish: 'directional-history-loop-stale-finish',
    loopFinish: 'directional-history-loop-finish',
    frameSchedule: 'directional-history-frame-schedule',
    frameMonitor: 'directional-history-frame-monitor',
  },
  frame: directionalFrame,
  abandon: (r, run, lease) => settleDirectional(r, run, lease, 'best-effort'),
  cancel: (r, run, outcome) =>
    r.teardown(run, () => completeDirectional(r, run, outcome as DirectionalHistoryCompletion)),
}

// ── Resident top ──────────────────────────────────────────────────────────────────────────────

export function beginResidentTop(
  r: Runner,
  conversationId: string,
  executor: ResidentTopExecutor,
): ResidentTopRequest | null {
  const request = withIdentity(conversationId, mintPositionGeneration(), {
    source: { kind: 'user-navigation', reason: 'resident-top' },
    desired: { kind: 'resident-top' },
  } as PositionRequestDraft) as ResidentTopRequest
  const reachability = r.probe<ReachabilityFacts | null>(
    conversationId,
    'resident-top-reachability',
    null,
    () => executor.reachability(),
  )
  if (
    !reachability ||
    reachability.kind === 'empty-window' ||
    !reachabilityMatchesRequest(request, reachability)
  ) {
    return null
  }
  if (!r.admit(request, resolveReachability(request, reachability))) return null
  const run = r.create(residentTopStrategy, request, executor, RESIDENT_TOP_OBSERVE_FRAMES)
  r.install(run)
  startResidentTop(r, run)
  return request
}

function startResidentTop(r: Runner, run: ResidentTopRun): void {
  if (!r.isCurrent(run) || run.loop) return
  run.framesLeft = RESIDENT_TOP_OBSERVE_FRAMES
  run.stableFrames = 0
  const lease = r.beginOperation(run)
  if (!r.adopt(run, lease)) return

  const started = r.probe<ResidentTopStartResult>(
    conversationOf(run),
    'resident-top-start',
    { kind: 'unavailable' },
    () => run.executor.start(run.request, lease),
  )
  if (!lease.isCurrent()) return
  if (started.kind === 'unavailable') {
    abandonResidentTop(r, run, lease)
    return
  }
  r.record(run, true)
  if (!lease.markApplied()) return
  r.schedule(run, lease)
}

function residentTopFrame(r: Runner, run: ResidentTopRun, lease: Lease): void {
  if (!lease.isCurrent()) return
  run.framesLeft -= 1
  const scrollTop = r.probe<number | null>(conversationOf(run), 'resident-top-position-frame', null, () =>
    run.executor.positionFrame(lease),
  )
  if (!lease.isCurrent()) return
  if (scrollTop === null) {
    abandonResidentTop(r, run, lease)
    return
  }
  run.stableFrames = scrollTop <= RESIDENT_TOP_TOLERANCE_PX ? run.stableFrames + 1 : 0
  r.record(run, false)
  if (run.stableFrames >= RESIDENT_TOP_STABLE_FRAMES) {
    lease.settle()
    completeResidentTop(r, run, 'settled')
    return
  }
  if (run.framesLeft <= 0) {
    abandonResidentTop(r, run, lease)
    return
  }
  r.schedule(run, lease)
}

function abandonResidentTop(r: Runner, run: ResidentTopRun, lease: Lease): void {
  lease.settle()
  completeResidentTop(r, run, 'best-effort')
}

function completeResidentTop(r: Runner, run: ResidentTopRun, outcome: ResidentTopCompletion): void {
  r.teardown(
    run,
    () =>
      r.probe(conversationOf(run), 'resident-top-complete', undefined, () =>
        run.executor.complete(run.request, outcome),
      ),
    true,
  )
}

export const residentTopStrategy: PlacementStrategy = {
  kind: 'resident-top',
  events: {
    loopStart: 'resident-top-loop-start',
    loopStaleFinish: 'resident-top-loop-stale-finish',
    loopFinish: 'resident-top-loop-finish',
    frameSchedule: 'resident-top-frame-schedule',
    frameMonitor: 'resident-top-frame-monitor',
  },
  frame: residentTopFrame,
  abandon: abandonResidentTop,
  cancel: (r, run, outcome) => completeResidentTop(r, run, outcome as ResidentTopCompletion),
}

// ── Explicit target ───────────────────────────────────────────────────────────────────────────

export function beginExplicitTargetRun(
  r: Runner,
  input: { conversationId: string; messageId: string; executor: ExplicitTargetExecutor },
): ExplicitTargetRequest | null {
  const current = r.slot('explicit-target') as ExplicitRun | null
  if (
    current &&
    current.purpose === 'navigation' &&
    r.isCurrent(current) &&
    current.request.conversationId === input.conversationId &&
    current.request.desired.messageId === input.messageId
  ) {
    current.executor = input.executor
    driveExplicitTarget(r, current)
    return current.request
  }

  const request = withIdentity(input.conversationId, mintPositionGeneration(), {
    source: { kind: 'user-navigation', reason: 'message-target' },
    desired: { kind: 'message', messageId: input.messageId, align: 'center' },
    onUnavailable: { kind: 'wait' },
  } as PositionRequestDraft) as ExplicitTargetRequest
  const reachability = input.executor.reachability(
    request.desired,
    input.executor.loadAround ? 'available' : 'unavailable',
  )
  if (!reachabilityMatchesRequest(request, reachability)) return null
  if (!r.admit(request, resolveReachability(request, reachability))) return null
  startExplicitTargetRun(r, request, input.executor, 'navigation')
  return request
}

/** Install an explicit-target run for `request` and drive it. */
export function startExplicitTargetRun(
  r: Runner,
  request: ExplicitTargetRequest,
  executor: ExplicitTargetExecutor,
  purpose: ExplicitRun['purpose'],
): void {
  const run = r.create(explicitTargetStrategy, request, executor, EXPLICIT_TARGET_REASSERT_FRAMES, {
    purpose,
  })
  r.install(run)
  driveExplicitTarget(r, run)
}

export function driveExplicitTarget(r: Runner, run: ExplicitRun): void {
  if (!r.isCurrent(run) || run.loop) return
  const loadAround = r.loadAroundStatus(run)
  const reachability = r.probe<ReachabilityFacts | null>(
    conversationOf(run),
    'explicit-target-reachability',
    null,
    () => run.executor.reachability(run.request.desired, loadAround),
  )
  if (!reachability) return

  const phase = resolveReachability(run.request, reachability)
  r.advance(run, phase)
  if (!r.isCurrent(run)) return

  if (phase.kind === 'loading-around') {
    r.loadAround(run, 'explicit-target-load-around', phase.messageId, () =>
      driveExplicitTarget(r, run),
    )
  } else if (phase.kind === 'mounting' || phase.kind === 'reconciling') {
    run.loadingAround = false
    startExplicitTargetLoop(r, run)
  } else if (phase.kind === 'unavailable') {
    // Explicit navigation has `onUnavailable: wait`; retain the request so a later resident
    // window refresh can make it reachable.
    r.advance(run, TARGET_NOT_INDEXED)
  }
}

function startExplicitTargetLoop(r: Runner, run: ExplicitRun): void {
  if (!r.isCurrent(run) || run.loop) return
  run.framesLeft = EXPLICIT_TARGET_REASSERT_FRAMES
  run.heldFramesLeft = HELD_WRITE_FRAMES
  run.stableFrames = 0
  run.landedTarget = null
  run.applied = false
  const lease = r.beginOperation(run)
  if (!r.adopt(run, lease)) return
  r.schedule(run, lease)
}

function explicitTargetFrame(r: Runner, run: ExplicitRun, lease: Lease): void {
  if (!lease.isCurrent()) return
  if (run.framesLeft-- <= 0) {
    if (run.applied) finishExplicitTarget(r, run, true, 'best-effort')
    else markTargetNotIndexed(r, run)
    return
  }

  r.probe(conversationOf(run), 'explicit-target-observe-geometry', undefined, () =>
    run.executor.observeGeometry(),
  )
  if (!lease.isCurrent()) return

  const result = r.position<ExplicitTargetFrameResult>(run, 'explicit-target-frame', lease, {
    kind: 'unavailable',
  })
  if (!lease.isCurrent()) return

  if (result.kind === 'waiting') {
    r.record(run, false)
    r.schedule(run, lease)
    return
  }
  // The jump wrote, so it is applied as far as its completion goes, but nothing landed: near its
  // end a fling moves less than the settling drift on each frame, and counting those frames would
  // settle the jump on the fling's position before its write lands.
  if (result.kind === 'held') {
    run.applied = true
    waitForHeldWrite(run)
    r.record(run, false)
    r.schedule(run, lease)
    return
  }
  if (result.kind === 'unavailable') {
    markTargetNotIndexed(r, run)
    return
  }

  run.applied = true
  lease.markApplied()
  if (!lease.isCurrent()) return

  const step = advanceDriftConvergence(
    run,
    result.scrollTop,
    EXPLICIT_TARGET_DRIFT_PX,
    EXPLICIT_TARGET_STABLE_FRAMES,
  )
  // Reports the adapter's own write, not `step.moved`. A jump to a named message is judged by
  // whether it acted this frame; the drift question only decides when it has arrived.
  r.record(run, result.wrote)
  if (step.settles) {
    finishExplicitTarget(r, run, true, 'settled')
    return
  }
  r.schedule(run, lease)
}

/** The target is not in the resident window: stop the loop and wait for a later refresh. */
function markTargetNotIndexed(r: Runner, run: ExplicitRun): void {
  r.finishLoop(run)
  r.advance(run, TARGET_NOT_INDEXED)
}

export function finishExplicitTarget(
  r: Runner,
  run: ExplicitRun,
  settle: boolean,
  outcome?: ExplicitTargetCompletion,
): void {
  if (settle && r.isCurrent(run)) r.advance(run, { kind: 'settled' })
  r.finishLoop(run)
  run.abortController?.abort()
  r.release(run)
  if (outcome) {
    r.probe(conversationOf(run), 'explicit-target-complete', undefined, () =>
      run.executor.complete(run.request, outcome, run.applied),
    )
  }
}

export const explicitTargetStrategy: PlacementStrategy = {
  kind: 'explicit-target',
  events: {
    loopStart: 'explicit-target-loop-start',
    loopStaleFinish: 'explicit-target-loop-stale-finish',
    loopFinish: 'explicit-target-loop-finish',
    frameSchedule: 'explicit-target-frame-schedule',
    frameMonitor: 'explicit-target-frame-monitor',
  },
  frame: explicitTargetFrame,
  abandon: markTargetNotIndexed,
  cancel: (r, run) => r.teardown(run),
}

// ── Unread marker ─────────────────────────────────────────────────────────────────────────────

export function beginUnreadMarkerRun(
  r: Runner,
  conversationId: string,
  draft: PositionRequestDraft,
  executor: UnreadMarkerExecutor,
): UnreadMarkerRequest | null {
  const request = withIdentity(conversationId, mintPositionGeneration(), draft) as UnreadMarkerRequest
  const reachability = executor.reachability(request.desired)
  if (!reachabilityMatchesRequest(request, reachability)) return null
  if (!r.admit(request, resolveUnreadMarkerReachability(request, reachability))) return null
  const run = r.create(unreadMarkerStrategy, request, executor, UNREAD_MARKER_REASSERT_FRAMES)
  r.install(run)

  if (r.model.active?.phase.kind === 'unavailable') {
    promoteUnreadFallback(r, run, 'unread-marker-unavailable')
  } else {
    startUnreadMarkerLoop(r, run)
  }
  return request
}

function resolveUnreadMarkerReachability(
  request: UnreadMarkerRequest,
  facts: ReachabilityFacts,
): PositioningPhase {
  // Unread hydration intentionally waits for the ordinary resident window instead of issuing a
  // deep load-around. The bounded frame budget below eventually promotes an honest live-edge
  // fallback if cache hydration never makes the marker reachable.
  if (facts.kind === 'empty-window') return { kind: 'pending', reason: 'empty-window' }
  if (facts.kind === 'target-absent') return { kind: 'pending', reason: 'target-not-indexed' }
  // A reachable unread row still has to pass the executor's live geometry check. In particular,
  // `placement: use-unavailable-policy` is only a preflight hint that the row may sit in the top
  // third; row measurement can change that answer before the first frame. Let the owned
  // reconciler observe the frame and promote the fallback itself instead of bottom-pinning
  // synchronously during the entry layout effect.
  if (facts.kind === 'available') return { kind: 'reconciling' }
  return resolveReachability(request, facts)
}

function startUnreadMarkerLoop(r: Runner, run: UnreadRun): void {
  if (!r.isCurrent(run)) return
  const lease = r.beginOperation(run)
  run.lease = lease
  if (!r.adopt(run, lease)) return
  r.schedule(run, lease)
}

/** Re-run the unread marker's frame now, without scheduling the next one. */
export function reassertUnreadMarker(r: Runner, conversationId: string): void {
  const run = r.slot('unread-marker') as UnreadRun | null
  if (!run?.lease || run.request.conversationId !== conversationId) return
  unreadMarkerFrame(r, run, run.lease, false)
}

function unreadMarkerFrame(r: Runner, run: UnreadRun, lease: Lease, scheduleNextFrame = true): void {
  if (!lease.isCurrent()) return
  if (run.framesLeft-- <= 0) {
    if (run.resolvedAtLiveEdge) {
      promoteUnreadFallback(r, run, 'unread-marker-resolved-at-live-edge')
    } else if (run.resolved) {
      finishUnreadMarker(r, run, 'settled')
    } else {
      promoteUnreadFallback(r, run, 'unread-marker-unavailable')
    }
    return
  }

  if (isUnreadMarkerTakenOver(r, run)) {
    const { conversationId, generation } = run.request
    r.model = cancelReconciliationForUserInput(r.model, conversationId, generation)
    finishUnreadMarker(r, run, 'user-takeover')
    return
  }

  const result = r.position<UnreadMarkerFrameResult>(run, 'unread-marker-frame', lease, {
    kind: 'unavailable',
  })
  if (!lease.isCurrent()) return

  // A held frame waits like one whose divider is not ready. Near its end a fling moves less than
  // the settling drift on each frame, and counting those frames would settle the visit there
  // before its write lands.
  if (result.kind === 'waiting' || result.kind === 'held') {
    if (result.kind === 'held') waitForHeldWrite(run)
    r.record(run, false)
    if (scheduleNextFrame) r.schedule(run, lease)
    return
  }
  if (result.kind === 'unavailable') {
    promoteUnreadFallback(r, run, 'unread-marker-unavailable')
    return
  }

  run.resolved = true
  lease.markApplied()
  if (!lease.isCurrent()) return
  run.resolvedAtLiveEdge = result.atLiveEdge
  run.landedContentHeight = readUnreadMarkerGeometry(r, run)?.contentHeight ?? null

  const step = advanceDriftConvergence(
    run,
    result.scrollTop,
    UNREAD_MARKER_DRIFT_PX,
    UNREAD_MARKER_STABLE_FRAMES,
  )
  r.record(run, step.moved)
  if (step.settles) {
    if (run.resolvedAtLiveEdge) {
      promoteUnreadFallback(r, run, 'unread-marker-resolved-at-live-edge')
    } else {
      finishUnreadMarker(r, run, 'settled')
    }
    return
  }
  if (scheduleNextFrame) r.schedule(run, lease)
}

function readUnreadMarkerGeometry(r: Runner, run: UnreadRun): UnreadMarkerGeometry | null {
  return r.probe<UnreadMarkerGeometry | null>(conversationOf(run), 'unread-marker-read-geometry', null, () =>
    run.executor.readGeometry(),
  )
}

/**
 * Whether the reader moved the viewport away from the last landing. Wheel, touch and keys cancel
 * through the controller's input observer; this catches movement that delivers no input event,
 * such as a scrollbar drag. A jump that comes with a content-height change is not that: the first
 * measurement of rows positioned on estimates recalibrates every estimate, and the browser clamps
 * scrollTop into the shrunken content. The run re-asserts the marker over such a correction.
 * Nor is the leftover movement of a released fling while the reader's own divider visit is
 * pending: the viewport observer attributes it to that navigation, whose write the fling holds.
 */
function isUnreadMarkerTakenOver(r: Runner, run: UnreadRun): boolean {
  if (run.landedTarget === null || run.landedContentHeight === null) return false
  const geometry = readUnreadMarkerGeometry(r, run)
  if (!geometry) return false
  if (geometry.contentHeight !== run.landedContentHeight) return false
  if (geometry.pendingFling === true && r.hasPendingNavigation(run.request.conversationId)) return false
  return Math.abs(geometry.scrollTop - run.landedTarget) > UNREAD_MARKER_TAKEOVER_DRIFT_PX
}

function reportUnreadCompletion(r: Runner, run: UnreadRun, outcome: UnreadMarkerCompletion): void {
  const complete = run.executor.complete
  if (!complete) return
  r.probe(conversationOf(run), 'unread-marker-complete', undefined, () => complete(run.request, outcome))
}

function promoteUnreadFallback(
  r: Runner,
  run: UnreadRun,
  reason: 'unread-marker-unavailable' | 'unread-marker-resolved-at-live-edge',
): void {
  if (!r.isCurrent(run)) return
  r.finishLoop(run)
  run.abortController?.abort()
  reportUnreadCompletion(r, run, reason)

  // Return-to-latest's divider visit hands its navigation over: the live edge is still the place
  // the reader asked for.
  if (
    !acceptLiveEdge(
      r,
      run.request.conversationId,
      { kind: 'fallback', reason },
      run.executor.liveEdge,
      run.request.source.kind === 'user-navigation' ? 'navigation' : 'maintenance',
    )
  ) {
    r.cancel('unread-marker', undefined)
  }
}

function finishUnreadMarker(r: Runner, run: UnreadRun, outcome: 'settled' | 'user-takeover'): void {
  reportUnreadCompletion(r, run, outcome)
  if (outcome === 'settled' && r.isCurrent(run)) {
    const active = r.model.active
    if (active) {
      r.model = advancePhaseIfCurrent(
        r.model,
        active.request.conversationId,
        active.request.generation,
        { kind: 'settled' },
      )
    }
  }
  r.finishLoop(run)
  run.abortController?.abort()
  r.release(run)
}

export const unreadMarkerStrategy: PlacementStrategy = {
  kind: 'unread-marker',
  events: {
    loopStart: 'unread-marker-loop-start',
    loopStaleFinish: 'unread-marker-loop-stale-finish',
    loopFinish: 'unread-marker-loop-finish',
    frameSchedule: 'unread-marker-frame-schedule',
    frameMonitor: 'unread-marker-frame-monitor',
  },
  frame: (r, run, lease) => unreadMarkerFrame(r, run, lease),
  abandon: (r, run) => promoteUnreadFallback(r, run, 'unread-marker-unavailable'),
  cancel: (r, run) => r.teardown(run),
}

// ── Saved position ────────────────────────────────────────────────────────────────────────────

export function beginSavedPositionRun(
  r: Runner,
  conversationId: string,
  draft: PositionRequestDraft,
  executor: SavedPositionExecutor,
): SavedPositionRequest | null {
  const request = withIdentity(conversationId, mintPositionGeneration(), draft) as SavedPositionRequest
  const reachability = r.probe<ReachabilityFacts | null>(
    conversationId,
    'saved-position-entry-reachability',
    null,
    () => executor.reachability(request.desired, executor.loadAround ? 'available' : 'unavailable'),
  )
  if (!reachability) return null
  if (!reachabilityMatchesRequest(request, reachability)) return null
  if (!r.admit(request, resolveReachability(request, reachability))) return null
  const run = r.create(savedPositionStrategy, request, executor, SAVED_POSITION_REASSERT_FRAMES)
  r.install(run)
  driveSavedPosition(r, run)
  return request
}

export function driveSavedPosition(r: Runner, run: SavedRun): void {
  if (!r.isCurrent(run) || run.loop) return
  const loadAround = r.loadAroundStatus(run)
  const reachability = r.probe<ReachabilityFacts | null>(
    conversationOf(run),
    'saved-position-reachability',
    null,
    () => run.executor.reachability(run.request.desired, loadAround),
  )
  if (!reachability) {
    promoteSavedFallback(r, run, { kind: 'live-edge' })
    return
  }

  const phase = resolveReachability(run.request, reachability)
  r.advance(run, phase)
  if (!r.isCurrent(run)) return

  if (phase.kind === 'recentering-live-edge') {
    const startAtBestEdge = () => {
      if (r.isCurrent(run)) startSavedPositionLoop(r, run)
    }
    r.recenter(
      run,
      'saved-position-recenter-live-edge',
      run.executor.recenterLiveEdge,
      run.executor.recenterVersion,
      startAtBestEdge,
    )
  } else if (phase.kind === 'loading-around') {
    r.loadAround(run, 'saved-position-load-around', phase.messageId, () =>
      driveSavedPosition(r, run),
    )
  } else if (phase.kind === 'unavailable') {
    promoteSavedFallback(r, run, phase.policy)
  } else if (phase.kind === 'mounting' || phase.kind === 'reconciling') {
    run.loadingAround = false
    startSavedPositionLoop(r, run)
  }
}

function startSavedPositionLoop(r: Runner, run: SavedRun): void {
  if (!r.isCurrent(run) || run.loop) return
  run.framesLeft = SAVED_POSITION_REASSERT_FRAMES
  run.stableFrames = 0
  run.landedTarget = null
  const lease = r.beginOperation(run)

  // Preserve the pre-paint entry write: the first measured application happens synchronously
  // from the conversation-entry layout effect. Only the subsequent measurement settle is
  // scheduled through the shared frame-loop owner.
  const initial = r.position<SavedPositionFrameResult>(run, 'saved-position-frame', lease, {
    kind: 'unavailable',
  })
  if (!lease.isCurrent()) return
  if (initial.kind === 'unavailable') {
    if (run.request.source.kind === 'fallback' && run.request.desired.kind === 'live-edge') {
      r.cancel('saved-position', undefined)
      return
    }
    promoteSavedFallback(r, run, run.request.onUnavailable ?? { kind: 'live-edge' })
    return
  }

  lease.markApplied()
  if (!lease.isCurrent()) return
  completeSavedPosition(r, run, 'applied')
  if (!initial.reassert) {
    lease.settle()
    return
  }
  if (!r.adopt(run, lease)) return
  r.schedule(run, lease)
}

function savedPositionFrame(r: Runner, run: SavedRun, lease: Lease): void {
  if (!lease.isCurrent()) return
  if (run.framesLeft-- <= 0) {
    settleSavedPosition(r, run, lease, 'best-effort')
    return
  }
  const result = r.position<SavedPositionFrameResult>(run, 'saved-position-frame', lease, {
    kind: 'unavailable',
  })
  if (!lease.isCurrent()) return
  if (result.kind === 'unavailable') {
    // Once the initial anchor write landed, losing the row during re-windowing was historically a
    // best-effort stop, not a new fallback request. Preserve that release seam.
    settleSavedPosition(r, run, lease, 'best-effort')
    return
  }
  if (!result.reassert) {
    settleSavedPosition(r, run, lease, 'settled')
    return
  }
  const step = advanceDriftConvergence(
    run,
    result.scrollTop,
    SAVED_POSITION_DRIFT_PX,
    SAVED_POSITION_STABLE_FRAMES,
  )
  r.record(run, step.moved)
  if (step.settles) {
    settleSavedPosition(r, run, lease, 'settled')
    return
  }
  r.schedule(run, lease)
}

function completeSavedPosition(r: Runner, run: SavedRun, outcome: SavedPositionCompletion): void {
  r.probe(conversationOf(run), 'saved-position-complete', undefined, () =>
    run.executor.complete(run.request, outcome),
  )
}

function settleSavedPosition(
  r: Runner,
  run: SavedRun,
  lease: Lease,
  outcome: Extract<SavedPositionCompletion, 'settled' | 'best-effort'>,
): void {
  if (!lease.isCurrent()) return
  r.finishLoop(run)
  completeSavedPosition(r, run, outcome)
  lease.settle()
}

/**
 * The saved position cannot be honoured: place the reader at the policy's fallback instead. A
 * fallback that is itself the live edge hands over to a live-edge run; a legacy offset reuses
 * this run under a new request.
 */
function promoteSavedFallback(r: Runner, run: SavedRun, policy: UnavailablePolicy): void {
  if (!r.isCurrent(run)) return
  const desired =
    policy.kind === 'legacy-offset'
      ? { kind: 'legacy-offset' as const, offsetPx: policy.offsetPx }
      : { kind: 'live-edge' as const, follow: true as const }
  if (run.request.source.kind === 'fallback' && run.request.desired.kind === 'live-edge') {
    const request = run.request as LiveEdgeRequest
    const liveExecutor = run.executor.liveEdge
    r.cancel('saved-position', undefined)
    r.advance(run, { kind: 'reconciling' })
    startLiveEdgeRun(r, request, liveExecutor)
    return
  }

  const request: SavedPositionRequest = {
    generation: mintPositionGeneration(),
    conversationId: run.request.conversationId,
    source: { kind: 'fallback', reason: 'saved-position-unavailable' },
    desired,
  } as SavedPositionRequest
  const accepted = r.accept(request)
  if (accepted === r.model) {
    r.cancel('saved-position', undefined)
    return
  }
  if (request.desired.kind === 'live-edge') {
    const liveRequest = request as LiveEdgeRequest
    const liveExecutor = run.executor.liveEdge
    const reachability = r.probe<ReachabilityFacts | null>(
      liveRequest.conversationId,
      'saved-position-live-edge-fallback',
      null,
      () => liveExecutor.reachability(),
    )
    if (!reachability || !reachabilityMatchesRequest(liveRequest, reachability)) {
      r.cancel('saved-position', undefined)
      return
    }
    r.cancel('saved-position', undefined)
    r.model = advancePhaseIfCurrent(
      accepted,
      liveRequest.conversationId,
      liveRequest.generation,
      resolveReachability(liveRequest, reachability),
    )
    startLiveEdgeRun(r, liveRequest, liveExecutor)
    return
  }
  r.finishLoop(run)
  run.abortController?.abort()
  run.request = request
  run.operation += 1
  run.abortController = null
  run.loadingAround = false
  run.aroundAttempted = true
  run.lastRecenterVersion = null
  run.framesLeft = SAVED_POSITION_REASSERT_FRAMES
  run.stableFrames = 0
  run.landedTarget = null
  r.model = accepted
  driveSavedPosition(r, run)
}

export const savedPositionStrategy: PlacementStrategy = {
  kind: 'saved-position',
  events: {
    loopStart: 'saved-position-loop-start',
    loopStaleFinish: 'saved-position-loop-stale-finish',
    loopFinish: 'saved-position-loop-finish',
    frameSchedule: 'saved-position-frame-schedule',
    frameMonitor: 'saved-position-frame-monitor',
  },
  frame: savedPositionFrame,
  abandon: (r, run, lease) => settleSavedPosition(r, run, lease, 'best-effort'),
  cancel: (r, run) => r.teardown(run),
  // A saved-position run that has already settled treats a late "applied" as reached rather than
  // walking the phase backwards: the entry has finished, and the frame reporting it is just the
  // loop draining.
  alreadySatisfied: (model, phase) =>
    phase.kind === 'position-applied' && model.active?.phase.kind === 'settled',
}
