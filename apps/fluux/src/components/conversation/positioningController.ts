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

export interface SavedPositionExecutionLease {
  conversationId: string
  generation: number
  operation: number
  signal: AbortSignal
  isCurrent: () => boolean
  markApplied: () => boolean
  settle: () => boolean
}

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

interface SavedPositionExecutionState {
  request: SavedPositionRequest
  executor: SavedPositionExecutor
  operation: number
  abortController: AbortController | null
  aroundAttempted: boolean
  loadingAround: boolean
  lastRecenterVersion: string | null
}

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
        this.cancelSavedExecutionIfSuperseded()
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
        this.cancelSavedExecutionIfSuperseded()
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
        this.cancelSavedExecutionIfSuperseded()
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
        this.cancelSavedExecutionIfSuperseded()
      },
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

  private cancelSavedExecutionIfSuperseded(): void {
    const execution = this.savedExecution
    if (execution && !this.isSavedExecutionCurrent(execution)) {
      this.cancelSavedExecution()
    }
  }

  private cancelSavedExecution(): void {
    this.savedExecution?.abortController?.abort()
    this.savedExecution = null
  }
}

export type { PositionRequestDraft }
