import {
  acceptPositionRequest,
  advancePhaseIfCurrent,
  cancelReconciliationForUserInput,
  deactivateConversation,
  initialPositioningModel,
  isCurrentGeneration,
  resolveReachability,
  selectEntryPosition,
  selectLiveEdgeNavigation,
  settleUserPosition,
  shouldReconcileAfterAppend,
  type EntryPositionFacts,
  type LiveEdgeNavigationFacts,
  type PositionRequest,
  type PositioningModel,
  type PositioningPhase,
  type ReachabilityFacts,
  type SavedPositionRequest,
  type UnreadMarkerFallbackRequest,
  type UnreadMarkerRequest,
  type UnavailablePolicy,
} from './scrollPositionModel'
import {
  compareShadowDecision,
  phaseCategory,
  recordShadowGeneration,
  runScrollShadowSafely,
  type ShadowActualDecision,
} from './scrollPositionShadow'

type PositionRequestDraft = PositionRequest extends infer Request
  ? Request extends PositionRequest
    ? Omit<Request, 'generation' | 'conversationId'>
    : never
  : never

export type SavedPositionLoadAroundStatus =
  | 'available'
  | 'loading'
  | 'exhausted'
  | 'unavailable'

export interface PositionExecutionLease {
  conversationId: string
  generation: number
  operation: number
  signal: AbortSignal
  isCurrent: () => boolean
  markApplied: () => boolean
  settle: () => boolean
}

export type SavedPositionExecutionLease = PositionExecutionLease

export interface SavedPositionExecutor {
  reachability: (
    desired: SavedPositionRequest['desired'],
    loadAround: SavedPositionLoadAroundStatus,
  ) => ReachabilityFacts
  loadAround?: (
    messageId: string,
    signal: AbortSignal,
  ) => Promise<unknown> | unknown
  /** Changes whenever another forward-window request may be issued safely. */
  recenterVersion?: string
  recenterLiveEdge?: (
    signal: AbortSignal,
  ) => 'requested' | 'waiting' | 'unavailable'
  reconcile: (
    request: SavedPositionRequest,
    lease: SavedPositionExecutionLease,
  ) => boolean
}

export interface UnreadMarkerFrameLoop {
  schedule: (callback: () => void) => void
  recordFrame: (wrote: boolean) => void
  finish: () => void
}

export type UnreadMarkerFrameResult =
  | { kind: 'waiting' }
  | { kind: 'unavailable' }
  | {
      kind: 'positioned'
      scrollTop: number
      atLiveEdge: boolean
    }

export interface UnreadMarkerExecutor {
  reachability: (desired: UnreadMarkerRequest['desired']) => ReachabilityFacts
  beginLoop: (lease: PositionExecutionLease) => UnreadMarkerFrameLoop | null
  readScrollTop: () => number | null
  positionFrame: (
    request: UnreadMarkerRequest,
    lease: PositionExecutionLease,
  ) => UnreadMarkerFrameResult
  applyLiveEdge: (
    reason:
      | 'unread-marker-unavailable'
      | 'unread-marker-resolved-at-live-edge',
    lease: PositionExecutionLease,
  ) => boolean
}

interface SavedPositionExecutionState {
  request: SavedPositionRequest
  executor: SavedPositionExecutor
  operation: number
  abortController: AbortController | null
  aroundAttempted: boolean
  loadingAround: boolean
  lastRecenterVersion: string | null
}

interface UnreadMarkerExecutionState {
  request: UnreadMarkerRequest | UnreadMarkerFallbackRequest
  executor: UnreadMarkerExecutor
  operation: number
  abortController: AbortController | null
  loop: UnreadMarkerFrameLoop | null
  framesLeft: number
  stableFrames: number
  landedTarget: number | null
  resolved: boolean
  resolvedAtLiveEdge: boolean
}

const UNREAD_MARKER_REASSERT_FRAMES = 120
const UNREAD_MARKER_STABLE_FRAMES = 8
const UNREAD_MARKER_DRIFT_PX = 16
const UNREAD_MARKER_TAKEOVER_DRIFT_PX = 300

let nextPositionGeneration = 1

function mintPositionGeneration(): number {
  const generation = nextPositionGeneration
  if (!Number.isSafeInteger(generation)) {
    throw new RangeError('scroll position generation exhausted')
  }
  nextPositionGeneration += 1
  recordShadowGeneration(generation)
  return generation
}

