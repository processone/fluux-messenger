import {
  advancePhaseIfCurrent,
  isCurrentGeneration,
  type PositionRequest,
  type PositioningModel,
  type PositioningPhase,
  type ReachabilityFacts,
} from './scrollPositionModel'
import { recordShadowGeneration, runScrollShadowSafely } from './scrollPositionShadow'
import type {
  PositionExecutionLease,
  PositionFrameLoop,
  SavedPositionLoadAroundStatus,
} from './positionExecutors'

/**
 * The one runner every placement path goes through.
 *
 * A path is a {@link PlacementStrategy}: the few decisions that make it that path (what a frame
 * does, when it is done, what it reports). Everything the seven paths do the same way lives here:
 * the run's state, the lease that says whether it still owns the position, the frame loop it
 * drives, and the order a run is torn down in. Which strategy placed a reader is a field of the
 * run, never a method name.
 */

export type PlacementKind =
  | 'saved-position'
  | 'unread-marker'
  | 'explicit-target'
  | 'resident-top'
  | 'live-edge'
  | 'anchor-preservation'
  | 'directional-history'

/**
 * The order the runner visits slots in when it cancels. Part of the contract: an executor's
 * completion can re-enter the controller, so which slot is already empty at that moment is
 * observable.
 */
const CANCEL_ORDER: readonly PlacementKind[] = [
  'saved-position',
  'unread-marker',
  'explicit-target',
  'resident-top',
  'live-edge',
  'anchor-preservation',
  'directional-history',
]

/**
 * The diagnostic names a strategy's runs record under. They surface in the shadow snapshot a
 * developer greps for, so each is written out whole in the strategy that owns it.
 */
export interface PlacementEvents {
  loopStart: string
  loopStaleFinish: string
  loopFinish: string
  frameSchedule: string
  frameMonitor: string
}

export interface PlacementStrategy {
  kind: PlacementKind
  events: PlacementEvents
  /** Run one scheduled frame of a run this strategy placed. */
  frame: (runner: PositionRunner, run: AnyRun, lease: PositionExecutionLease) => void
  /** Give up on the run because no loop could be built or scheduled for it. */
  abandon: (runner: PositionRunner, run: AnyRun, lease: PositionExecutionLease) => void
  /** Tear the run down because something else owns the position now. */
  cancel: (runner: PositionRunner, run: AnyRun, outcome: unknown) => void
  /**
   * A phase this run's lease treats as already reached, so a late report of it does not walk the
   * model backwards.
   */
  alreadySatisfied?: (model: PositioningModel, phase: PositioningPhase) => boolean
}

/**
 * One run of one strategy. Every strategy's run uses the same flat shape; a field a strategy does
 * not use keeps the value it was created with.
 */
export interface PositionRun<Request = any, Executor = any> {
  readonly strategy: PlacementStrategy
  request: Request
  executor: Executor
  operation: number
  abortController: AbortController | null
  loop: PositionFrameLoop | null
  framesLeft: number
  stableFrames: number
  landedTarget: number | null
  /** Held frames that may still give their frame back to {@link framesLeft}. */
  heldFramesLeft: number
  /** Whether the run's first write has landed, for the paths whose completion reports it. */
  applied: boolean
  /** Whether the run has told its executor how it ended, for the paths that tell it once. */
  completed: boolean
  /**
   * `navigation` from the reader's own move until it first settles; `maintenance` for the
   * ambient corrections. The request source cannot tell them apart.
   */
  purpose: 'navigation' | 'maintenance'
  aroundAttempted: boolean
  loadingAround: boolean
  lastRecenterVersion: string | null
  lease: PositionExecutionLease | null
  /** Content height read just after the last positioned frame; null before the first. */
  landedContentHeight: number | null
  resolved: boolean
  resolvedAtLiveEdge: boolean
}

export type AnyRun = PositionRun<any, any>

/** What the runner needs from the controller that owns the model. */
export interface PositionHost {
  getModel: () => PositioningModel
  setModel: (model: PositioningModel) => void
  accept: (request: PositionRequest) => PositioningModel
  hasPendingNavigation: (conversationId: string) => boolean
}

export type PositionRequestDraft = PositionRequest extends infer Request
  ? Request extends PositionRequest
    ? Omit<Request, 'generation' | 'conversationId'>
    : never
  : never

let nextPositionGeneration = 1

export function mintPositionGeneration(): number {
  const generation = nextPositionGeneration
  if (!Number.isSafeInteger(generation)) {
    throw new RangeError('scroll position generation exhausted')
  }
  nextPositionGeneration += 1
  recordShadowGeneration(generation)
  return generation
}

export function withIdentity(
  conversationId: string,
  generation: number,
  draft: PositionRequestDraft,
): PositionRequest {
  return { ...draft, conversationId, generation } as PositionRequest
}

