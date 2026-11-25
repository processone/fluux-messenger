import type { ViewportGeometry, ViewportInput } from './viewportSession'
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
  shouldRearmLiveEdgeFromGeometry,
  shouldReconcileAfterAppend,
  type DirectionalHistoryRequest,
  type EntryPositionFacts,
  type ExplicitTargetRequest,
  type InteractionPositionRequest,
  type LayoutPreservationRequest,
  type LayoutPreservationReason,
  type LiveEdgeRequest,
  type LiveEdgeNavigationFacts,
  type MediaPreservationRequest,
  type AnchorPreservationRequest,
  type PositionRequest,
  type PositioningModel,
  type PositioningPhase,
  type ReachabilityFacts,
  type ResidentTopRequest,
  type SavedPositionRequest,
  type UnreadMarkerRequest,
} from './scrollPositionModel'
import {
  compareShadowDecision,
  phaseCategory,
  runScrollShadowSafely,
  type ShadowActualDecision,
} from './scrollPositionShadow'
import {
  PositionRunner,
  mintPositionGeneration,
  reachabilityMatchesRequest,
  withIdentity,
  type PositionRequestDraft,
} from './positionRunner'
import {
  acceptLiveEdge,
  beginAnchorRun,
  beginDirectionalRun,
  beginExplicitTargetRun,
  beginResidentTop,
  beginSavedPositionRun,
  beginUnreadMarkerRun,
  driveAnchor,
  driveExplicitTarget,
  driveSavedPosition,
  finishExplicitTarget,
  installAnchorRun,
  reassertUnreadMarker,
  reconcileDirectional,
  refreshLiveEdge,
  restartLiveEdge,
  startExplicitTargetRun,
  startLiveEdgeRun,
} from './placementStrategies'
import type {
  AnchorPreservationExecutor,
  DirectionalHistoryExecutor,
  ExplicitTargetExecutor,
  LiveEdgeExecutor,
  ResidentTopExecutor,
  SavedPositionExecutor,
  UnreadMarkerExecutor,
} from './positionExecutors'

// The executors the browser adapters implement, and the lease and loop they are handed, live in
// `positionExecutors`; they stay importable from here, where every adapter already looks.
export * from './positionExecutors'
export { reachabilityMatchesRequest }
export type { PositionRequestDraft }

/**
 * How long held input outlives the last input or scroll the reader produced. iOS dispatches
 * `touchend` to the element the touch started on, so a row virtualised away mid-drag swallows it;
 * without this bound a lost release would disable following the live edge until the next touch.
 */
const HELD_INPUT_TIMEOUT_MS = 1500

/**
 * Ambient corrections that keep the reader's current reading point rather than move it. Accepting
 * one does not mean the reader moved on, so a directional restore whose load is still in flight may
 * still restore a later window shift (FLM-204).
 */
const HOLDS_READING_POINT: ReadonlySet<PositionRequest['source']['kind']> = new Set([
  'layout-preservation',
  'media-preservation',
  'history-preservation',
])

export interface UserScrollInput extends ViewportInput {
  geometry: ViewportGeometry
}

export class PositioningController {
  private currentModel: PositioningModel = initialPositioningModel()
  private interactionWasFollowing = false
  // Input can end before its layout compensation; keep eligibility with this position generation.
  private interactionCanSettleBottom = false

  private readonly runner = new PositionRunner({
    getModel: () => this.model,
    setModel: (model) => { this.model = model },
    accept: (request) => this.acceptRequest(request),
    hasPendingNavigation: (conversationId) => this.hasPendingNavigation(conversationId),
  })

  constructor(
    private readonly onMessageTargetOwnership?: (owned: boolean) => void,
    private readonly onUserNavigation?: (conversationId: string) => void,
    private readonly onUserTakeover?: (conversationId: string) => void,
    private readonly onInteractionEnd?: () => void,
  ) {}

  private get model(): PositioningModel {
    return this.currentModel
  }

  private set model(model: PositioningModel) {
    const wasOwned = this.ownsPositionTarget()
    const wasHeld = this.hasInteractionHold()
    const previousTarget = this.currentModel.active?.request.desired
    if (model.currentConversationId !== this.currentModel.currentConversationId ||
      model.active?.request.generation !== this.currentModel.active?.request.generation) {
      this.interactionCanSettleBottom = false
    }
    this.currentModel = model
    if (wasHeld && !this.hasInteractionHold()) this.onInteractionEnd?.()
    const owned = this.ownsPositionTarget()
    if (wasOwned !== owned || (owned && previousTarget !== model.active?.request.desired)) {
      this.onMessageTargetOwnership?.(owned)
    }
  }