function withIdentity(
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

export class PositioningController {
  private model: PositioningModel = initialPositioningModel()
  private savedExecution: SavedPositionExecutionState | null = null
  private unreadExecution: UnreadMarkerExecutionState | null = null

  snapshot(): PositioningModel {
    return this.model
  }

  beginSavedPositionEntry(input: {
    conversationId: string
    entryFacts: EntryPositionFacts
    executor: SavedPositionExecutor
  }): SavedPositionRequest | null {
    const selection = selectEntryPosition(input.entryFacts)
    if (
      selection.source.kind !== 'entry' ||
      selection.source.reason !== 'saved-position'
    ) {
      return null
    }

    const generation = mintPositionGeneration()
    const request = withIdentity(
      input.conversationId,
      generation,
      selection as PositionRequestDraft,
    ) as SavedPositionRequest
    const initialReachability = runScrollShadowSafely<ReachabilityFacts | null>({
      event: 'saved-position-entry-reachability',
      conversationId: input.conversationId,
      fallback: null,
      observe: () => input.executor.reachability(
        request.desired,
        input.executor.loadAround ? 'available' : 'unavailable',
      ),
    })
    if (!initialReachability) return null
    if (!reachabilityMatchesRequest(request, initialReachability)) return null

    const accepted = acceptPositionRequest(this.model, request)
    if (accepted === this.model) return null
    this.cancelSavedExecution()
    this.cancelUnreadExecution()
    this.model = advancePhaseIfCurrent(
      accepted,
      input.conversationId,
      generation,
      resolveReachability(request, initialReachability),
    )
    this.savedExecution = {
      request,
      executor: input.executor,
      operation: 0,
      abortController: null,
      aroundAttempted: false,
      loadingAround: false,
      lastRecenterVersion: null,
    }
    this.driveSavedPosition()
    return request
  }

  refreshSavedPosition(input: {
    conversationId: string
    generation: number
    executor: SavedPositionExecutor
  }): boolean {
    const execution = this.savedExecution
    if (
      !execution ||
      execution.request.conversationId !== input.conversationId ||
      execution.request.generation !== input.generation ||
      !isCurrentGeneration(this.model, input.conversationId, input.generation)
    ) {
      return false
    }
    execution.executor = input.executor
    this.driveSavedPosition()
    return true
  }

  savedPositionStatus(conversationId: string): {
    request: SavedPositionRequest
    phase: PositioningPhase
  } | null {
    const execution = this.savedExecution
    const active = this.model.active
    if (
      !execution ||
      !active ||
      active.request !== execution.request ||
      active.request.conversationId !== conversationId
    ) {
      return null
    }
    return {
      request: execution.request,
      phase: active.phase,
    }
  }

  isSavedPositionPending(conversationId: string): boolean {
    const status = this.savedPositionStatus(conversationId)
    return status !== null &&
      status.phase.kind !== 'position-applied' &&
      status.phase.kind !== 'settled'
  }

  beginUnreadMarkerEntry(input: {
    conversationId: string
    entryFacts: EntryPositionFacts
    executor: UnreadMarkerExecutor
  }): UnreadMarkerRequest | null {
    return runScrollShadowSafely({
      event: 'unread-marker-entry',
      conversationId: input.conversationId,
      fallback: null,
      observe: () => {
        const selection = selectEntryPosition(input.entryFacts)
        if (
          selection.source.kind !== 'entry' ||
          selection.source.reason !== 'unread-marker'
        ) {
          return null
        }
        return this.beginUnreadMarkerRequest(
          input.conversationId,
          selection as PositionRequestDraft,
          input.executor,
        )
      },
    })
  }

  beginUnreadMarkerNavigation(input: {
    conversationId: string
    navigationFacts: LiveEdgeNavigationFacts
    executor: UnreadMarkerExecutor
  }): UnreadMarkerRequest | null {
    return runScrollShadowSafely({
      event: 'unread-marker-navigation',
      conversationId: input.conversationId,
      fallback: null,
      observe: () => {
        const selection = selectLiveEdgeNavigation(input.navigationFacts)
        if (
          selection.source.kind !== 'user-navigation' ||
          selection.source.reason !== 'unread-marker'
        ) {
          return null
        }
        return this.beginUnreadMarkerRequest(
          input.conversationId,
          selection as PositionRequestDraft,
          input.executor,
        )
      },
    })
  }

  observeEntry(input: {
    event: string
    conversationId: string
    entryFacts: EntryPositionFacts
    reachability: (desired: PositionRequest['desired']) => ReachabilityFacts
    actual: ShadowActualDecision
  }): PositionRequest | null {
    return runScrollShadowSafely({
      event: input.event,
      conversationId: input.conversationId,
      fallback: null,
      observe: () => {
        const selection = selectEntryPosition(input.entryFacts)
        const draft = selection as PositionRequestDraft
        return this.observeRequest({
          event: input.event,
          conversationId: input.conversationId,
          actual: input.actual,
          draft,
          reachability: input.reachability(draft.desired),
        })
      },
    })
  }

  observeRequest(input: {
    event: string
    conversationId: string
    draft: PositionRequestDraft
    reachability: ReachabilityFacts
    actual: ShadowActualDecision
  }): PositionRequest | null {
    return runScrollShadowSafely({
      event: input.event,
      conversationId: input.conversationId,
      fallback: null,
      observe: () => {
        const generation = mintPositionGeneration()
        const request = withIdentity(input.conversationId, generation, input.draft)
        if (!reachabilityMatchesRequest(request, input.reachability)) {
          compareShadowDecision({
            event: `${input.event}:fact-mismatch`,
            conversationId: input.conversationId,
            generation,
            expected: { desired: null, phase: 'idle' },
            actual: input.actual,
          })
          return null
        }

        const previous = this.model
        const accepted = acceptPositionRequest(previous, request)
        if (accepted === previous) {
          compareShadowDecision({
            event: input.event,
            conversationId: input.conversationId,
            generation,
            expected: { desired: null, phase: 'idle' },
            actual: input.actual,
          })
          return null
        }

        const phase = resolveReachability(request, input.reachability)
        this.model = advancePhaseIfCurrent(
          accepted,
          input.conversationId,
          generation,
          phase,
        )
        this.cancelExecutionsIfSuperseded()
        compareShadowDecision({
          event: input.event,
          conversationId: input.conversationId,
          generation,
          expected: {
            desired: request.desired,
            phase: phaseCategory(phase),
          },
          actual: input.actual,
        })
        return request
      },
    })
  }

  observeLiveEdgeNavigation(input: {
    event: string
    conversationId: string
    navigationFacts: LiveEdgeNavigationFacts
    reachability: (desired: PositionRequest['desired']) => ReachabilityFacts
    actual: ShadowActualDecision
  }): PositionRequest | null {
    return runScrollShadowSafely({
      event: input.event,
      conversationId: input.conversationId,
      fallback: null,
      observe: () => {
        const draft = selectLiveEdgeNavigation(
          input.navigationFacts,
        ) as PositionRequestDraft
        return this.observeRequest({
          event: input.event,
          conversationId: input.conversationId,
          draft,
          reachability: input.reachability(draft.desired),
          actual: input.actual,
        })
      },
    })
  }

  observeAppend(input: {
    event: string
    conversationId: string
    actualFollowsLive: boolean
  }): boolean {
    return runScrollShadowSafely({
      event: input.event,
      conversationId: input.conversationId,
      fallback: false,
      observe: () => {
        const expectedFollowsLive = shouldReconcileAfterAppend(
          this.model,
          input.conversationId,
        )
        compareShadowDecision({
          event: input.event,
          conversationId: input.conversationId,
          generation: this.model.active?.request.generation ?? null,
          expected: {
            desired: expectedFollowsLive
              ? this.model.active?.request.desired ?? null
              : null,
            phase: expectedFollowsLive ? 'positioning' : 'idle',
          },
          actual: {
            desired: input.actualFollowsLive
              ? { kind: 'live-edge', follow: true }
              : null,
            phase: input.actualFollowsLive ? 'positioning' : 'idle',
          },
        })
        return expectedFollowsLive
      },
    })
  }

  /**
   * Mirror the legacy shared reassert gate without importing its at-bottom latch. A reassert is
   * justified either by semantic follow-live ownership or by geometry that is currently at the
   * live edge. The second clause preserves today's settle/repaint behavior while making a stale
   * latch falsifiable in shadow mode.
   */
  observeBottomReassert(input: {
    event: string
    conversationId: string
    geometryAtLiveEdge: boolean
    actualFollowsLive: boolean
  }): boolean {
    return runScrollShadowSafely({
      event: input.event,
      conversationId: input.conversationId,
      fallback: false,
      observe: () => {
        const expectedFollowsLive =
          shouldReconcileAfterAppend(this.model, input.conversationId) ||
          input.geometryAtLiveEdge
        compareShadowDecision({
          event: input.event,
          conversationId: input.conversationId,
          generation: this.model.active?.request.generation ?? null,
          expected: {
            desired: expectedFollowsLive
              ? { kind: 'live-edge', follow: true }
              : null,
            phase: expectedFollowsLive ? 'positioning' : 'idle',
          },
          actual: {
            desired: input.actualFollowsLive
              ? { kind: 'live-edge', follow: true }
              : null,
            phase: input.actualFollowsLive ? 'positioning' : 'idle',
          },
        })
        return expectedFollowsLive
      },
    })
  }

  markPositionApplied(conversationId: string, generation: number): void {
    runScrollShadowSafely({
      event: 'position-applied',
      conversationId,
      fallback: undefined,
      observe: () => {
        this.model = advancePhaseIfCurrent(
          this.model,
          conversationId,
          generation,
          { kind: 'position-applied' },
        )
      },
    })
  }

  observeUserInput(conversationId: string): void {
    runScrollShadowSafely({
      event: 'user-input',
      conversationId,
      fallback: undefined,
      observe: () => {
        const generation = this.model.active?.request.generation
        if (generation === undefined) return
        this.model = cancelReconciliationForUserInput(
          this.model,
          conversationId,
          generation,
        )
        this.cancelExecutionsIfSuperseded()
      },
    })
  }

  observeSettledUserGeometry(input: {
    conversationId: string
    atLiveEdge: boolean
  }): void {
    runScrollShadowSafely({
      event: 'settled-user-geometry',
      conversationId: input.conversationId,
      fallback: undefined,
      observe: () => {
        const rearmRequest: Extract<
          PositionRequest,
          { source: { kind: 'user-navigation'; reason: 'live-edge' } }
        > | undefined =
          input.atLiveEdge && this.model.active === null
            ? {
                generation: mintPositionGeneration(),
                conversationId: input.conversationId,
                source: { kind: 'user-navigation', reason: 'live-edge' },
                desired: { kind: 'live-edge', follow: true },
              }
            : undefined
        this.model = settleUserPosition(
          this.model,
          input.conversationId,
          input.atLiveEdge,
          rearmRequest,
        )
        this.cancelExecutionsIfSuperseded()
      },
    })
  }

  deactivate(conversationId: string, generation: number): void {
    runScrollShadowSafely({
      event: 'deactivate',
      conversationId,
      fallback: undefined,
      observe: () => {
        this.model = deactivateConversation(
          this.model,
          conversationId,
          generation,
        )
        this.cancelExecutionsIfSuperseded()
      },
    })
  }

  private beginUnreadMarkerRequest(
    conversationId: string,
    draft: PositionRequestDraft,
    executor: UnreadMarkerExecutor,
  ): UnreadMarkerRequest | null {
    const generation = mintPositionGeneration()
    const request = withIdentity(
      conversationId,
      generation,
      draft,
    ) as UnreadMarkerRequest
    const reachability = executor.reachability(request.desired)
    if (!reachabilityMatchesRequest(request, reachability)) return null

    const accepted = acceptPositionRequest(this.model, request)
    if (accepted === this.model) return null
    this.cancelSavedExecution()
    this.cancelUnreadExecution()
    this.model = advancePhaseIfCurrent(
      accepted,
      conversationId,
      generation,
      this.resolveUnreadMarkerReachability(request, reachability),
    )
    const execution: UnreadMarkerExecutionState = {
      request,
      executor,
      operation: 0,
      abortController: null,
      loop: null,
      framesLeft: UNREAD_MARKER_REASSERT_FRAMES,
      stableFrames: 0,
      landedTarget: null,
      resolved: false,
      resolvedAtLiveEdge: false,
    }
    this.unreadExecution = execution

    if (this.model.active?.phase.kind === 'unavailable') {
      this.promoteUnreadFallback(execution, 'unread-marker-unavailable')
    } else {
      this.startUnreadMarkerLoop(execution)
    }
    return request
  }

  private resolveUnreadMarkerReachability(
    request: UnreadMarkerRequest,
    facts: ReachabilityFacts,
  ): PositioningPhase {
    // Unread hydration intentionally waits for the ordinary resident window instead of issuing a
    // deep load-around. The bounded frame budget below eventually promotes an honest live-edge
    // fallback if cache hydration never makes the marker reachable.
    if (facts.kind === 'empty-window') {
      return { kind: 'pending', reason: 'empty-window' }
    }
    if (facts.kind === 'target-absent') {
      return { kind: 'pending', reason: 'target-not-indexed' }
    }
    // A reachable unread row still has to pass the executor's live geometry check. In
    // particular, `placement: use-unavailable-policy` is only a preflight hint that the row may
    // sit in the top third; row measurement can change that answer before the first frame. Let the
    // owned reconciler observe the frame and promote the fallback itself instead of bottom-pinning
    // synchronously during the entry layout effect.
    if (facts.kind === 'available') return { kind: 'reconciling' }
    return resolveReachability(request, facts)
  }

  private startUnreadMarkerLoop(
    execution: UnreadMarkerExecutionState,
  ): void {
    if (!this.isUnreadExecutionCurrent(execution)) return
    const lease = this.beginUnreadOperation(execution)
    const loop = runScrollShadowSafely<UnreadMarkerFrameLoop | null>({
      event: 'unread-marker-loop-start',
      conversationId: execution.request.conversationId,
      fallback: null,
      observe: () => execution.executor.beginLoop(lease),
    })
    if (!lease.isCurrent()) {
      if (loop) {
        runScrollShadowSafely({
          event: 'unread-marker-loop-stale-finish',
          conversationId: execution.request.conversationId,
          fallback: undefined,
          observe: () => loop.finish(),
        })
      }
      return
    }
    if (!loop) {
      this.promoteUnreadFallback(execution, 'unread-marker-unavailable')
      return
    }
    execution.loop = loop
    this.scheduleUnreadMarkerFrame(execution, lease)
  }

  private driveUnreadMarkerFrame(
    execution: UnreadMarkerExecutionState,
    lease: PositionExecutionLease,
  ): void {
    if (!lease.isCurrent()) return
    if (
      execution.request.source.kind === 'fallback' ||
      execution.framesLeft-- <= 0
    ) {
      if (execution.resolvedAtLiveEdge) {
        this.promoteUnreadFallback(
          execution,
          'unread-marker-resolved-at-live-edge',
        )
      } else if (execution.resolved) {
        this.finishUnreadExecution(execution, true)
      } else {
        this.promoteUnreadFallback(execution, 'unread-marker-unavailable')
      }
      return
    }

    const currentScrollTop = runScrollShadowSafely<number | null>({
      event: 'unread-marker-read-scroll-top',
      conversationId: execution.request.conversationId,
      fallback: null,
      observe: () => execution.executor.readScrollTop(),
    })
    if (
      currentScrollTop !== null &&
      execution.landedTarget !== null &&
      Math.abs(currentScrollTop - execution.landedTarget) >
        UNREAD_MARKER_TAKEOVER_DRIFT_PX
    ) {
      const { conversationId, generation } = execution.request
      this.model = cancelReconciliationForUserInput(
        this.model,
        conversationId,
        generation,
      )
      this.finishUnreadExecution(execution, false)
      return
    }

    const result = runScrollShadowSafely<UnreadMarkerFrameResult>({
      event: 'unread-marker-frame',
      conversationId: execution.request.conversationId,
      fallback: { kind: 'unavailable' },
      observe: () => execution.executor.positionFrame(
        execution.request as UnreadMarkerRequest,
        lease,
      ),
    })
    if (!lease.isCurrent()) return

    if (result.kind === 'waiting') {
      this.recordUnreadMarkerFrame(execution, false)
      this.scheduleUnreadMarkerFrame(execution, lease)
      return
    }
    if (result.kind === 'unavailable') {
      this.promoteUnreadFallback(execution, 'unread-marker-unavailable')
      return
    }

    execution.resolved = true
    lease.markApplied()
    if (!lease.isCurrent()) return
    execution.resolvedAtLiveEdge ||= result.atLiveEdge

    let wrote = false
    if (
      execution.landedTarget !== null &&
      Math.abs(result.scrollTop - execution.landedTarget) <=
        UNREAD_MARKER_DRIFT_PX
    ) {
      execution.stableFrames += 1
      if (execution.stableFrames >= UNREAD_MARKER_STABLE_FRAMES) {
        if (execution.resolvedAtLiveEdge) {
          this.promoteUnreadFallback(
            execution,
            'unread-marker-resolved-at-live-edge',
          )
        } else {
          this.finishUnreadExecution(execution, true)
        }
        return
      }
    } else {
      wrote = true
      execution.stableFrames = 0
    }
    execution.landedTarget = result.scrollTop
    this.recordUnreadMarkerFrame(execution, wrote)
    this.scheduleUnreadMarkerFrame(execution, lease)
  }

  private scheduleUnreadMarkerFrame(
    execution: UnreadMarkerExecutionState,
    lease: PositionExecutionLease,
  ): void {
    if (!lease.isCurrent() || !execution.loop) return
    const scheduled = runScrollShadowSafely({
      event: 'unread-marker-frame-schedule',
      conversationId: execution.request.conversationId,
      fallback: false,
      observe: () => {
        execution.loop?.schedule(
          () => this.driveUnreadMarkerFrame(execution, lease),
        )
        return true
      },
    })
    if (!scheduled && lease.isCurrent()) {
      this.promoteUnreadFallback(execution, 'unread-marker-unavailable')
    }
  }

  private recordUnreadMarkerFrame(
    execution: UnreadMarkerExecutionState,
    wrote: boolean,
  ): void {
    runScrollShadowSafely({
      event: 'unread-marker-frame-monitor',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => execution.loop?.recordFrame(wrote),
    })
  }

  private promoteUnreadFallback(
    execution: UnreadMarkerExecutionState,
    reason:
      | 'unread-marker-unavailable'
      | 'unread-marker-resolved-at-live-edge',
  ): void {
    if (!this.isUnreadExecutionCurrent(execution)) return
    this.finishUnreadLoop(execution)
    execution.abortController?.abort()

    const generation = mintPositionGeneration()
    const request = withIdentity(
      execution.request.conversationId,
      generation,
      {
        source: { kind: 'fallback', reason },
        desired: { kind: 'live-edge', follow: true },
      },
    ) as UnreadMarkerFallbackRequest
    const accepted = acceptPositionRequest(this.model, request)
    if (accepted === this.model) {
      this.cancelUnreadExecution()
      return
    }

    execution.request = request
    execution.operation += 1
    execution.abortController = null
    this.model = advancePhaseIfCurrent(
      accepted,
      request.conversationId,
      request.generation,
      { kind: 'reconciling' },
    )
    const lease = this.beginUnreadOperation(execution)
    const applied = runScrollShadowSafely({
      event: reason,
      conversationId: request.conversationId,
      fallback: false,
      observe: () => execution.executor.applyLiveEdge(reason, lease),
    })
    if (!lease.isCurrent()) return
    if (applied) lease.markApplied()
    this.finishUnreadExecution(execution, false)
  }

  private beginUnreadOperation(
    execution: UnreadMarkerExecutionState,
  ): PositionExecutionLease {
    execution.abortController?.abort()
    const abortController = new AbortController()
    execution.abortController = abortController
    const operation = ++execution.operation
    const { conversationId, generation } = execution.request
    const isCurrent = () =>
      !abortController.signal.aborted &&
      this.unreadExecution === execution &&
      execution.operation === operation &&
      execution.request.conversationId === conversationId &&
      execution.request.generation === generation &&
      isCurrentGeneration(this.model, conversationId, generation)
    const advance = (phase: PositioningPhase) => {
      if (!isCurrent()) return false
      this.model = advancePhaseIfCurrent(
        this.model,
        conversationId,
        generation,
        phase,
      )
      return isCurrent()
    }
    return {
      conversationId,
      generation,
      operation,
      signal: abortController.signal,
      isCurrent,
      markApplied: () => advance({ kind: 'position-applied' }),
      settle: () => advance({ kind: 'settled' }),
    }
  }

  private isUnreadExecutionCurrent(
    execution: UnreadMarkerExecutionState,
  ): boolean {
    return (
      this.unreadExecution === execution &&
      isCurrentGeneration(
        this.model,
        execution.request.conversationId,
        execution.request.generation,
      )
    )
  }

  private finishUnreadExecution(
    execution: UnreadMarkerExecutionState,
    settle: boolean,
  ): void {
    if (settle && this.isUnreadExecutionCurrent(execution)) {
      const active = this.model.active
      if (active) {
        this.model = advancePhaseIfCurrent(
          this.model,
          active.request.conversationId,
          active.request.generation,
          { kind: 'settled' },
        )
      }
    }
    this.finishUnreadLoop(execution)
    execution.abortController?.abort()
    if (this.unreadExecution === execution) this.unreadExecution = null
  }

  private finishUnreadLoop(execution: UnreadMarkerExecutionState): void {
    const loop = execution.loop
    execution.loop = null
    if (!loop) return
    runScrollShadowSafely({
      event: 'unread-marker-loop-finish',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => loop.finish(),
    })
  }

  private driveSavedPosition(): void {
    const execution = this.savedExecution
    if (!execution || !this.isSavedExecutionCurrent(execution)) return

    const loadAround: SavedPositionLoadAroundStatus = execution.loadingAround
      ? 'loading'
      : execution.aroundAttempted
        ? 'exhausted'
        : execution.executor.loadAround
          ? 'available'
          : 'unavailable'
    const reachability = runScrollShadowSafely<ReachabilityFacts | null>({
      event: 'saved-position-reachability',
      conversationId: execution.request.conversationId,
      fallback: null,
      observe: () => execution.executor.reachability(
        execution.request.desired,
        loadAround,
      ),
    })
    if (!reachability) {
      this.promoteSavedFallback(execution, { kind: 'live-edge' })
      return
    }

    const phase = resolveReachability(execution.request, reachability)
    this.model = advancePhaseIfCurrent(
      this.model,
      execution.request.conversationId,
      execution.request.generation,
      phase,
    )
    if (!this.isSavedExecutionCurrent(execution)) return

    switch (phase.kind) {
      case 'resolving':
      case 'pending':
      case 'position-applied':
      case 'settled':
      case 'paused-user-input':
        return
      case 'recentering-live-edge':
        this.recenterSavedLiveEdge(execution)
        return
      case 'loading-around':
        this.startSavedAroundLoad(execution, phase.messageId)
        return
      case 'unavailable':
        this.promoteSavedFallback(execution, phase.policy)
        return
      case 'mounting':
      case 'reconciling': {
        execution.loadingAround = false
        const lease = this.beginSavedOperation(execution)
        const applied = runScrollShadowSafely({
          event: 'saved-position-reconcile',
          conversationId: execution.request.conversationId,
          fallback: false,
          observe: () => execution.executor.reconcile(execution.request, lease),
        })
        if (!lease.isCurrent()) return
        if (applied) {
          lease.markApplied()
        } else {
          this.promoteSavedFallback(
            execution,
            execution.request.onUnavailable ?? { kind: 'live-edge' },
          )
        }
      }
    }
  }

  private startSavedAroundLoad(
    execution: SavedPositionExecutionState,
    messageId: string,
  ): void {
    if (execution.loadingAround || execution.aroundAttempted) return
    execution.aroundAttempted = true
    execution.loadingAround = true
    const lease = this.beginSavedOperation(execution)
    const load = execution.executor.loadAround
      ? runScrollShadowSafely<Promise<unknown> | unknown | null>({
          event: 'saved-position-load-around',
          conversationId: execution.request.conversationId,
          fallback: null,
          observe: () => execution.executor.loadAround?.(messageId, lease.signal) ?? null,
        })
      : null
    if (load === null) {
      if (lease.isCurrent()) {
        execution.loadingAround = false
        this.driveSavedPosition()
      }
      return
    }
    void Promise.resolve(load)
      .catch(() => undefined)
      .finally(() => {
        if (!lease.isCurrent()) return
        execution.loadingAround = false
        this.driveSavedPosition()
      })
  }

  private recenterSavedLiveEdge(
    execution: SavedPositionExecutionState,
  ): void {
    const recenter = execution.executor.recenterLiveEdge
    const version = execution.executor.recenterVersion
    if (!recenter || !version) {
      this.finishAtBestAvailableLiveEdge(execution)
      return
    }
    if (execution.lastRecenterVersion === version) return
    execution.lastRecenterVersion = version
    const lease = this.beginSavedOperation(execution)
    const result = runScrollShadowSafely({
      event: 'saved-position-recenter-live-edge',
      conversationId: execution.request.conversationId,
      fallback: 'unavailable' as const,
      observe: () => recenter(lease.signal),
    })
    if (!lease.isCurrent()) return
    if (result === 'unavailable') {
      this.finishAtBestAvailableLiveEdge(execution)
    }
  }

  private finishAtBestAvailableLiveEdge(
    execution: SavedPositionExecutionState,
  ): void {
    if (!this.isSavedExecutionCurrent(execution)) return
    const lease = this.beginSavedOperation(execution)
    const applied = runScrollShadowSafely({
      event: 'saved-position-live-edge-best-effort',
      conversationId: execution.request.conversationId,
      fallback: false,
      observe: () => execution.executor.reconcile(execution.request, lease),
    })
    if (!lease.isCurrent()) return
    if (applied) {
      lease.markApplied()
    } else {
      this.cancelSavedExecution()
    }
  }

  private promoteSavedFallback(
    execution: SavedPositionExecutionState,
    policy: UnavailablePolicy,
  ): void {
    if (!this.isSavedExecutionCurrent(execution)) return
    const desired =
      policy.kind === 'legacy-offset'
        ? { kind: 'legacy-offset' as const, offsetPx: policy.offsetPx }
        : { kind: 'live-edge' as const, follow: true as const }
    if (
      execution.request.source.kind === 'fallback' &&
      execution.request.desired.kind === 'live-edge'
    ) {
      this.finishAtBestAvailableLiveEdge(execution)
      return
    }

    const generation = mintPositionGeneration()
    const draft: PositionRequestDraft = {
      source: { kind: 'fallback', reason: 'saved-position-unavailable' },
      desired,
    }
    const request = withIdentity(
      execution.request.conversationId,
      generation,
      draft,
    ) as SavedPositionRequest
    const accepted = acceptPositionRequest(this.model, request)
    if (accepted === this.model) {
      this.cancelSavedExecution()
      return
    }
    execution.abortController?.abort()
    execution.request = request
    execution.operation += 1
    execution.abortController = null
    execution.loadingAround = false
    execution.aroundAttempted = true
    execution.lastRecenterVersion = null
    this.model = accepted
    this.driveSavedPosition()
  }

  private beginSavedOperation(
    execution: SavedPositionExecutionState,
  ): SavedPositionExecutionLease {
    execution.abortController?.abort()
    const abortController = new AbortController()
    execution.abortController = abortController
    const operation = ++execution.operation
    const { conversationId, generation } = execution.request
    const isCurrent = () =>
      !abortController.signal.aborted &&
      this.savedExecution === execution &&
      execution.operation === operation &&
      execution.request.conversationId === conversationId &&
      execution.request.generation === generation &&
      isCurrentGeneration(this.model, conversationId, generation)
    const advance = (phase: PositioningPhase) => {
      if (!isCurrent()) return false
      if (
        phase.kind === 'position-applied' &&
        this.model.active?.phase.kind === 'settled'
      ) {
        return true
      }
      this.model = advancePhaseIfCurrent(
        this.model,
        conversationId,
        generation,
        phase,
      )
      return isCurrent()
    }
    return {
      conversationId,
      generation,
      operation,
      signal: abortController.signal,
      isCurrent,
      markApplied: () => advance({ kind: 'position-applied' }),
      settle: () => advance({ kind: 'settled' }),
    }
  }

  private isSavedExecutionCurrent(
    execution: SavedPositionExecutionState,
  ): boolean {
    return (
      this.savedExecution === execution &&
      isCurrentGeneration(
        this.model,
        execution.request.conversationId,
        execution.request.generation,
      )
    )
  }

  private cancelExecutionsIfSuperseded(): void {
    const execution = this.savedExecution
    if (execution && !this.isSavedExecutionCurrent(execution)) {
      this.cancelSavedExecution()
    }
    const unreadExecution = this.unreadExecution
    if (
      unreadExecution &&
      !this.isUnreadExecutionCurrent(unreadExecution)
    ) {
      this.cancelUnreadExecution()
    }
  }

  private cancelSavedExecution(): void {
    this.savedExecution?.abortController?.abort()
    this.savedExecution = null
  }

  private cancelUnreadExecution(): void {
    if (this.unreadExecution) {
      this.finishUnreadLoop(this.unreadExecution)
      this.unreadExecution.abortController?.abort()
    }
    this.unreadExecution = null
  }
}

export type { PositionRequestDraft }