export function reachabilityMatchesRequest(
  request: PositionRequest,
  facts: ReachabilityFacts,
): boolean {
  if (facts.kind === 'empty-window') return true
  switch (request.desired.kind) {
    case 'live-edge':
      return facts.kind === 'global-live-edge'
    case 'anchor':
    case 'message':
      return facts.kind === 'target-absent' || facts.kind === 'available'
    case 'resident-top':
      return facts.kind === 'available'
    case 'legacy-offset':
      return facts.kind === 'available'
  }
}

/**
 * Whether a frame landed close enough to the previous one to count as still. A run's first frame
 * has no previous landing and is never still, which is what the null check says: without it, a
 * fresh run would count its opening write as one stable frame it never measured.
 */
function heldWithinDrift(
  landedTarget: number | null,
  scrollTop: number,
  driftPx: number,
): boolean {
  return landedTarget !== null && Math.abs(scrollTop - landedTarget) <= driftPx
}

export interface DriftConvergenceStep {
  /**
   * Whether the position moved beyond tolerance since the previous frame. NOT the same question
   * as "did the adapter write to scrollTop": an adapter can write the value already there, and
   * layout can move the position with no write at all. Both are legitimate things to report to
   * the loop monitor, so the step answers its own and lets each strategy choose.
   */
  moved: boolean
  /** Whether this frame is the one that reaches the settling threshold. */
  settles: boolean
}

/**
 * One frame of drift-based convergence, for the paths that settle when the position stops
 * moving. Advances the stability count, remembers where this frame landed, and reports whether
 * the run has now held still long enough. Which terminal state that leads to is the strategy's.
 */
export function advanceDriftConvergence(
  run: Pick<AnyRun, 'landedTarget' | 'stableFrames'>,
  scrollTop: number,
  driftPx: number,
  stableFramesToSettle: number,
): DriftConvergenceStep {
  const moved = !heldWithinDrift(run.landedTarget, scrollTop, driftPx)
  run.stableFrames = moved ? 0 : run.stableFrames + 1
  run.landedTarget = scrollTop
  return { moved, settles: run.stableFrames >= stableFramesToSettle }
}

/**
 * How long a navigation run (live edge, message jump, unread divider) waits for a released fling
 * to let its held write land without spending its reassert frames: about ten seconds at 60 Hz,
 * well past a fling's momentum. Past it, held frames spend the reassert budget again, so the run
 * still ends.
 */
export const HELD_WRITE_FRAMES = 600

/**
 * One frame whose write a released iOS fling holds. The list is where the fling carries it, not
 * where the frame wrote, so the frame lands nothing. The fling, not the run, decides when the
 * write lands: the frame gives itself back to the reassert budget while {@link HELD_WRITE_FRAMES}
 * lasts, so a fling that outlasts the run's own frames does not end the navigation before it
 * lands.
 */
export function waitForHeldWrite(run: Pick<AnyRun, 'framesLeft' | 'heldFramesLeft'>): void {
  if (run.heldFramesLeft-- > 0) run.framesLeft++
}

export class PositionRunner {
  private readonly slots = new Map<PlacementKind, AnyRun>()

  constructor(private readonly host: PositionHost) {}

  get model(): PositioningModel {
    return this.host.getModel()
  }

  set model(model: PositioningModel) {
    this.host.setModel(model)
  }

  hasPendingNavigation(conversationId: string): boolean {
    return this.host.hasPendingNavigation(conversationId)
  }

  slot(kind: PlacementKind): AnyRun | null {
    return this.slots.get(kind) ?? null
  }

  /** The run a strategy holds, when it belongs to `conversationId` and still owns the position. */
  currentRun(kind: PlacementKind, conversationId: string): AnyRun | null {
    const run = this.slot(kind)
    return run && run.request.conversationId === conversationId && this.isCurrent(run) ? run : null
  }

  create<Request, Executor>(
    strategy: PlacementStrategy,
    request: Request,
    executor: Executor,
    reassertFrames: number,
    init: Partial<AnyRun> = {},
  ): PositionRun<Request, Executor> {
    return {
      strategy,
      request,
      executor,
      operation: 0,
      abortController: null,
      loop: null,
      framesLeft: reassertFrames,
      stableFrames: 0,
      landedTarget: null,
      heldFramesLeft: HELD_WRITE_FRAMES,
      applied: false,
      completed: false,
      purpose: 'maintenance',
      aroundAttempted: false,
      loadingAround: false,
      lastRecenterVersion: null,
      lease: null,
      landedContentHeight: null,
      resolved: false,
      resolvedAtLiveEdge: false,
      ...init,
    }
  }