  private acceptRequest(request: PositionRequest): PositioningModel {
    const accepted = acceptPositionRequest(this.model, request)
    if (accepted !== this.model) {
      if (!HOLDS_READING_POINT.has(request.source.kind)) this.readerMovedAt = request.generation
      if (request.source.kind === 'entry' || request.conversationId !== this.model.currentConversationId ||
        request.desired.kind === 'live-edge') this.unreadMarkerHold = null
      if (request.source.kind === 'entry' || request.conversationId !== this.model.currentConversationId) {
        this.heldInput = null
        this.deferredLiveEdge = null
      }
      if ((request.source.kind === 'entry' || request.source.kind === 'user-navigation') &&
        request.source.reason === 'unread-marker') this.unreadMarkerHold = request.conversationId
      if (request.source.kind === 'user-navigation') this.onUserNavigation?.(request.conversationId)
    }
    return accepted
  }

  hasUnreadMarkerHold(conversationId: string): boolean {
    return this.unreadMarkerHold === conversationId && this.model.currentConversationId === conversationId
  }

  ownsMessageTarget(): boolean {
    const source = this.currentModel.active?.request.source
    return source?.kind === 'user-navigation' && source.reason === 'message-target'
  }

  /**
   * The reader's own navigation has not landed yet: a message jump, return-to-latest or Home,
   * including the load each starts first, and a visit to the unread divider from return-to-latest
   * or the jump-to-last-read pill.
   * Visibility maintenance of a settled target, follow-live maintenance and the divider placed on
   * entering a conversation are not navigation.
   */
  hasPendingNavigation(conversationId: string): boolean {
    const { runner } = this
    if (runner.currentRun('explicit-target', conversationId)?.purpose === 'navigation') return true
    const unread = runner.currentRun('unread-marker', conversationId)
    if (unread !== null && unread.request.source.kind === 'user-navigation') return true
    if (runner.currentRun('live-edge', conversationId)?.purpose === 'navigation') return true
    return runner.currentRun('resident-top', conversationId) !== null
  }

  hasInteractionHold(): boolean {
    const source = this.currentModel.active?.request.source
    return source?.kind === 'interaction' && source.reason === 'hold'
  }

  hasInteractionPosition(): boolean {
    return this.currentModel.active?.request.source.kind === 'interaction'
  }

  ownsPositionTarget(): boolean {
    return this.ownsMessageTarget() || this.hasInteractionHold()
  }

  beginInteractionHold(input: {
    conversationId: string
    desired: InteractionPositionRequest['desired']
    executor: AnchorPreservationExecutor
  }): InteractionPositionRequest | null {
    if (this.isInputHeld(input.conversationId)) return null
    const following = this.hasInteractionHold()
      ? this.interactionWasFollowing
      : shouldReconcileAfterAppend(this.model, input.conversationId)
    const request = this.beginAnchorPreservation({
      ...input,
      source: { kind: 'interaction', reason: 'hold' },
    }) as InteractionPositionRequest | null
    if (request) this.interactionWasFollowing = following
    return request
  }

  reconcileInteractionHold(input: {
    conversationId: string
    typingBandHeight?: number
    controlBounds?: { topPx: number; bottomPx: number }
    executor: AnchorPreservationExecutor
  }): boolean {
    const active = this.model.active
    if (!this.hasInteractionHold() || !active || active.request.conversationId !== input.conversationId) return false
    // A new layout must land before paint even while a prior settle loop is still running.
    // Keep the generation, but replace its leased operation rather than waiting another frame.
    this.runner.cancel('anchor-preservation', 'superseded')
    let request = active.request as InteractionPositionRequest
    const placement = request.desired.placement
    if (placement.kind === 'top-offset' && placement.typingClearance) {
      const previous = placement.typingClearance
      const currentBandHeightPx = input.typingBandHeight ?? previous.currentBandHeightPx
      const controlTopPx = input.controlBounds?.topPx ?? previous.controlTopPx
      const controlBottomPx = input.controlBounds?.bottomPx ?? previous.controlBottomPx
      if (currentBandHeightPx !== previous.currentBandHeightPx || controlTopPx !== previous.controlTopPx || controlBottomPx !== previous.controlBottomPx) {
        request = { ...request, desired: { ...request.desired, placement: {
          ...placement, typingClearance: { ...previous, currentBandHeightPx, controlTopPx, controlBottomPx },
        } } }
        this.model = { ...this.model, active: { ...active, request } }
      }
    }
    const run = installAnchorRun(this.runner, request, input.executor)
    this.model = advancePhaseIfCurrent(this.model, input.conversationId, request.generation, { kind: 'reconciling' })
    driveAnchor(this.runner, run)
    return true
  }

  releaseInteractionHold(input: {
    conversationId: string
    resume: boolean
    liveEdge: LiveEdgeExecutor
  }): void {
    const active = this.model.active
    if (!this.hasInteractionHold() || !active || active.request.conversationId !== input.conversationId) return
    const resume = input.resume && this.interactionWasFollowing
    this.runner.cancel('anchor-preservation', 'superseded')
    this.model = {
      ...this.model,
      active: {
        request: { ...active.request, source: { kind: 'interaction', reason: 'released' } } as InteractionPositionRequest,
        phase: { kind: 'settled' },
      },
    }
    if (resume) this.beginLiveEdgeRequest({
      conversationId: input.conversationId,
      source: { kind: 'ambient-live-edge', reason: 'interaction-release' },
      executor: input.liveEdge,
    })
  }

  preserveReadingLayout(conversationId: string, apply: () => boolean): boolean {
    const active = this.model.active
    if (
      this.model.currentConversationId !== conversationId || this.ownsPositionTarget() ||
      (active && (active.phase.kind !== 'settled' || active.request.desired.kind === 'live-edge'))
    ) return false
    const atLiveEdge = apply()
    this.observeInteractionLayout(conversationId, atLiveEdge)
    return true
  }

  /** An applied correction can finish an eligible input after the gesture itself ended. */
  observeInteractionLayout(conversationId: string, atLiveEdge: boolean): void {
    if (!this.interactionCanSettleBottom || !atLiveEdge || this.isInputHeld(conversationId)) return
    const active = this.model.active
    if (active?.request.conversationId !== conversationId ||
      active.request.source.kind !== 'interaction' || active.request.source.reason !== 'released') return
    this.observeSettledUserGeometry({ conversationId, generation: active.request.generation, atLiveEdge: true })
  }
  private targetTakeover: {
    conversationId: string
    generation: number
    direction: number
  } | null = null
  private unreadMarkerHold: string | null = null
  /**
   * The newest generation at which the reader moved on: their own input took over, or a request
   * other than an ambient correction was accepted. See {@link holdsDirectionalReading}.
   */
  private readerMovedAt = 0
  /**
   * The conversation whose reader is touching, dragging the scrollbar, holding a scroll key or
   * mid-wheel, from {@link holdInput} to {@link observeUserInputEnd}. No ambient
   * stimulus may re-pin the live edge under that input: a row that changes height on every frame
   * would otherwise snap the viewport back before the finger leaves the bottom threshold.
   */
  private heldInput: {
    conversationId: string
    /**
     * The re-pin refused under this input, if any. `rearmEligibleFromGeometry` is the refused
     * caller's verdict, taken before its own growth moved the reader; any later movement by the
     * reader voids it, since the reader then decides where they are.
     */
    deferred: { rearmEligibleFromGeometry: boolean } | null
    lastInputAt: number
  } | null = null
  /** A re-pin refused under held input, owed once that input ends. */
  private deferredLiveEdge: { conversationId: string; rearmEligibleFromGeometry: boolean } | null = null
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
    return beginSavedPositionRun(
      this.runner,
      input.conversationId,
      selection as PositionRequestDraft,
      input.executor,
    )
  }

  refreshSavedPosition(input: {
    conversationId: string
    generation: number
    executor: SavedPositionExecutor
  }): boolean {
    const run = this.runner.slot('saved-position')
    if (
      !run ||
      run.request.conversationId !== input.conversationId ||
      run.request.generation !== input.generation ||
      !isCurrentGeneration(this.model, input.conversationId, input.generation)
    ) {
      return false
    }
    run.executor = input.executor
    driveSavedPosition(this.runner, run)
    return true
  }

  savedPositionStatus(conversationId: string): {
    request: SavedPositionRequest
    phase: PositioningPhase
  } | null {
    const run = this.runner.slot('saved-position')
    const active = this.model.active
    if (
      !run ||
      !active ||
      active.request !== run.request ||
      active.request.conversationId !== conversationId
    ) {
      return null
    }
    return {
      request: run.request,
      phase: active.phase,
    }
  }

  isSavedPositionPending(conversationId: string): boolean {
    const status = this.savedPositionStatus(conversationId)
    return status !== null &&
      status.phase.kind !== 'position-applied' &&
      status.phase.kind !== 'settled'
  }

  beginLiveEdgeEntry(input: {
    conversationId: string
    entryFacts: EntryPositionFacts
    executor: LiveEdgeExecutor
  }): LiveEdgeRequest | null {
    return runScrollShadowSafely({
      event: 'live-edge-entry',
      conversationId: input.conversationId,
      fallback: null,
      observe: () => {
        const selection = selectEntryPosition(input.entryFacts)
        if (selection.desired.kind !== 'live-edge') return null
        return acceptLiveEdge(
          this.runner,
          input.conversationId,
          (selection as Omit<
            LiveEdgeRequest,
            'conversationId' | 'generation'
          >).source,
          input.executor,
        )
      },
    })
  }

  beginLiveEdgeNavigation(input: {
    conversationId: string
    navigationFacts: LiveEdgeNavigationFacts
    executor: LiveEdgeExecutor
  }): LiveEdgeRequest | null {
    return runScrollShadowSafely({
      event: 'live-edge-navigation',
      conversationId: input.conversationId,
      fallback: null,
      observe: () => {
        const selection = selectLiveEdgeNavigation(input.navigationFacts)
        if (selection.desired.kind !== 'live-edge') return null
        return acceptLiveEdge(
          this.runner,
          input.conversationId,
          (selection as Omit<
            LiveEdgeRequest,
            'conversationId' | 'generation'
          >).source,
          input.executor,
          'navigation',
        )
      },
    })
  }

  beginLiveEdgeRequest(input: {
    conversationId: string
    source: LiveEdgeRequest['source']
    executor: LiveEdgeExecutor
  }): LiveEdgeRequest | null {
    return runScrollShadowSafely({
      event: 'live-edge-request',
      conversationId: input.conversationId,
      fallback: null,
      observe: () => acceptLiveEdge(
        this.runner,
        input.conversationId,
        input.source,
        input.executor,
      ),
    })
  }

  reconcileLiveEdge(input: {
    conversationId: string
    executor: LiveEdgeExecutor
    rearmEligibleFromGeometry: boolean
  }): boolean {
    return runScrollShadowSafely({
      event: 'live-edge-reconcile',
      conversationId: input.conversationId,
      fallback: false,
      observe: () => {
        if (this.isInputHeld(input.conversationId)) {
          this.heldInput!.deferred = { rearmEligibleFromGeometry: input.rearmEligibleFromGeometry }
          return false
        }
        if (!shouldReconcileAfterAppend(this.model, input.conversationId)) {
          return this.rearmLiveEdgeFromGeometry(
            input.conversationId,
            input.executor,
            input.rearmEligibleFromGeometry,
          )
        }
        const active = this.model.active
        if (!active || active.request.desired.kind !== 'live-edge') return false
        const run = this.runner.slot('live-edge')
        if (!run || run.request !== active.request || !this.runner.isCurrent(run)) {
          this.runner.cancel('live-edge', 'superseded')
          startLiveEdgeRun(this.runner, active.request as LiveEdgeRequest, input.executor)
        } else {
          restartLiveEdge(this.runner, run, input.executor)
        }
        return true
      },
    })
  }

  private rearmLiveEdgeFromGeometry(
    conversationId: string,
    executor: LiveEdgeExecutor,
    rearmEligibleFromGeometry: boolean,
  ): boolean {
    if (!shouldRearmLiveEdgeFromGeometry(this.model, conversationId)) return false
    if (this.hasUnreadMarkerHold(conversationId)) return false
    if (!rearmEligibleFromGeometry || !this.canRearmAfterTargetTakeover(conversationId)) return false
    return acceptLiveEdge(
      this.runner,
      conversationId,
      { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor,
    ) !== null
  }

  refreshLiveEdge(input: {
    conversationId: string
    executor: LiveEdgeExecutor
  }): boolean {
    const run = this.runner.currentRun('live-edge', input.conversationId)
    if (!run) return false
    refreshLiveEdge(this.runner, run, input.executor)
    return true
  }

  beginMediaPreservation(input: {
    conversationId: string
    desired: MediaPreservationRequest['desired']
    executor: AnchorPreservationExecutor
  }): MediaPreservationRequest | null {
    return this.beginAnchorPreservation({
      ...input,
      source: { kind: 'media-preservation', reason: 'remeasure' },
    }) as MediaPreservationRequest | null
  }

  beginLayoutPreservation(input: {
    conversationId: string
    desired: LayoutPreservationRequest['desired']
    reason: LayoutPreservationReason
    executor: AnchorPreservationExecutor
  }): LayoutPreservationRequest | null {
    const { reason, ...rest } = input
    return this.beginAnchorPreservation({
      ...rest,
      source: { kind: 'layout-preservation', reason },
    }) as LayoutPreservationRequest | null
  }

  rebaseMediaPreservation(conversationId: string, desired: MediaPreservationRequest['desired']): boolean {
    const run = this.runner.currentRun('anchor-preservation', conversationId)
    const active = this.model.active
    if (!run || !active || run.request.source.kind !== 'media-preservation') return false
    run.request = { ...run.request, desired } as MediaPreservationRequest
    run.stableFrames = 0
    run.landedTarget = null
    this.model = { ...this.model, active: { ...active, request: run.request } }
    return true
  }

  private beginAnchorPreservation(input: {
    conversationId: string
    source: AnchorPreservationRequest['source']
    desired: AnchorPreservationRequest['desired']
    executor: AnchorPreservationExecutor
  }): AnchorPreservationRequest | null {
    if (this.ownsMessageTarget() && input.source.kind !== 'interaction') return null
    return runScrollShadowSafely({
      event: `${input.source.kind}-begin`,
      conversationId: input.conversationId,
      fallback: null,
      observe: () => beginAnchorRun(this.runner, input),
    })
  }

  beginDirectionalHistory(input: {
    conversationId: string
    desired: DirectionalHistoryRequest['desired']
    distanceFromBottom: Extract<
      DirectionalHistoryRequest['onUnavailable'],
      { kind: 'distance-from-bottom' }
    >['distancePx']
    executor: DirectionalHistoryExecutor
  }): DirectionalHistoryRequest | null {
    return runScrollShadowSafely({
      event: 'directional-history-begin',
      conversationId: input.conversationId,
      fallback: null,
      observe: () => beginDirectionalRun(this.runner, input),
    })
  }

  reconcileDirectionalHistory(input: {
    conversationId: string
    generation: number
    executor: DirectionalHistoryExecutor
  }): boolean {
    return runScrollShadowSafely({
      event: 'directional-history-reconcile',
      conversationId: input.conversationId,
      fallback: false,
      observe: () => {
        const run = this.currentDirectionalRun(input.conversationId, input.generation)
        return run !== null && reconcileDirectional(this.runner, run, input.executor)
      },
    })
  }

  cancelDirectionalHistoryWithoutShift(input: {
    conversationId: string
    generation: number
  }): boolean {
    if (!this.currentDirectionalRun(input.conversationId, input.generation)) return false
    this.runner.cancel('directional-history', 'no-window-shift')
    if (
      this.model.active?.request.conversationId === input.conversationId &&
      this.model.active.request.generation === input.generation
    ) {
      this.model = { ...this.model, active: null }
    }
    return true
  }

  /**
   * Whether the reader still reads where the directional restore with `generation` put them:
   * neither their own input nor any request other than an ambient correction has come since. A
   * window shift that lands while that restore's load is still in flight may then be restored
   * again; otherwise it would pull a reader who moved on back to the captured anchor (FLM-204).
   */
  holdsDirectionalReading(conversationId: string, generation: number): boolean {
    return (
      this.model.currentConversationId === conversationId &&
      this.readerMovedAt < generation
    )
  }

  /**
   * Whether a directional history request, the one with `generation` when given, is accepted, still
   * current and not yet applied.
   */
  isDirectionalHistoryPending(conversationId: string, generation?: number): boolean {
    const run = this.runner.currentRun('directional-history', conversationId)
    return run !== null && (generation === undefined || run.request.generation === generation) && !run.applied
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
        return beginUnreadMarkerRun(
          this.runner,
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
        return beginUnreadMarkerRun(
          this.runner,
          input.conversationId,
          selection as PositionRequestDraft,
          input.executor,
        )
      },
    })
  }

  beginResidentTopNavigation(input: {
    conversationId: string
    executor: ResidentTopExecutor
  }): ResidentTopRequest | null {
    return runScrollShadowSafely({
      event: 'resident-top-begin',
      conversationId: input.conversationId,
      fallback: null,
      observe: () => beginResidentTop(this.runner, input.conversationId, input.executor),
    })
  }

  beginExplicitTarget(input: {
    conversationId: string
    messageId: string
    executor: ExplicitTargetExecutor
  }): ExplicitTargetRequest | null {
    return runScrollShadowSafely({
      event: 'explicit-target-begin',
      conversationId: input.conversationId,
      fallback: null,
      observe: () => beginExplicitTargetRun(this.runner, input),
    })
  }

  refreshExplicitTarget(input: {
    conversationId: string
    generation: number
    executor: ExplicitTargetExecutor
  }): boolean {
    const run = this.runner.slot('explicit-target')
    if (
      !run ||
      run.purpose !== 'navigation' ||
      run.request.conversationId !== input.conversationId ||
      run.request.generation !== input.generation ||
      !this.runner.isCurrent(run)
    ) {
      return false
    }
    run.executor = input.executor
    driveExplicitTarget(this.runner, run)
    return true
  }

  /** Reapply a settled target when viewport geometry changes, without acquiring follow-live. */
  reconcileMessageTargetAfterResize(input: {
    conversationId: string
    executor: ExplicitTargetExecutor
  }): boolean {
    return runScrollShadowSafely({
      event: 'message-target-resize',
      conversationId: input.conversationId,
      fallback: false,
      observe: () => {
        const active = this.model.active
        if (
          this.model.currentConversationId !== input.conversationId ||
          !active ||
          active.phase.kind !== 'settled' ||
          active.request.source.kind !== 'user-navigation' ||
          active.request.source.reason !== 'message-target'
        ) return false

        const request = active.request as ExplicitTargetRequest
        const reachability = input.executor.reachability(request.desired, 'unavailable')
        // Layout maintenance only applies to a mounted target; it must not load history.
        if (reachability.kind !== 'available' || !reachability.mounted) return false
        startExplicitTargetRun(this.runner, request, {
          ...input.executor,
          loadAround: undefined,
          positionFrame: (request, lease) =>
            input.executor.positionFrame(request, lease, 'keep-visible'),
          // Resizing is not another navigation: do not consume a target or repeat its highlight.
          complete: () => {},
        }, 'maintenance')
        return true
      },
    })
  }

  cancelExplicitTarget(conversationId: string, generation: number): boolean {
    const run = this.runner.slot('explicit-target')
    if (
      !run ||
      run.request.conversationId !== conversationId ||
      run.request.generation !== generation ||
      !this.runner.isCurrent(run)
    ) {
      return false
    }
    this.model = advancePhaseIfCurrent(
      this.model,
      conversationId,
      generation,
      { kind: 'settled' },
    )
    this.runner.cancel('explicit-target', undefined)
    return true
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
        const accepted = this.acceptRequest(request)
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

  /**
   * Returns the generation this input paused, or null when there was nothing to pause. The caller
   * hands it back to {@link observeSettledUserGeometry} so the settle resolves that same pause and
   * not whichever request has taken over by the time the geometry is read.
   */
  observeUserInput(conversationId: string, input?: UserScrollInput, scrollDelta = 0): number | null {
    return runScrollShadowSafely<number | null>({
      event: 'user-input',
      conversationId,
      fallback: null,
      observe: () => {
        if (this.heldInput?.conversationId === conversationId) {
          this.heldInput.lastInputAt = Date.now()
          if (input && input.deltaY !== 0) {
            this.interactionCanSettleBottom = input.deltaY > 0 || input.geometry.top <= 0
          }
        }
        const active = this.model.active
        if (
          input && active?.request.conversationId === conversationId &&
          active.request.source.kind === 'user-navigation' &&
          active.request.source.reason === 'message-target'
        ) {
          const execution = this.runner.slot('explicit-target')
          const maintainingTarget = execution?.purpose === 'maintenance' || (
            execution === null &&
            (active.phase.kind === 'settled' || active.phase.kind === 'paused-user-input')
          )
          const { top, height, client } = input.geometry
          if (maintainingTarget && input.source === undefined && input.deltaY > 0 && height - top - client <= 0 && scrollDelta === 0) {
            return null
          }
          if (input.deltaY >= 0 && active.phase.kind === 'paused-user-input' && this.hasCurrentTargetTakeover(conversationId)) {
            return active.request.generation
          }
          this.targetTakeover = {
            conversationId,
            generation: active.request.generation,
            direction: input.deltaY < 0 ? -1 : 0,
          }
          if (maintainingTarget && input.deltaY >= 0) {
            this.model = advancePhaseIfCurrent(
              this.model,
              conversationId,
              active.request.generation,
              { kind: 'paused-user-input' },
            )
            this.runner.cancel('explicit-target', undefined)
            this.onUserTakeover?.(conversationId)
            return active.request.generation
          }
        } else if (active && this.hasCurrentTargetTakeover(conversationId)) {
          return null
        }
        const generation = active?.request.generation
        if (generation === undefined) {
          this.readerMovedAt = this.model.watermark
          return null
        }
        const { runner } = this
        const targetExecution = runner.currentRun('explicit-target', conversationId)
        const liveEdgeWasCurrent = runner.currentRun('live-edge', conversationId) !== null
        const mediaWasCurrent = runner.currentRun('anchor-preservation', conversationId) !== null
        const directionalExecution = runner.currentRun('directional-history', conversationId)
        const residentTopWasCurrent = runner.currentRun('resident-top', conversationId) !== null
        // A boundary wheel can start a directional load and be followed by more wheel events while
        // the network request is still pending. The former prepend loop armed user takeover only
        // after the batch landed and reconciliation began, so those pre-load events could not
        // discard the saved anchor. Preserve that contract: there is no pixel owner to take over
        // until the synchronous initial write has run. Explicit competing position requests still
        // supersede this pending generation through normal request arbitration.
        if (directionalExecution && !directionalExecution.applied) {
          return null
        }
        this.readerMovedAt = this.model.watermark
        this.model = cancelReconciliationForUserInput(
          this.model,
          conversationId,
          generation,
        )
        if (targetExecution) {
          finishExplicitTarget(runner, targetExecution, false, 'user-takeover')
        }
        if (liveEdgeWasCurrent) runner.cancel('live-edge', 'user-takeover')
        if (mediaWasCurrent) runner.cancel('anchor-preservation', 'user-takeover')
        if (directionalExecution) runner.cancel('directional-history', 'user-takeover')
        if (residentTopWasCurrent) runner.cancel('resident-top', 'user-takeover')
        this.cancelExecutionsIfSuperseded()
        if (this.model.active === null || (
          this.model.active.request.generation === generation &&
          this.model.active.phase.kind === 'paused-user-input'
        )) this.onUserTakeover?.(conversationId)
        return generation
      },
    })
  }

  observeUserScroll(conversationId: string, delta: number, atLiveEdge = false): void {
    // A newer upward pixel invalidates earlier downward intent, even after input-end.
    if (delta < 0 && this.model.currentConversationId === conversationId) this.interactionCanSettleBottom = false
    if (delta !== 0 && this.heldInput?.conversationId === conversationId && this.heldInput.deferred) {
      this.heldInput.deferred.rearmEligibleFromGeometry = false
    }
    const active = this.model.active
    if (delta !== 0 && !this.hasCurrentTargetTakeover(conversationId) &&
      !(active?.request.source.kind === 'user-navigation' && active.request.source.reason === 'message-target')) {
      const leavingInteraction = delta < 0 && active?.request.source.kind === 'interaction'
      const generation = this.observeUserInput(conversationId)
      // Even the first upward pixel wins over the interaction's one-pixel bottom tolerance.
      this.observeSettledUserGeometry({ conversationId, generation, atLiveEdge: atLiveEdge && !leavingInteraction })
      return
    }
    if (!this.hasCurrentTargetTakeover(conversationId)) {
      const active = this.model.active
      if (
        delta === 0 || active?.request.conversationId !== conversationId ||
        active.request.source.kind !== 'user-navigation' ||
        active.request.source.reason !== 'message-target'
      ) return
      const generation = active.request.generation
      this.observeUserInput(conversationId)
      this.targetTakeover = { conversationId, generation, direction: 0 }
    }
    const takeover = this.targetTakeover!
    if (delta !== 0) {
      takeover.direction = Math.sign(delta)
      this.model = cancelReconciliationForUserInput(this.model, conversationId, takeover.generation)
      this.cancelExecutionsIfSuperseded()
      this.observeSettledUserGeometry({ conversationId, generation: takeover.generation, atLiveEdge })
    }
  }

  /**
   * Native input started or continued: a touch, a scrollbar drag, a held scroll key or a wheel
   * burst. Only a source that also reports {@link observeUserInputEnd} may call this.
   */
  holdInput(conversationId: string): void {
    if (this.heldInput?.conversationId === conversationId) {
      this.heldInput.lastInputAt = Date.now()
    } else {
      this.heldInput = { conversationId, deferred: null, lastInputAt: Date.now() }
      if (this.model.currentConversationId === conversationId) this.interactionCanSettleBottom = false
    }
  }

  observeUserInputEnd(conversationId: string, atLiveEdge = false): boolean {
    const held = this.heldInput
    if (held?.conversationId === conversationId) {
      if (held.deferred) this.deferredLiveEdge = { conversationId, ...held.deferred }
      this.heldInput = null
    }
    if (held?.conversationId === conversationId) this.observeInteractionLayout(conversationId, atLiveEdge)
    if (atLiveEdge && this.hasUnreadMarkerHold(conversationId)) {
      this.unreadMarkerHold = null
      this.observeSettledUserGeometry({
        conversationId,
        generation: this.model.active?.request.generation ?? null,
        atLiveEdge: true,
      })
    }
    if (!this.hasCurrentTargetTakeover(conversationId)) return false
    if (this.model.active && this.model.active.phase.kind !== 'paused-user-input') return false
    const active = this.model.active
    if (!active || active.phase.kind !== 'paused-user-input') return false
    this.model = { ...this.model, active: { ...active, phase: { kind: 'settled' } } }
    return true
  }

  private isInputHeld(conversationId: string): boolean {
    const held = this.heldInput
    if (held?.conversationId !== conversationId) return false
    if (Date.now() - held.lastInputAt < HELD_INPUT_TIMEOUT_MS) return true
    this.heldInput = null
    return false
  }

  /**
   * The ambient re-pin refused while the reader held input, consuming it; null when none is owed.
   * The caller replays it through {@link reconcileLiveEdge}, which still requires follow to be armed
   * or geometry eligibility: the refused stimulus's own verdict, or the released position.
   */
  takeDeferredLiveEdge(conversationId: string): { rearmEligibleFromGeometry: boolean } | null {
    const deferred = this.deferredLiveEdge
    if (deferred?.conversationId !== conversationId) return null
    this.deferredLiveEdge = null
    if (this.model.currentConversationId !== conversationId) return null
    return { rearmEligibleFromGeometry: deferred.rearmEligibleFromGeometry }
  }

  private hasCurrentTargetTakeover(conversationId: string): boolean {
    return this.targetTakeover?.conversationId === conversationId &&
      this.model.currentConversationId === conversationId &&
      this.targetTakeover.generation === this.model.watermark
  }

  private canRearmAfterTargetTakeover(conversationId: string): boolean {
    return !this.hasCurrentTargetTakeover(conversationId) || this.targetTakeover!.direction >= 0
  }

  observeSettledUserGeometry(input: {
    conversationId: string
    /** The generation {@link observeUserInput} paused; null when it paused nothing. */
    generation: number | null
    atLiveEdge: boolean
  }): void {
    runScrollShadowSafely({
      event: 'settled-user-geometry',
      conversationId: input.conversationId,
      fallback: undefined,
      observe: () => {
        const atLiveEdge = input.atLiveEdge && !this.hasUnreadMarkerHold(input.conversationId) &&
          this.canRearmAfterTargetTakeover(input.conversationId)
        const rearmRequest: Extract<
          PositionRequest,
          { source: { kind: 'user-navigation'; reason: 'live-edge' } }
        > | undefined =
          atLiveEdge && (this.model.active === null ||
            this.model.active.request.source.kind === 'interaction' && this.model.active.request.source.reason === 'released')
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
          // 0 never matches a live request, so an input that paused nothing cannot resolve a
          // pause it did not create. The rearm path below does not consult this generation.
          input.generation ?? 0,
          atLiveEdge,
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
        if (this.model.currentConversationId === null) this.unreadMarkerHold = null
        this.cancelExecutionsIfSuperseded()
      },
    })
  }

  reassertUnreadMarker(conversationId: string): void {
    reassertUnreadMarker(this.runner, conversationId)
  }

  private currentDirectionalRun(conversationId: string, generation: number) {
    const run = this.runner.currentRun('directional-history', conversationId)
    return run !== null && run.request.generation === generation ? run : null
  }

  private cancelExecutionsIfSuperseded(): void {
    this.runner.cancelSuperseded()
  }
}