  install(run: AnyRun): void {
    this.slots.set(run.strategy.kind, run)
  }

  /** Empty the run's slot when it still holds this run. */
  release(run: AnyRun): void {
    if (this.slots.get(run.strategy.kind) === run) this.slots.delete(run.strategy.kind)
  }

  /**
   * Whether a run still owns the position: it is the one its slot holds, and the model still
   * points at its request. Written once for all seven paths.
   */
  isCurrent(run: AnyRun): boolean {
    return (
      this.slots.get(run.strategy.kind) === run &&
      isCurrentGeneration(this.model, run.request.conversationId, run.request.generation)
    )
  }

  /** Move the run's request to `phase` while it is still the model's current generation. */
  advance(run: AnyRun, phase: PositioningPhase): void {
    this.model = advancePhaseIfCurrent(
      this.model,
      run.request.conversationId,
      run.request.generation,
      phase,
    )
  }

  /**
   * Put a request through arbitration: accepted means every other path is superseded and the
   * request starts in `phase`. Null when the model keeps its current request.
   */
  admit(request: PositionRequest, phase: PositioningPhase): PositioningModel | null {
    const accepted = this.host.accept(request)
    if (accepted === this.model) return null
    this.cancelAll('superseded')
    this.model = advancePhaseIfCurrent(
      accepted,
      request.conversationId,
      request.generation,
      phase,
    )
    return accepted
  }

  /** What a run's reachability probe is told about loading around its target. */
  loadAroundStatus(run: AnyRun): SavedPositionLoadAroundStatus {
    return run.loadingAround
      ? 'loading'
      : run.aroundAttempted
        ? 'exhausted'
        : run.executor.loadAround
          ? 'available'
          : 'unavailable'
  }

  /**
   * Mint the lease that authorises one operation of a run, superseding whatever it was doing.
   *
   * A lease answers one question — does this run still own the position — and ownership can be
   * lost three ways, minted at three different moments: the abort signal fires, the run's slot
   * stops pointing at it, or a newer operation supersedes this one. A newer generation of the
   * conversation is the fourth, and lives in the model rather than on the run.
   */
  beginOperation(run: AnyRun): PositionExecutionLease {
    run.abortController?.abort()
    const abortController = new AbortController()
    run.abortController = abortController
    const operation = ++run.operation
    const { conversationId, generation } = run.request
    const isCurrent = () =>
      !abortController.signal.aborted &&
      this.slots.get(run.strategy.kind) === run &&
      run.operation === operation &&
      isCurrentGeneration(this.model, conversationId, generation)
    const advance = (phase: PositioningPhase) => {
      if (!isCurrent()) return false
      if (run.strategy.alreadySatisfied?.(this.model, phase)) return true
      this.model = advancePhaseIfCurrent(this.model, conversationId, generation, phase)
      return isCurrent()
    }
    return {
      conversationId,
      generation,
      operation,
      owner: {
        conversationId,
        generation,
        isCurrent: () => isCurrentGeneration(this.model, conversationId, generation),
      },
      frameBudget: run.framesLeft,
      signal: abortController.signal,
      isCurrent,
      markApplied: () => advance({ kind: 'position-applied' }),
      settle: () => advance({ kind: 'settled' }),
    }
  }

  /** A probe of the executor, inside the scroll shadow: a throwing adapter reads as `fallback`. */
  probe<T>(conversationId: string, event: string, fallback: T, observe: () => T): T {
    return runScrollShadowSafely<T>({ event, conversationId, fallback, observe })
  }

  /**
   * Ask the executor to position one frame, inside the scroll shadow. An adapter that throws
   * degrades this frame to `fallback` — always the result union's `unavailable` arm — instead of
   * tearing the run down through a React effect or a rAF callback where nothing would catch it.
   */
  position<Result>(
    run: AnyRun,
    event: string,
    lease: PositionExecutionLease,
    fallback: Result,
  ): Result {
    return this.probe<Result>(run.request.conversationId, event, fallback, () =>
      run.executor.positionFrame(run.request, lease),
    )
  }

  /**
   * Adopt the frame loop a run just asked its executor to build.
   *
   * The order here is the point, and it is the same for all seven paths: the loop is stored
   * before the first frame is scheduled, so a frame that runs immediately finds it; and a lease
   * that went stale while the loop was being built still ends that loop, because nobody else
   * holds it. What a path does when its executor cannot build one is its own `abandon`. Returns
   * whether the run may now drive frames.
   */
  adopt(run: AnyRun, lease: PositionExecutionLease): boolean {
    const { events } = run.strategy
    const loop = this.probe<PositionFrameLoop | null>(run.request.conversationId, events.loopStart, null, () =>
      run.executor.beginLoop(lease),
    )
    if (!lease.isCurrent()) {
      if (loop) {
        // `beginLoop` can outlive the ownership that authorised it, and the orphaned loop is
        // nobody else's to end. Ending it is an adapter call like any other.
        this.probe(run.request.conversationId, events.loopStaleFinish, undefined, () => loop.finish())
      }
      return false
    }
    if (!loop) {
      run.strategy.abandon(this, run, lease)
      return false
    }
    run.loop = loop
    return true
  }

  /**
   * Ask the loop for the next frame, inside the scroll shadow. A loop that cannot schedule is not
   * recoverable: nothing will drive the run again, so it must end now rather than hang holding
   * the position. What "end now" means is the strategy's `abandon`.
   */
  schedule(run: AnyRun, lease: PositionExecutionLease): void {
    if (!lease.isCurrent() || !run.loop) return
    const scheduled = this.probe(run.request.conversationId, run.strategy.events.frameSchedule, false, () => {
      run.loop?.schedule(() => run.strategy.frame(this, run, lease))
      return true
    })
    if (!scheduled && lease.isCurrent()) run.strategy.abandon(this, run, lease)
  }

  /** Report one frame to the loop monitor from inside the scroll shadow. */
  record(run: AnyRun, wrote: boolean): void {
    this.probe(run.request.conversationId, run.strategy.events.frameMonitor, undefined, () => run.loop?.recordFrame(wrote))
  }

  finishLoop(run: AnyRun): void {
    const loop = run.loop
    run.loop = null
    if (!loop) return
    this.probe(run.request.conversationId, run.strategy.events.loopFinish, undefined, () => loop.finish())
  }

  /**
   * Tear a run down in the order every executor depends on: stop its frame loop, abort the work
   * its lease authorised, report the outcome to the executor that asked for it when there is one
   * to report, then empty the slot (always, or only while it still holds this run). Aborting before the loop is finished would leave a scheduled
   * frame to run against a dead run, and reporting before the abort would hand the executor a
   * completion whose signal is still live.
   */
  teardown(run: AnyRun, report?: () => void, onlyIfHeld = false): void {
    this.finishLoop(run)
    run.abortController?.abort()
    report?.()
    if (onlyIfHeld) this.release(run)
    else this.slots.delete(run.strategy.kind)
  }

  accept(request: PositionRequest): PositioningModel {
    return this.host.accept(request)
  }

  /**
   * Ask the executor to load history around a target, once per run. When it finishes, or has
   * nothing to load, `redrive` runs the path's reachability step again.
   */
  loadAround(run: AnyRun, event: string, messageId: string, redrive: () => void): void {
    if (run.loadingAround || run.aroundAttempted) return
    run.aroundAttempted = true
    run.loadingAround = true
    const lease = this.beginOperation(run)
    const load = run.executor.loadAround
      ? this.probe<Promise<unknown> | unknown | null>(run.request.conversationId, event, null, () =>
          run.executor.loadAround?.(messageId, lease.signal) ?? null,
        )
      : null
    if (load === null) {
      if (lease.isCurrent()) {
        run.loadingAround = false
        redrive()
      }
      return
    }
    void Promise.resolve(load)
      .catch(() => undefined)
      .finally(() => {
        if (!lease.isCurrent()) return
        run.loadingAround = false
        redrive()
      })
  }

  /**
   * Recenter the sliding window on the live edge, once per window version. A run whose executor
   * cannot recenter, or reports it cannot, falls back to `place` on the best resident edge.
   */
  recenter(
    run: AnyRun,
    event: string,
    recenter: ((signal: AbortSignal) => 'started' | 'unavailable' | unknown) | undefined,
    version: string | undefined,
    place: () => void,
  ): void {
    if (!recenter || !version) {
      place()
      return
    }
    if (run.lastRecenterVersion === version) return
    run.lastRecenterVersion = version
    const lease = this.beginOperation(run)
    const result = this.probe<unknown>(run.request.conversationId, event, 'unavailable', () => recenter(lease.signal))
    if (!lease.isCurrent()) return
    if (result === 'unavailable') place()
  }

  /** Cancel every run whose request the model no longer holds. */
  cancelSuperseded(): void {
    for (const kind of CANCEL_ORDER) {
      const run = this.slot(kind)
      if (run && !this.isCurrent(run)) run.strategy.cancel(this, run, 'superseded')
    }
  }

  cancelAll(outcome: 'superseded'): void {
    for (const kind of CANCEL_ORDER) {
      const run = this.slot(kind)
      if (run) run.strategy.cancel(this, run, outcome)
    }
  }

  /** Cancel one strategy's run, if it holds one. */
  cancel(kind: PlacementKind, outcome: unknown): void {
    const run = this.slot(kind)
    if (run) run.strategy.cancel(this, run, outcome)
  }
}
