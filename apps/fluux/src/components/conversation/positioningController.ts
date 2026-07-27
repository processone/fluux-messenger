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
  type DirectionalHistoryRequest,
  type EntryPositionFacts,
  type ExplicitTargetRequest,
  type LiveEdgeRequest,
  type LiveEdgeNavigationFacts,
  type MediaPreservationRequest,
  type PositionRequest,
  type PositioningModel,
  type PositioningPhase,
  type ReachabilityFacts,
  type SavedPositionRequest,
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

export interface PositionFrameLoop {
  schedule: (callback: () => void) => void
  recordFrame: (wrote: boolean) => void
  finish: () => void
}

export type SavedPositionFrameResult =
  | { kind: 'unavailable' }
  | {
      kind: 'positioned'
      scrollTop: number
      /** Whether measured geometry must be re-applied until it stabilises. */
      reassert: boolean
    }

export type SavedPositionCompletion =
  | 'applied'
  | 'settled'
  | 'best-effort'

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
  liveEdge: LiveEdgeExecutor
  beginLoop: (lease: SavedPositionExecutionLease) => PositionFrameLoop | null
  positionFrame: (
    request: SavedPositionRequest,
    lease: SavedPositionExecutionLease,
  ) => SavedPositionFrameResult
  complete: (
    request: SavedPositionRequest,
    outcome: SavedPositionCompletion,
  ) => void
}

export type UnreadMarkerFrameLoop = PositionFrameLoop

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
  liveEdge: LiveEdgeExecutor
}

export type LiveEdgeCompletion =
  | 'settled'
  | 'best-effort'
  | 'restarted'
  | 'user-takeover'
  | 'superseded'

export type LiveEdgeFrameResult =
  | { kind: 'unavailable' }
  | {
      kind: 'positioned'
      scrollTop: number
      atLiveEdge: boolean
      /** True when geometry required another bottom write/check this frame. */
      wrote: boolean
      /** Virtualized rows still need the bounded measurement-settle loop. */
      reassert: boolean
    }

export interface LiveEdgeExecutor {
  reachability: () => ReachabilityFacts
  /** Changes whenever another forward-window request may be issued safely. */
  recenterVersion?: string
  recenter?: (
    signal: AbortSignal,
  ) => 'requested' | 'waiting' | 'unavailable'
  beginLoop: (lease: PositionExecutionLease) => PositionFrameLoop | null
  positionFrame: (
    request: LiveEdgeRequest,
    lease: PositionExecutionLease,
  ) => LiveEdgeFrameResult
  complete: (
    request: LiveEdgeRequest,
    outcome: LiveEdgeCompletion,
  ) => void
}

export type MediaPreservationCompletion =
  | 'settled'
  | 'best-effort'
  | 'user-takeover'
  | 'superseded'

export type MediaPreservationFrameResult =
  | { kind: 'unavailable' }
  | {
      kind: 'positioned'
      scrollTop: number
      reassert: boolean
    }

export interface MediaPreservationExecutor {
  reachability: (
    desired: MediaPreservationRequest['desired'],
  ) => ReachabilityFacts
  beginLoop: (lease: PositionExecutionLease) => PositionFrameLoop | null
  positionFrame: (
    request: MediaPreservationRequest,
    lease: PositionExecutionLease,
  ) => MediaPreservationFrameResult
  complete: (
    request: MediaPreservationRequest,
    outcome: MediaPreservationCompletion,
  ) => void
}

export type DirectionalHistoryCompletion =
  | 'applied'
  | 'settled'
  | 'best-effort'
  | 'user-takeover'
  | 'superseded'
  | 'no-window-shift'

export type DirectionalHistoryFrameResult =
  | { kind: 'unavailable' }
  | {
      kind: 'positioned'
      scrollTop: number
      wrote: boolean
      /** False for a one-shot distance-from-bottom fallback or non-virtualized placement. */
      reassert: boolean
    }

export interface DirectionalHistoryExecutor {
  reachability: (
    desired: DirectionalHistoryRequest['desired'],
  ) => ReachabilityFacts
  beginLoop: (lease: PositionExecutionLease) => PositionFrameLoop | null
  positionFrame: (
    request: DirectionalHistoryRequest,
    lease: PositionExecutionLease,
  ) => DirectionalHistoryFrameResult
  complete: (
    request: DirectionalHistoryRequest,
    outcome: DirectionalHistoryCompletion,
  ) => void
}

export type ExplicitTargetCompletion =
  | 'settled'
  | 'best-effort'
  | 'user-takeover'

export type ExplicitTargetFrameResult =
  | { kind: 'waiting' }
  | { kind: 'unavailable' }
  | {
      kind: 'positioned'
      scrollTop: number
      wrote: boolean
    }

export interface ExplicitTargetExecutor {
  reachability: (
    desired: ExplicitTargetRequest['desired'],
    loadAround: SavedPositionLoadAroundStatus,
  ) => ReachabilityFacts
  loadAround?: (
    messageId: string,
    signal: AbortSignal,
  ) => Promise<unknown> | unknown
  beginLoop: (lease: PositionExecutionLease) => PositionFrameLoop | null
  readScrollTop: () => number | null
  positionFrame: (
    request: ExplicitTargetRequest,
    lease: PositionExecutionLease,
  ) => ExplicitTargetFrameResult
  complete: (
    request: ExplicitTargetRequest,
    outcome: ExplicitTargetCompletion,
    applied: boolean,
  ) => void
}

interface SavedPositionExecutionState {
  request: SavedPositionRequest
  executor: SavedPositionExecutor
  operation: number
  abortController: AbortController | null
  aroundAttempted: boolean
  loadingAround: boolean
  lastRecenterVersion: string | null
  loop: PositionFrameLoop | null
  framesLeft: number
  stableFrames: number
  landedTarget: number | null
}

interface UnreadMarkerExecutionState {
  request: UnreadMarkerRequest
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

interface ExplicitTargetExecutionState {
  request: ExplicitTargetRequest
  executor: ExplicitTargetExecutor
  operation: number
  abortController: AbortController | null
  aroundAttempted: boolean
  loadingAround: boolean
  loop: PositionFrameLoop | null
  framesLeft: number
  stableFrames: number
  landedTarget: number | null
  applied: boolean
}

interface LiveEdgeExecutionState {
  request: LiveEdgeRequest
  executor: LiveEdgeExecutor
  operation: number
  abortController: AbortController | null
  lastRecenterVersion: string | null
  loop: PositionFrameLoop | null
  framesLeft: number
  stableFrames: number
  completed: boolean
}

interface MediaPreservationExecutionState {
  request: MediaPreservationRequest
  executor: MediaPreservationExecutor
  operation: number
  abortController: AbortController | null
  loop: PositionFrameLoop | null
  framesLeft: number
  stableFrames: number
  landedTarget: number | null
}

interface DirectionalHistoryExecutionState {
  request: DirectionalHistoryRequest
  executor: DirectionalHistoryExecutor
  operation: number
  abortController: AbortController | null
  loop: PositionFrameLoop | null
  framesLeft: number
  applied: boolean
}

const EXPLICIT_TARGET_REASSERT_FRAMES = 30
const EXPLICIT_TARGET_STABLE_FRAMES = 4
const EXPLICIT_TARGET_DRIFT_PX = 16
const EXPLICIT_TARGET_TAKEOVER_DRIFT_PX = 300
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
const MEDIA_PRESERVATION_REASSERT_FRAMES = 90
const MEDIA_PRESERVATION_STABLE_FRAMES = 8
const MEDIA_PRESERVATION_DRIFT_PX = 8
// Preserved from the former hook-local prepend/window-shift loop. It intentionally has no
// early-stable exit because virtualizer measurements can arrive late after several quiet frames.
const DIRECTIONAL_HISTORY_REASSERT_FRAMES = 60

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
  private explicitTargetExecution: ExplicitTargetExecutionState | null = null
  private liveEdgeExecution: LiveEdgeExecutionState | null = null
  private mediaPreservationExecution: MediaPreservationExecutionState | null = null
  private directionalHistoryExecution: DirectionalHistoryExecutionState | null = null

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
    this.cancelAllExecutions('superseded')
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
      loop: null,
      framesLeft: SAVED_POSITION_REASSERT_FRAMES,
      stableFrames: 0,
      landedTarget: null,
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
        return this.acceptLiveEdgeRequest(
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
        return this.acceptLiveEdgeRequest(
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

  beginLiveEdgeRequest(input: {
    conversationId: string
    source: LiveEdgeRequest['source']
    executor: LiveEdgeExecutor
  }): LiveEdgeRequest | null {
    return runScrollShadowSafely({
      event: 'live-edge-request',
      conversationId: input.conversationId,
      fallback: null,
      observe: () => this.acceptLiveEdgeRequest(
        input.conversationId,
        input.source,
        input.executor,
      ),
    })
  }

  /**
   * Re-open bottom reconciliation for appended or remeasured content without minting a competing
   * request. The current live-edge generation remains the sole follow-live owner.
   */
  reconcileLiveEdge(input: {
    conversationId: string
    executor: LiveEdgeExecutor
  }): boolean {
    return runScrollShadowSafely({
      event: 'live-edge-reconcile',
      conversationId: input.conversationId,
      fallback: false,
      observe: () => {
        if (!shouldReconcileAfterAppend(this.model, input.conversationId)) {
          return false
        }
        const active = this.model.active
        if (!active || active.request.desired.kind !== 'live-edge') return false
        let execution = this.liveEdgeExecution
        if (
          !execution ||
          execution.request !== active.request ||
          !this.isLiveEdgeExecutionCurrent(execution)
        ) {
          this.cancelLiveEdgeExecution('superseded')
          execution = this.createLiveEdgeExecution(
            active.request as LiveEdgeRequest,
            input.executor,
          )
          this.liveEdgeExecution = execution
        } else {
          this.finishLiveEdgeLoop(execution)
          execution.abortController?.abort()
          this.completeLiveEdge(execution, 'restarted')
          execution.executor = input.executor
          execution.operation += 1
          execution.abortController = null
          execution.lastRecenterVersion = null
          execution.framesLeft = LIVE_EDGE_REASSERT_FRAMES
          execution.stableFrames = 0
          execution.completed = false
        }
        this.driveLiveEdge(execution)
        return true
      },
    })
  }

  refreshLiveEdge(input: {
    conversationId: string
    executor: LiveEdgeExecutor
  }): boolean {
    const execution = this.liveEdgeExecution
    if (
      !execution ||
      execution.request.conversationId !== input.conversationId ||
      !this.isLiveEdgeExecutionCurrent(execution)
    ) {
      return false
    }
    if (!execution.loop) {
      execution.executor = input.executor
      const phase = this.model.active?.phase.kind
      if (
        phase === 'resolving' ||
        phase === 'pending' ||
        phase === 'recentering-live-edge' ||
        phase === 'mounting' ||
        phase === 'reconciling' ||
        phase === 'unavailable'
      ) {
        this.driveLiveEdge(execution)
      }
    }
    return true
  }

  beginMediaPreservation(input: {
    conversationId: string
    desired: MediaPreservationRequest['desired']
    executor: MediaPreservationExecutor
  }): MediaPreservationRequest | null {
    return runScrollShadowSafely({
      event: 'media-preservation-begin',
      conversationId: input.conversationId,
      fallback: null,
      observe: () => {
        const generation = mintPositionGeneration()
        const request = withIdentity(
          input.conversationId,
          generation,
          {
            source: { kind: 'media-preservation', reason: 'remeasure' },
            desired: input.desired,
            onUnavailable: { kind: 'warn-and-stop' },
          },
        ) as MediaPreservationRequest
        const reachability = runScrollShadowSafely<ReachabilityFacts | null>({
          event: 'media-preservation-reachability',
          conversationId: input.conversationId,
          fallback: null,
          observe: () => input.executor.reachability(request.desired),
        })
        if (!reachability) return null
        if (!reachabilityMatchesRequest(request, reachability)) return null
        const accepted = acceptPositionRequest(this.model, request)
        if (accepted === this.model) return null

        this.cancelAllExecutions('superseded')
        this.model = advancePhaseIfCurrent(
          accepted,
          input.conversationId,
          generation,
          resolveReachability(request, reachability),
        )
        const execution: MediaPreservationExecutionState = {
          request,
          executor: input.executor,
          operation: 0,
          abortController: null,
          loop: null,
          framesLeft: MEDIA_PRESERVATION_REASSERT_FRAMES,
          stableFrames: 0,
          landedTarget: null,
        }
        this.mediaPreservationExecution = execution
        this.driveMediaPreservation(execution)
        return request
      },
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
      observe: () => {
        const generation = mintPositionGeneration()
        const request = withIdentity(
          input.conversationId,
          generation,
          {
            source: { kind: 'history-preservation', reason: 'window-shift' },
            desired: input.desired,
            onUnavailable: {
              kind: 'distance-from-bottom',
              distancePx: input.distanceFromBottom,
            },
          },
        ) as DirectionalHistoryRequest
        const accepted = acceptPositionRequest(this.model, request)
        if (accepted === this.model) return null

        this.cancelAllExecutions('superseded')
        this.model = advancePhaseIfCurrent(
          accepted,
          input.conversationId,
          generation,
          { kind: 'pending', reason: 'window-shift' },
        )
        this.directionalHistoryExecution = {
          request,
          executor: input.executor,
          operation: 0,
          abortController: null,
          loop: null,
          framesLeft: DIRECTIONAL_HISTORY_REASSERT_FRAMES,
          applied: false,
        }
        return request
      },
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
        const execution = this.directionalHistoryExecution
        if (
          !execution ||
          execution.request.conversationId !== input.conversationId ||
          execution.request.generation !== input.generation ||
          !this.isDirectionalHistoryExecutionCurrent(execution)
        ) {
          return false
        }
        execution.executor = input.executor
        const reachability = execution.executor.reachability(
          execution.request.desired,
        )
        if (!reachabilityMatchesRequest(execution.request, reachability)) {
          this.cancelDirectionalHistoryExecution('superseded')
          return false
        }
        const phase = resolveReachability(execution.request, reachability)
        this.model = advancePhaseIfCurrent(
          this.model,
          input.conversationId,
          input.generation,
          phase,
        )
        if (
          phase.kind !== 'mounting' &&
          phase.kind !== 'reconciling' &&
          phase.kind !== 'unavailable'
        ) {
          return false
        }
        this.startDirectionalHistoryLoop(execution)
        return execution.applied
      },
    })
  }

  cancelDirectionalHistoryWithoutShift(input: {
    conversationId: string
    generation: number
  }): boolean {
    const execution = this.directionalHistoryExecution
    if (
      !execution ||
      execution.request.conversationId !== input.conversationId ||
      execution.request.generation !== input.generation ||
      !this.isDirectionalHistoryExecutionCurrent(execution)
    ) {
      return false
    }
    this.cancelDirectionalHistoryExecution('no-window-shift')
    if (
      this.model.active?.request.conversationId === input.conversationId &&
      this.model.active.request.generation === input.generation
    ) {
      this.model = { ...this.model, active: null }
    }
    return true
  }

  isDirectionalHistoryPending(conversationId: string): boolean {
    const execution = this.directionalHistoryExecution
    return Boolean(
      execution &&
      execution.request.conversationId === conversationId &&
      this.isDirectionalHistoryExecutionCurrent(execution) &&
      !execution.applied,
    )
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

  beginExplicitTarget(input: {
    conversationId: string
    messageId: string
    executor: ExplicitTargetExecutor
  }): ExplicitTargetRequest | null {
    return runScrollShadowSafely({
      event: 'explicit-target-begin',
      conversationId: input.conversationId,
      fallback: null,
      observe: () => {
        const current = this.explicitTargetExecution
        if (
          current &&
          this.isExplicitTargetExecutionCurrent(current) &&
          current.request.conversationId === input.conversationId &&
          current.request.desired.messageId === input.messageId
        ) {
          current.executor = input.executor
          this.driveExplicitTarget(current)
          return current.request
        }

        const generation = mintPositionGeneration()
        const request = withIdentity(
          input.conversationId,
          generation,
          {
            source: { kind: 'user-navigation', reason: 'message-target' },
            desired: {
              kind: 'message',
              messageId: input.messageId,
              align: 'center',
            },
            onUnavailable: { kind: 'wait' },
          },
        ) as ExplicitTargetRequest
        const reachability = input.executor.reachability(
          request.desired,
          input.executor.loadAround ? 'available' : 'unavailable',
        )
        if (!reachabilityMatchesRequest(request, reachability)) return null

        const accepted = acceptPositionRequest(this.model, request)
        if (accepted === this.model) return null
        this.cancelAllExecutions('superseded')
        this.model = advancePhaseIfCurrent(
          accepted,
          input.conversationId,
          generation,
          resolveReachability(request, reachability),
        )
        const execution: ExplicitTargetExecutionState = {
          request,
          executor: input.executor,
          operation: 0,
          abortController: null,
          aroundAttempted: false,
          loadingAround: false,
          loop: null,
          framesLeft: EXPLICIT_TARGET_REASSERT_FRAMES,
          stableFrames: 0,
          landedTarget: null,
          applied: false,
        }
        this.explicitTargetExecution = execution
        this.driveExplicitTarget(execution)
        return request
      },
    })
  }

  refreshExplicitTarget(input: {
    conversationId: string
    generation: number
    executor: ExplicitTargetExecutor
  }): boolean {
    const execution = this.explicitTargetExecution
    if (
      !execution ||
      execution.request.conversationId !== input.conversationId ||
      execution.request.generation !== input.generation ||
      !this.isExplicitTargetExecutionCurrent(execution)
    ) {
      return false
    }
    execution.executor = input.executor
    this.driveExplicitTarget(execution)
    return true
  }

  cancelExplicitTarget(conversationId: string, generation: number): boolean {
    const execution = this.explicitTargetExecution
    if (
      !execution ||
      execution.request.conversationId !== conversationId ||
      execution.request.generation !== generation ||
      !this.isExplicitTargetExecutionCurrent(execution)
    ) {
      return false
    }
    this.model = advancePhaseIfCurrent(
      this.model,
      conversationId,
      generation,
      { kind: 'settled' },
    )
    this.cancelExplicitTargetExecution()
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
        const targetExecution = this.explicitTargetExecution
        const targetWasCurrent =
          targetExecution !== null &&
          targetExecution.request.conversationId === conversationId &&
          this.isExplicitTargetExecutionCurrent(targetExecution)
        const liveEdgeExecution = this.liveEdgeExecution
        const liveEdgeWasCurrent =
          liveEdgeExecution !== null &&
          liveEdgeExecution.request.conversationId === conversationId &&
          this.isLiveEdgeExecutionCurrent(liveEdgeExecution)
        const mediaExecution = this.mediaPreservationExecution
        const mediaWasCurrent =
          mediaExecution !== null &&
          mediaExecution.request.conversationId === conversationId &&
          this.isMediaPreservationExecutionCurrent(mediaExecution)
        const directionalExecution = this.directionalHistoryExecution
        const directionalWasCurrent =
          directionalExecution !== null &&
          directionalExecution.request.conversationId === conversationId &&
          this.isDirectionalHistoryExecutionCurrent(directionalExecution)
        // A boundary wheel can start a directional load and be followed by more wheel events while
        // the network request is still pending. The former prepend loop armed user takeover only
        // after the batch landed and reconciliation began, so those pre-load events could not
        // discard the saved anchor. Preserve that contract: there is no pixel owner to take over
        // until the synchronous initial write has run. Explicit competing position requests still
        // supersede this pending generation through normal request arbitration.
        if (directionalWasCurrent && directionalExecution && !directionalExecution.applied) {
          return
        }
        this.model = cancelReconciliationForUserInput(
          this.model,
          conversationId,
          generation,
        )
        if (targetWasCurrent && targetExecution) {
          this.finishExplicitTargetExecution(
            targetExecution,
            false,
            'user-takeover',
          )
        }
        if (liveEdgeWasCurrent) {
          this.cancelLiveEdgeExecution('user-takeover')
        }
        if (mediaWasCurrent) {
          this.cancelMediaPreservationExecution('user-takeover')
        }
        if (directionalWasCurrent) {
          this.cancelDirectionalHistoryExecution('user-takeover')
        }
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
    this.cancelAllExecutions('superseded')
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

  private acceptLiveEdgeRequest(
    conversationId: string,
    source: LiveEdgeRequest['source'],
    executor: LiveEdgeExecutor,
  ): LiveEdgeRequest | null {
    const generation = mintPositionGeneration()
    const request = {
      generation,
      conversationId,
      source,
      desired: { kind: 'live-edge', follow: true },
    } as LiveEdgeRequest
    const reachability = runScrollShadowSafely<ReachabilityFacts | null>({
      event: 'live-edge-reachability',
      conversationId,
      fallback: null,
      observe: () => executor.reachability(),
    })
    if (!reachability || !reachabilityMatchesRequest(request, reachability)) {
      return null
    }
    const accepted = acceptPositionRequest(this.model, request)
    if (accepted === this.model) return null

    this.cancelAllExecutions('superseded')
    this.model = advancePhaseIfCurrent(
      accepted,
      conversationId,
      generation,
      resolveReachability(request, reachability),
    )
    const execution = this.createLiveEdgeExecution(request, executor)
    this.liveEdgeExecution = execution
    this.driveLiveEdge(execution)
    return request
  }

  private createLiveEdgeExecution(
    request: LiveEdgeRequest,
    executor: LiveEdgeExecutor,
  ): LiveEdgeExecutionState {
    return {
      request,
      executor,
      operation: 0,
      abortController: null,
      lastRecenterVersion: null,
      loop: null,
      framesLeft: LIVE_EDGE_REASSERT_FRAMES,
      stableFrames: 0,
      completed: false,
    }
  }

  private driveLiveEdge(execution: LiveEdgeExecutionState): void {
    if (!this.isLiveEdgeExecutionCurrent(execution)) return
    if (execution.loop) return

    const reachability = runScrollShadowSafely<ReachabilityFacts | null>({
      event: 'live-edge-drive-reachability',
      conversationId: execution.request.conversationId,
      fallback: null,
      observe: () => execution.executor.reachability(),
    })
    if (
      !reachability ||
      !reachabilityMatchesRequest(execution.request, reachability)
    ) {
      this.settleLiveEdgeBestEffort(execution)
      return
    }
    const phase = resolveReachability(execution.request, reachability)
    this.model = advancePhaseIfCurrent(
      this.model,
      execution.request.conversationId,
      execution.request.generation,
      phase,
    )
    if (!this.isLiveEdgeExecutionCurrent(execution)) return

    switch (phase.kind) {
      case 'recentering-live-edge':
        this.recenterLiveEdge(execution)
        return
      case 'mounting':
      case 'reconciling':
        this.startLiveEdgeLoop(execution)
        return
      case 'unavailable':
        // Preserve the legacy best-resident-edge fallback when the sliding window cannot recenter.
        this.startLiveEdgeLoop(execution)
        return
      case 'resolving':
      case 'pending':
      case 'loading-around':
      case 'position-applied':
      case 'settled':
      case 'paused-user-input':
        return
    }
  }

  private recenterLiveEdge(execution: LiveEdgeExecutionState): void {
    const recenter = execution.executor.recenter
    const version = execution.executor.recenterVersion
    if (!recenter || !version) {
      this.startLiveEdgeLoop(execution)
      return
    }
    if (execution.lastRecenterVersion === version) return
    execution.lastRecenterVersion = version
    const lease = this.beginLiveEdgeOperation(execution)
    const result = runScrollShadowSafely({
      event: 'live-edge-recenter',
      conversationId: execution.request.conversationId,
      fallback: 'unavailable' as const,
      observe: () => recenter(lease.signal),
    })
    if (!lease.isCurrent()) return
    if (result === 'unavailable') this.startLiveEdgeLoop(execution)
  }

  private startLiveEdgeLoop(execution: LiveEdgeExecutionState): void {
    if (!this.isLiveEdgeExecutionCurrent(execution) || execution.loop) return
    execution.framesLeft = LIVE_EDGE_REASSERT_FRAMES
    execution.stableFrames = 0
    execution.completed = false
    const lease = this.beginLiveEdgeOperation(execution)

    // Preserve the immediate write used by entry, FAB, outgoing send, and layout stimuli. Only
    // virtualized measurement settling moves to scheduled controller frames.
    const initial = this.positionLiveEdgeFrame(execution, lease)
    if (!lease.isCurrent()) return
    if (initial.kind === 'unavailable') {
      this.settleLiveEdgeBestEffort(execution, lease)
      return
    }
    lease.markApplied()
    if (!lease.isCurrent()) return
    if (!initial.reassert) {
      this.settleLiveEdge(execution, lease, 'settled')
      return
    }

    const loop = runScrollShadowSafely<PositionFrameLoop | null>({
      event: 'live-edge-loop-start',
      conversationId: execution.request.conversationId,
      fallback: null,
      observe: () => execution.executor.beginLoop(lease),
    })
    if (!lease.isCurrent()) {
      loop?.finish()
      return
    }
    if (!loop) {
      this.settleLiveEdge(execution, lease, 'best-effort')
      return
    }
    execution.loop = loop
    this.scheduleLiveEdgeFrame(execution, lease)
  }

  private driveLiveEdgeFrame(
    execution: LiveEdgeExecutionState,
    lease: PositionExecutionLease,
  ): void {
    if (!lease.isCurrent()) return
    if (execution.framesLeft-- <= 0) {
      this.settleLiveEdge(execution, lease, 'best-effort')
      return
    }
    const result = this.positionLiveEdgeFrame(execution, lease)
    if (!lease.isCurrent()) return
    if (result.kind === 'unavailable') {
      this.settleLiveEdge(execution, lease, 'best-effort')
      return
    }
    if (!result.reassert) {
      this.recordLiveEdgeFrame(execution, result.wrote)
      this.settleLiveEdge(execution, lease, 'settled')
      return
    }

    execution.stableFrames = result.wrote
      ? 0
      : execution.stableFrames + 1
    this.recordLiveEdgeFrame(execution, result.wrote)
    if (execution.stableFrames >= LIVE_EDGE_STABLE_FRAMES) {
      this.settleLiveEdge(execution, lease, 'settled')
      return
    }
    this.scheduleLiveEdgeFrame(execution, lease)
  }

  private positionLiveEdgeFrame(
    execution: LiveEdgeExecutionState,
    lease: PositionExecutionLease,
  ): LiveEdgeFrameResult {
    return runScrollShadowSafely<LiveEdgeFrameResult>({
      event: 'live-edge-frame',
      conversationId: execution.request.conversationId,
      fallback: { kind: 'unavailable' },
      observe: () => execution.executor.positionFrame(
        execution.request,
        lease,
      ),
    })
  }

  private scheduleLiveEdgeFrame(
    execution: LiveEdgeExecutionState,
    lease: PositionExecutionLease,
  ): void {
    if (!lease.isCurrent() || !execution.loop) return
    const scheduled = runScrollShadowSafely({
      event: 'live-edge-frame-schedule',
      conversationId: execution.request.conversationId,
      fallback: false,
      observe: () => {
        execution.loop?.schedule(
          () => this.driveLiveEdgeFrame(execution, lease),
        )
        return true
      },
    })
    if (!scheduled && lease.isCurrent()) {
      this.settleLiveEdge(execution, lease, 'best-effort')
    }
  }

  private recordLiveEdgeFrame(
    execution: LiveEdgeExecutionState,
    wrote: boolean,
  ): void {
    runScrollShadowSafely({
      event: 'live-edge-frame-monitor',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => execution.loop?.recordFrame(wrote),
    })
  }

  private settleLiveEdgeBestEffort(
    execution: LiveEdgeExecutionState,
    existingLease?: PositionExecutionLease,
  ): void {
    if (!this.isLiveEdgeExecutionCurrent(execution)) return
    const lease = existingLease ?? this.beginLiveEdgeOperation(execution)
    this.settleLiveEdge(execution, lease, 'best-effort')
  }

  private settleLiveEdge(
    execution: LiveEdgeExecutionState,
    lease: PositionExecutionLease,
    outcome: Extract<LiveEdgeCompletion, 'settled' | 'best-effort'>,
  ): void {
    if (!lease.isCurrent()) return
    this.finishLiveEdgeLoop(execution)
    this.completeLiveEdge(execution, outcome)
    lease.settle()
  }

  private completeLiveEdge(
    execution: LiveEdgeExecutionState,
    outcome: LiveEdgeCompletion,
  ): void {
    if (execution.completed) return
    execution.completed = true
    runScrollShadowSafely({
      event: 'live-edge-complete',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => execution.executor.complete(
        execution.request,
        outcome,
      ),
    })
  }

  private finishLiveEdgeLoop(execution: LiveEdgeExecutionState): void {
    const loop = execution.loop
    execution.loop = null
    if (!loop) return
    runScrollShadowSafely({
      event: 'live-edge-loop-finish',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => loop.finish(),
    })
  }

  private beginLiveEdgeOperation(
    execution: LiveEdgeExecutionState,
  ): PositionExecutionLease {
    execution.abortController?.abort()
    const abortController = new AbortController()
    execution.abortController = abortController
    const operation = ++execution.operation
    const { conversationId, generation } = execution.request
    const isCurrent = () =>
      !abortController.signal.aborted &&
      this.liveEdgeExecution === execution &&
      execution.operation === operation &&
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

  private isLiveEdgeExecutionCurrent(
    execution: LiveEdgeExecutionState,
  ): boolean {
    return (
      this.liveEdgeExecution === execution &&
      isCurrentGeneration(
        this.model,
        execution.request.conversationId,
        execution.request.generation,
      )
    )
  }

  private driveMediaPreservation(
    execution: MediaPreservationExecutionState,
  ): void {
    if (!this.isMediaPreservationExecutionCurrent(execution)) return
    const phase = this.model.active?.phase
    if (!phase) return
    if (phase.kind === 'mounting' || phase.kind === 'reconciling') {
      this.startMediaPreservationLoop(execution)
      return
    }
    if (
      phase.kind === 'unavailable' ||
      phase.kind === 'pending'
    ) {
      const lease = this.beginMediaPreservationOperation(execution)
      this.settleMediaPreservation(execution, lease, 'best-effort')
    }
  }

  private startMediaPreservationLoop(
    execution: MediaPreservationExecutionState,
  ): void {
    if (
      !this.isMediaPreservationExecutionCurrent(execution) ||
      execution.loop
    ) {
      return
    }
    execution.framesLeft = MEDIA_PRESERVATION_REASSERT_FRAMES
    execution.stableFrames = 0
    execution.landedTarget = null
    const lease = this.beginMediaPreservationOperation(execution)
    const initial = this.positionMediaPreservationFrame(execution, lease)
    if (!lease.isCurrent()) return
    if (initial.kind === 'unavailable') {
      this.settleMediaPreservation(execution, lease, 'best-effort')
      return
    }
    lease.markApplied()
    if (!lease.isCurrent()) return
    if (!initial.reassert) {
      this.settleMediaPreservation(execution, lease, 'settled')
      return
    }
    const loop = runScrollShadowSafely<PositionFrameLoop | null>({
      event: 'media-preservation-loop-start',
      conversationId: execution.request.conversationId,
      fallback: null,
      observe: () => execution.executor.beginLoop(lease),
    })
    if (!lease.isCurrent()) {
      loop?.finish()
      return
    }
    if (!loop) {
      this.settleMediaPreservation(execution, lease, 'best-effort')
      return
    }
    execution.loop = loop
    this.scheduleMediaPreservationFrame(execution, lease)
  }

  private driveMediaPreservationFrame(
    execution: MediaPreservationExecutionState,
    lease: PositionExecutionLease,
  ): void {
    if (!lease.isCurrent()) return
    if (execution.framesLeft-- <= 0) {
      this.settleMediaPreservation(execution, lease, 'best-effort')
      return
    }
    const result = this.positionMediaPreservationFrame(execution, lease)
    if (!lease.isCurrent()) return
    if (result.kind === 'unavailable') {
      this.settleMediaPreservation(execution, lease, 'best-effort')
      return
    }
    if (!result.reassert) {
      this.settleMediaPreservation(execution, lease, 'settled')
      return
    }
    let wrote = false
    if (
      execution.landedTarget !== null &&
      Math.abs(result.scrollTop - execution.landedTarget) <=
        MEDIA_PRESERVATION_DRIFT_PX
    ) {
      execution.stableFrames += 1
    } else {
      wrote = true
      execution.stableFrames = 0
    }
    execution.landedTarget = result.scrollTop
    this.recordMediaPreservationFrame(execution, wrote)
    if (
      execution.stableFrames >= MEDIA_PRESERVATION_STABLE_FRAMES
    ) {
      this.settleMediaPreservation(execution, lease, 'settled')
      return
    }
    this.scheduleMediaPreservationFrame(execution, lease)
  }

  private positionMediaPreservationFrame(
    execution: MediaPreservationExecutionState,
    lease: PositionExecutionLease,
  ): MediaPreservationFrameResult {
    return runScrollShadowSafely<MediaPreservationFrameResult>({
      event: 'media-preservation-frame',
      conversationId: execution.request.conversationId,
      fallback: { kind: 'unavailable' },
      observe: () => execution.executor.positionFrame(
        execution.request,
        lease,
      ),
    })
  }

  private scheduleMediaPreservationFrame(
    execution: MediaPreservationExecutionState,
    lease: PositionExecutionLease,
  ): void {
    if (!lease.isCurrent() || !execution.loop) return
    const scheduled = runScrollShadowSafely({
      event: 'media-preservation-frame-schedule',
      conversationId: execution.request.conversationId,
      fallback: false,
      observe: () => {
        execution.loop?.schedule(
          () => this.driveMediaPreservationFrame(execution, lease),
        )
        return true
      },
    })
    if (!scheduled && lease.isCurrent()) {
      this.settleMediaPreservation(execution, lease, 'best-effort')
    }
  }

  private recordMediaPreservationFrame(
    execution: MediaPreservationExecutionState,
    wrote: boolean,
  ): void {
    runScrollShadowSafely({
      event: 'media-preservation-frame-monitor',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => execution.loop?.recordFrame(wrote),
    })
  }

  private settleMediaPreservation(
    execution: MediaPreservationExecutionState,
    lease: PositionExecutionLease,
    outcome: Extract<
      MediaPreservationCompletion,
      'settled' | 'best-effort'
    >,
  ): void {
    if (!lease.isCurrent()) return
    this.finishMediaPreservationLoop(execution)
    this.completeMediaPreservation(execution, outcome)
    lease.settle()
    execution.abortController?.abort()
    if (this.mediaPreservationExecution === execution) {
      this.mediaPreservationExecution = null
    }
  }

  private completeMediaPreservation(
    execution: MediaPreservationExecutionState,
    outcome: MediaPreservationCompletion,
  ): void {
    runScrollShadowSafely({
      event: 'media-preservation-complete',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => execution.executor.complete(
        execution.request,
        outcome,
      ),
    })
  }

  private finishMediaPreservationLoop(
    execution: MediaPreservationExecutionState,
  ): void {
    const loop = execution.loop
    execution.loop = null
    if (!loop) return
    runScrollShadowSafely({
      event: 'media-preservation-loop-finish',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => loop.finish(),
    })
  }

  private beginMediaPreservationOperation(
    execution: MediaPreservationExecutionState,
  ): PositionExecutionLease {
    execution.abortController?.abort()
    const abortController = new AbortController()
    execution.abortController = abortController
    const operation = ++execution.operation
    const { conversationId, generation } = execution.request
    const isCurrent = () =>
      !abortController.signal.aborted &&
      this.mediaPreservationExecution === execution &&
      execution.operation === operation &&
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

  private isMediaPreservationExecutionCurrent(
    execution: MediaPreservationExecutionState,
  ): boolean {
    return (
      this.mediaPreservationExecution === execution &&
      isCurrentGeneration(
        this.model,
        execution.request.conversationId,
        execution.request.generation,
      )
    )
  }

  private startDirectionalHistoryLoop(
    execution: DirectionalHistoryExecutionState,
  ): void {
    if (
      !this.isDirectionalHistoryExecutionCurrent(execution) ||
      execution.loop ||
      execution.applied
    ) {
      return
    }
    execution.framesLeft = DIRECTIONAL_HISTORY_REASSERT_FRAMES
    const lease = this.beginDirectionalHistoryOperation(execution)
    const initial = this.positionDirectionalHistoryFrame(execution, lease)
    if (!lease.isCurrent()) return
    if (initial.kind === 'unavailable') {
      this.settleDirectionalHistory(execution, lease, 'best-effort')
      return
    }

    execution.applied = true
    lease.markApplied()
    if (!lease.isCurrent()) return
    this.completeDirectionalHistory(execution, 'applied')
    if (!initial.reassert) {
      this.settleDirectionalHistory(execution, lease, 'settled')
      return
    }

    const loop = runScrollShadowSafely<PositionFrameLoop | null>({
      event: 'directional-history-loop-start',
      conversationId: execution.request.conversationId,
      fallback: null,
      observe: () => execution.executor.beginLoop(lease),
    })
    if (!lease.isCurrent()) {
      loop?.finish()
      return
    }
    if (!loop) {
      this.settleDirectionalHistory(execution, lease, 'best-effort')
      return
    }
    execution.loop = loop
    this.scheduleDirectionalHistoryFrame(execution, lease)
  }

  private driveDirectionalHistoryFrame(
    execution: DirectionalHistoryExecutionState,
    lease: PositionExecutionLease,
  ): void {
    if (!lease.isCurrent()) return
    if (execution.framesLeft-- <= 0) {
      this.settleDirectionalHistory(execution, lease, 'best-effort')
      return
    }
    const result = this.positionDirectionalHistoryFrame(execution, lease)
    if (!lease.isCurrent()) return
    if (result.kind === 'unavailable') {
      this.settleDirectionalHistory(execution, lease, 'best-effort')
      return
    }
    this.recordDirectionalHistoryFrame(execution, result.wrote)
    if (!result.reassert) {
      this.settleDirectionalHistory(execution, lease, 'settled')
      return
    }
    this.scheduleDirectionalHistoryFrame(execution, lease)
  }

  private positionDirectionalHistoryFrame(
    execution: DirectionalHistoryExecutionState,
    lease: PositionExecutionLease,
  ): DirectionalHistoryFrameResult {
    return runScrollShadowSafely<DirectionalHistoryFrameResult>({
      event: 'directional-history-frame',
      conversationId: execution.request.conversationId,
      fallback: { kind: 'unavailable' },
      observe: () => execution.executor.positionFrame(
        execution.request,
        lease,
      ),
    })
  }

  private scheduleDirectionalHistoryFrame(
    execution: DirectionalHistoryExecutionState,
    lease: PositionExecutionLease,
  ): void {
    if (!lease.isCurrent() || !execution.loop) return
    const scheduled = runScrollShadowSafely({
      event: 'directional-history-frame-schedule',
      conversationId: execution.request.conversationId,
      fallback: false,
      observe: () => {
        execution.loop?.schedule(
          () => this.driveDirectionalHistoryFrame(execution, lease),
        )
        return true
      },
    })
    if (!scheduled && lease.isCurrent()) {
      this.settleDirectionalHistory(execution, lease, 'best-effort')
    }
  }

  private recordDirectionalHistoryFrame(
    execution: DirectionalHistoryExecutionState,
    wrote: boolean,
  ): void {
    runScrollShadowSafely({
      event: 'directional-history-frame-monitor',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => execution.loop?.recordFrame(wrote),
    })
  }

  private settleDirectionalHistory(
    execution: DirectionalHistoryExecutionState,
    lease: PositionExecutionLease,
    outcome: Extract<
      DirectionalHistoryCompletion,
      'settled' | 'best-effort'
    >,
  ): void {
    if (!lease.isCurrent()) return
    this.finishDirectionalHistoryLoop(execution)
    this.completeDirectionalHistory(execution, outcome)
    lease.settle()
    execution.abortController?.abort()
    if (this.directionalHistoryExecution === execution) {
      this.directionalHistoryExecution = null
    }
  }

  private completeDirectionalHistory(
    execution: DirectionalHistoryExecutionState,
    outcome: DirectionalHistoryCompletion,
  ): void {
    runScrollShadowSafely({
      event: 'directional-history-complete',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => execution.executor.complete(
        execution.request,
        outcome,
      ),
    })
  }

  private finishDirectionalHistoryLoop(
    execution: DirectionalHistoryExecutionState,
  ): void {
    const loop = execution.loop
    execution.loop = null
    if (!loop) return
    runScrollShadowSafely({
      event: 'directional-history-loop-finish',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => loop.finish(),
    })
  }

  private beginDirectionalHistoryOperation(
    execution: DirectionalHistoryExecutionState,
  ): PositionExecutionLease {
    execution.abortController?.abort()
    const abortController = new AbortController()
    execution.abortController = abortController
    const operation = ++execution.operation
    const { conversationId, generation } = execution.request
    const isCurrent = () =>
      !abortController.signal.aborted &&
      this.directionalHistoryExecution === execution &&
      execution.operation === operation &&
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

  private isDirectionalHistoryExecutionCurrent(
    execution: DirectionalHistoryExecutionState,
  ): boolean {
    return (
      this.directionalHistoryExecution === execution &&
      isCurrentGeneration(
        this.model,
        execution.request.conversationId,
        execution.request.generation,
      )
    )
  }

  private driveExplicitTarget(
    execution: ExplicitTargetExecutionState,
  ): void {
    if (
      !this.isExplicitTargetExecutionCurrent(execution) ||
      execution.loop
    ) {
      return
    }

    const loadAround: SavedPositionLoadAroundStatus = execution.loadingAround
      ? 'loading'
      : execution.aroundAttempted
        ? 'exhausted'
        : execution.executor.loadAround
          ? 'available'
          : 'unavailable'
    const reachability = runScrollShadowSafely<ReachabilityFacts | null>({
      event: 'explicit-target-reachability',
      conversationId: execution.request.conversationId,
      fallback: null,
      observe: () => execution.executor.reachability(
        execution.request.desired,
        loadAround,
      ),
    })
    if (!reachability) return

    const phase = resolveReachability(execution.request, reachability)
    this.model = advancePhaseIfCurrent(
      this.model,
      execution.request.conversationId,
      execution.request.generation,
      phase,
    )
    if (!this.isExplicitTargetExecutionCurrent(execution)) return

    switch (phase.kind) {
      case 'loading-around':
        this.startExplicitTargetAroundLoad(execution, phase.messageId)
        return
      case 'mounting':
      case 'reconciling':
        execution.loadingAround = false
        this.startExplicitTargetLoop(execution)
        return
      case 'unavailable':
        // Explicit navigation has `onUnavailable: wait`; retain the request so a later resident
        // window refresh can make it reachable.
        this.model = advancePhaseIfCurrent(
          this.model,
          execution.request.conversationId,
          execution.request.generation,
          { kind: 'pending', reason: 'target-not-indexed' },
        )
        return
      case 'resolving':
      case 'pending':
      case 'recentering-live-edge':
      case 'position-applied':
      case 'settled':
      case 'paused-user-input':
        return
    }
  }

  private startExplicitTargetAroundLoad(
    execution: ExplicitTargetExecutionState,
    messageId: string,
  ): void {
    if (execution.loadingAround || execution.aroundAttempted) return
    execution.aroundAttempted = true
    execution.loadingAround = true
    const lease = this.beginExplicitTargetOperation(execution)
    const load = execution.executor.loadAround
      ? runScrollShadowSafely<Promise<unknown> | unknown | null>({
          event: 'explicit-target-load-around',
          conversationId: execution.request.conversationId,
          fallback: null,
          observe: () =>
            execution.executor.loadAround?.(messageId, lease.signal) ?? null,
        })
      : null
    if (load === null) {
      if (lease.isCurrent()) {
        execution.loadingAround = false
        this.driveExplicitTarget(execution)
      }
      return
    }
    void Promise.resolve(load)
      .catch(() => undefined)
      .finally(() => {
        if (!lease.isCurrent()) return
        execution.loadingAround = false
        this.driveExplicitTarget(execution)
      })
  }

  private startExplicitTargetLoop(
    execution: ExplicitTargetExecutionState,
  ): void {
    if (
      !this.isExplicitTargetExecutionCurrent(execution) ||
      execution.loop
    ) {
      return
    }
    execution.framesLeft = EXPLICIT_TARGET_REASSERT_FRAMES
    execution.stableFrames = 0
    execution.landedTarget = null
    execution.applied = false
    const lease = this.beginExplicitTargetOperation(execution)
    const loop = runScrollShadowSafely<PositionFrameLoop | null>({
      event: 'explicit-target-loop-start',
      conversationId: execution.request.conversationId,
      fallback: null,
      observe: () => execution.executor.beginLoop(lease),
    })
    if (!lease.isCurrent()) {
      if (loop) {
        runScrollShadowSafely({
          event: 'explicit-target-loop-stale-finish',
          conversationId: execution.request.conversationId,
          fallback: undefined,
          observe: () => loop.finish(),
        })
      }
      return
    }
    if (!loop) {
      this.model = advancePhaseIfCurrent(
        this.model,
        execution.request.conversationId,
        execution.request.generation,
        { kind: 'pending', reason: 'target-not-indexed' },
      )
      return
    }
    execution.loop = loop
    this.scheduleExplicitTargetFrame(execution, lease)
  }

  private driveExplicitTargetFrame(
    execution: ExplicitTargetExecutionState,
    lease: PositionExecutionLease,
  ): void {
    if (!lease.isCurrent()) return
    if (execution.framesLeft-- <= 0) {
      if (execution.applied) {
        this.finishExplicitTargetExecution(
          execution,
          true,
          'best-effort',
        )
      } else {
        this.finishExplicitTargetLoop(execution)
        this.model = advancePhaseIfCurrent(
          this.model,
          execution.request.conversationId,
          execution.request.generation,
          { kind: 'pending', reason: 'target-not-indexed' },
        )
      }
      return
    }

    const currentScrollTop = runScrollShadowSafely<number | null>({
      event: 'explicit-target-read-scroll-top',
      conversationId: execution.request.conversationId,
      fallback: null,
      observe: () => execution.executor.readScrollTop(),
    })
    if (
      currentScrollTop !== null &&
      execution.landedTarget !== null &&
      Math.abs(currentScrollTop - execution.landedTarget) >
        EXPLICIT_TARGET_TAKEOVER_DRIFT_PX
    ) {
      const { conversationId, generation } = execution.request
      this.model = cancelReconciliationForUserInput(
        this.model,
        conversationId,
        generation,
      )
      this.finishExplicitTargetExecution(
        execution,
        false,
        'user-takeover',
      )
      return
    }

    const result = runScrollShadowSafely<ExplicitTargetFrameResult>({
      event: 'explicit-target-frame',
      conversationId: execution.request.conversationId,
      fallback: { kind: 'unavailable' },
      observe: () => execution.executor.positionFrame(
        execution.request,
        lease,
      ),
    })
    if (!lease.isCurrent()) return

    if (result.kind === 'waiting') {
      this.recordExplicitTargetFrame(execution, false)
      this.scheduleExplicitTargetFrame(execution, lease)
      return
    }
    if (result.kind === 'unavailable') {
      this.finishExplicitTargetLoop(execution)
      this.model = advancePhaseIfCurrent(
        this.model,
        execution.request.conversationId,
        execution.request.generation,
        { kind: 'pending', reason: 'target-not-indexed' },
      )
      return
    }

    execution.applied = true
    lease.markApplied()
    if (!lease.isCurrent()) return

    if (
      execution.landedTarget !== null &&
      Math.abs(result.scrollTop - execution.landedTarget) <=
        EXPLICIT_TARGET_DRIFT_PX
    ) {
      execution.stableFrames += 1
      if (execution.stableFrames >= EXPLICIT_TARGET_STABLE_FRAMES) {
        this.recordExplicitTargetFrame(execution, result.wrote)
        this.finishExplicitTargetExecution(execution, true, 'settled')
        return
      }
    } else {
      execution.stableFrames = 0
    }
    execution.landedTarget = result.scrollTop
    this.recordExplicitTargetFrame(execution, result.wrote)
    this.scheduleExplicitTargetFrame(execution, lease)
  }

  private scheduleExplicitTargetFrame(
    execution: ExplicitTargetExecutionState,
    lease: PositionExecutionLease,
  ): void {
    if (!lease.isCurrent() || !execution.loop) return
    const scheduled = runScrollShadowSafely({
      event: 'explicit-target-frame-schedule',
      conversationId: execution.request.conversationId,
      fallback: false,
      observe: () => {
        execution.loop?.schedule(
          () => this.driveExplicitTargetFrame(execution, lease),
        )
        return true
      },
    })
    if (!scheduled && lease.isCurrent()) {
      this.finishExplicitTargetLoop(execution)
      this.model = advancePhaseIfCurrent(
        this.model,
        execution.request.conversationId,
        execution.request.generation,
        { kind: 'pending', reason: 'target-not-indexed' },
      )
    }
  }

  private recordExplicitTargetFrame(
    execution: ExplicitTargetExecutionState,
    wrote: boolean,
  ): void {
    runScrollShadowSafely({
      event: 'explicit-target-frame-monitor',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => execution.loop?.recordFrame(wrote),
    })
  }

  private beginExplicitTargetOperation(
    execution: ExplicitTargetExecutionState,
  ): PositionExecutionLease {
    execution.abortController?.abort()
    const abortController = new AbortController()
    execution.abortController = abortController
    const operation = ++execution.operation
    const { conversationId, generation } = execution.request
    const isCurrent = () =>
      !abortController.signal.aborted &&
      this.explicitTargetExecution === execution &&
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

  private isExplicitTargetExecutionCurrent(
    execution: ExplicitTargetExecutionState,
  ): boolean {
    return (
      this.explicitTargetExecution === execution &&
      isCurrentGeneration(
        this.model,
        execution.request.conversationId,
        execution.request.generation,
      )
    )
  }

  private finishExplicitTargetExecution(
    execution: ExplicitTargetExecutionState,
    settle: boolean,
    outcome?: ExplicitTargetCompletion,
  ): void {
    if (settle && this.isExplicitTargetExecutionCurrent(execution)) {
      this.model = advancePhaseIfCurrent(
        this.model,
        execution.request.conversationId,
        execution.request.generation,
        { kind: 'settled' },
      )
    }
    this.finishExplicitTargetLoop(execution)
    execution.abortController?.abort()
    if (this.explicitTargetExecution === execution) {
      this.explicitTargetExecution = null
    }
    if (outcome) {
      runScrollShadowSafely({
        event: 'explicit-target-complete',
        conversationId: execution.request.conversationId,
        fallback: undefined,
        observe: () => execution.executor.complete(
          execution.request,
          outcome,
          execution.applied,
        ),
      })
    }
  }

  private finishExplicitTargetLoop(
    execution: ExplicitTargetExecutionState,
  ): void {
    const loop = execution.loop
    execution.loop = null
    if (!loop) return
    runScrollShadowSafely({
      event: 'explicit-target-loop-finish',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => loop.finish(),
    })
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
    if (execution.framesLeft-- <= 0) {
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
    ) as LiveEdgeRequest
    const accepted = acceptPositionRequest(this.model, request)
    if (accepted === this.model) {
      this.cancelUnreadExecution()
      return
    }
    const liveExecutor = execution.executor.liveEdge
    const reachability = runScrollShadowSafely<ReachabilityFacts | null>({
      event: reason,
      conversationId: request.conversationId,
      fallback: null,
      observe: () => liveExecutor.reachability(),
    })
    if (!reachability || !reachabilityMatchesRequest(request, reachability)) {
      this.cancelUnreadExecution()
      return
    }
    this.cancelUnreadExecution()
    this.model = advancePhaseIfCurrent(
      accepted,
      request.conversationId,
      request.generation,
      resolveReachability(request, reachability),
    )
    const liveExecution = this.createLiveEdgeExecution(
      request,
      liveExecutor,
    )
    this.liveEdgeExecution = liveExecution
    this.driveLiveEdge(liveExecution)
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
    if (
      !execution ||
      !this.isSavedExecutionCurrent(execution) ||
      execution.loop
    ) {
      return
    }

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
        this.startSavedPositionLoop(execution)
      }
    }
  }

  private startSavedPositionLoop(
    execution: SavedPositionExecutionState,
  ): void {
    if (
      !this.isSavedExecutionCurrent(execution) ||
      execution.loop
    ) {
      return
    }

    execution.framesLeft = SAVED_POSITION_REASSERT_FRAMES
    execution.stableFrames = 0
    execution.landedTarget = null
    const lease = this.beginSavedOperation(execution)

    // Preserve the pre-paint entry write: the first measured application happens synchronously
    // from the conversation-entry layout effect. Only the subsequent measurement settle is
    // scheduled through the shared frame-loop owner.
    const initial = this.positionSavedFrame(execution, lease)
    if (!lease.isCurrent()) return
    if (initial.kind === 'unavailable') {
      if (
        execution.request.source.kind === 'fallback' &&
        execution.request.desired.kind === 'live-edge'
      ) {
        this.cancelSavedExecution()
        return
      }
      this.promoteSavedFallback(
        execution,
        execution.request.onUnavailable ?? { kind: 'live-edge' },
      )
      return
    }

    lease.markApplied()
    if (!lease.isCurrent()) return
    this.completeSavedPosition(execution, 'applied')
    if (!initial.reassert) return

    const loop = runScrollShadowSafely<PositionFrameLoop | null>({
      event: 'saved-position-loop-start',
      conversationId: execution.request.conversationId,
      fallback: null,
      observe: () => execution.executor.beginLoop(lease),
    })
    if (!lease.isCurrent()) {
      if (loop) {
        runScrollShadowSafely({
          event: 'saved-position-loop-stale-finish',
          conversationId: execution.request.conversationId,
          fallback: undefined,
          observe: () => loop.finish(),
        })
      }
      return
    }
    if (!loop) {
      this.settleSavedPosition(execution, lease, 'best-effort')
      return
    }
    execution.loop = loop
    this.scheduleSavedPositionFrame(execution, lease)
  }

  private driveSavedPositionFrame(
    execution: SavedPositionExecutionState,
    lease: SavedPositionExecutionLease,
  ): void {
    if (!lease.isCurrent()) return
    if (execution.framesLeft-- <= 0) {
      this.settleSavedPosition(execution, lease, 'best-effort')
      return
    }

    const result = this.positionSavedFrame(execution, lease)
    if (!lease.isCurrent()) return
    if (result.kind === 'unavailable') {
      // Once the initial anchor write landed, losing the row during re-windowing was historically
      // a best-effort stop, not a new fallback request. Preserve that release seam.
      this.settleSavedPosition(execution, lease, 'best-effort')
      return
    }
    if (!result.reassert) {
      this.settleSavedPosition(execution, lease, 'settled')
      return
    }

    let wrote = false
    if (
      execution.landedTarget !== null &&
      Math.abs(result.scrollTop - execution.landedTarget) <=
        SAVED_POSITION_DRIFT_PX
    ) {
      execution.stableFrames += 1
      if (execution.stableFrames >= SAVED_POSITION_STABLE_FRAMES) {
        this.settleSavedPosition(execution, lease, 'settled')
        return
      }
    } else {
      wrote = true
      execution.stableFrames = 0
    }
    execution.landedTarget = result.scrollTop
    this.recordSavedPositionFrame(execution, wrote)
    this.scheduleSavedPositionFrame(execution, lease)
  }

  private positionSavedFrame(
    execution: SavedPositionExecutionState,
    lease: SavedPositionExecutionLease,
  ): SavedPositionFrameResult {
    return runScrollShadowSafely<SavedPositionFrameResult>({
      event: 'saved-position-frame',
      conversationId: execution.request.conversationId,
      fallback: { kind: 'unavailable' },
      observe: () => execution.executor.positionFrame(
        execution.request,
        lease,
      ),
    })
  }

  private scheduleSavedPositionFrame(
    execution: SavedPositionExecutionState,
    lease: SavedPositionExecutionLease,
  ): void {
    if (!lease.isCurrent() || !execution.loop) return
    const scheduled = runScrollShadowSafely({
      event: 'saved-position-frame-schedule',
      conversationId: execution.request.conversationId,
      fallback: false,
      observe: () => {
        execution.loop?.schedule(
          () => this.driveSavedPositionFrame(execution, lease),
        )
        return true
      },
    })
    if (!scheduled && lease.isCurrent()) {
      this.settleSavedPosition(execution, lease, 'best-effort')
    }
  }

  private recordSavedPositionFrame(
    execution: SavedPositionExecutionState,
    wrote: boolean,
  ): void {
    runScrollShadowSafely({
      event: 'saved-position-frame-monitor',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => execution.loop?.recordFrame(wrote),
    })
  }

  private settleSavedPosition(
    execution: SavedPositionExecutionState,
    lease: SavedPositionExecutionLease,
    outcome: Extract<SavedPositionCompletion, 'settled' | 'best-effort'>,
  ): void {
    if (!lease.isCurrent()) return
    this.finishSavedLoop(execution)
    this.completeSavedPosition(execution, outcome)
    lease.settle()
  }

  private completeSavedPosition(
    execution: SavedPositionExecutionState,
    outcome: SavedPositionCompletion,
  ): void {
    runScrollShadowSafely({
      event: 'saved-position-complete',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => execution.executor.complete(
        execution.request,
        outcome,
      ),
    })
  }

  private finishSavedLoop(execution: SavedPositionExecutionState): void {
    const loop = execution.loop
    execution.loop = null
    if (!loop) return
    runScrollShadowSafely({
      event: 'saved-position-loop-finish',
      conversationId: execution.request.conversationId,
      fallback: undefined,
      observe: () => loop.finish(),
    })
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
    this.startSavedPositionLoop(execution)
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
      const request = execution.request as LiveEdgeRequest
      const liveExecutor = execution.executor.liveEdge
      this.cancelSavedExecution()
      this.model = advancePhaseIfCurrent(
        this.model,
        request.conversationId,
        request.generation,
        { kind: 'reconciling' },
      )
      const liveExecution = this.createLiveEdgeExecution(
        request,
        liveExecutor,
      )
      this.liveEdgeExecution = liveExecution
      this.driveLiveEdge(liveExecution)
      return
    }

    const generation = mintPositionGeneration()
    const request: SavedPositionRequest = {
      generation,
      conversationId: execution.request.conversationId,
      source: { kind: 'fallback', reason: 'saved-position-unavailable' },
      desired,
    } as SavedPositionRequest
    const accepted = acceptPositionRequest(this.model, request)
    if (accepted === this.model) {
      this.cancelSavedExecution()
      return
    }
    if (request.desired.kind === 'live-edge') {
      const liveRequest = request as LiveEdgeRequest
      const liveExecutor = execution.executor.liveEdge
      const reachability = runScrollShadowSafely<ReachabilityFacts | null>({
        event: 'saved-position-live-edge-fallback',
        conversationId: liveRequest.conversationId,
        fallback: null,
        observe: () => liveExecutor.reachability(),
      })
      if (
        !reachability ||
        !reachabilityMatchesRequest(liveRequest, reachability)
      ) {
        this.cancelSavedExecution()
        return
      }
      this.cancelSavedExecution()
      this.model = advancePhaseIfCurrent(
        accepted,
        liveRequest.conversationId,
        liveRequest.generation,
        resolveReachability(liveRequest, reachability),
      )
      const liveExecution = this.createLiveEdgeExecution(
        liveRequest,
        liveExecutor,
      )
      this.liveEdgeExecution = liveExecution
      this.driveLiveEdge(liveExecution)
      return
    }
    this.finishSavedLoop(execution)
    execution.abortController?.abort()
    execution.request = request
    execution.operation += 1
    execution.abortController = null
    execution.loadingAround = false
    execution.aroundAttempted = true
    execution.lastRecenterVersion = null
    execution.framesLeft = SAVED_POSITION_REASSERT_FRAMES
    execution.stableFrames = 0
    execution.landedTarget = null
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
    const targetExecution = this.explicitTargetExecution
    if (
      targetExecution &&
      !this.isExplicitTargetExecutionCurrent(targetExecution)
    ) {
      this.cancelExplicitTargetExecution()
    }
    const liveEdgeExecution = this.liveEdgeExecution
    if (
      liveEdgeExecution &&
      !this.isLiveEdgeExecutionCurrent(liveEdgeExecution)
    ) {
      this.cancelLiveEdgeExecution('superseded')
    }
    const mediaExecution = this.mediaPreservationExecution
    if (
      mediaExecution &&
      !this.isMediaPreservationExecutionCurrent(mediaExecution)
    ) {
      this.cancelMediaPreservationExecution('superseded')
    }
    const directionalExecution = this.directionalHistoryExecution
    if (
      directionalExecution &&
      !this.isDirectionalHistoryExecutionCurrent(directionalExecution)
    ) {
      this.cancelDirectionalHistoryExecution('superseded')
    }
  }

  private cancelAllExecutions(outcome: 'superseded'): void {
    this.cancelSavedExecution()
    this.cancelUnreadExecution()
    this.cancelExplicitTargetExecution()
    this.cancelLiveEdgeExecution(outcome)
    this.cancelMediaPreservationExecution(outcome)
    this.cancelDirectionalHistoryExecution(outcome)
  }

  private cancelSavedExecution(): void {
    if (this.savedExecution) {
      this.finishSavedLoop(this.savedExecution)
      this.savedExecution.abortController?.abort()
    }
    this.savedExecution = null
  }

  private cancelUnreadExecution(): void {
    if (this.unreadExecution) {
      this.finishUnreadLoop(this.unreadExecution)
      this.unreadExecution.abortController?.abort()
    }
    this.unreadExecution = null
  }

  private cancelExplicitTargetExecution(): void {
    if (this.explicitTargetExecution) {
      this.finishExplicitTargetLoop(this.explicitTargetExecution)
      this.explicitTargetExecution.abortController?.abort()
    }
    this.explicitTargetExecution = null
  }

  private cancelLiveEdgeExecution(outcome: LiveEdgeCompletion): void {
    const execution = this.liveEdgeExecution
    if (execution) {
      this.finishLiveEdgeLoop(execution)
      execution.abortController?.abort()
      this.completeLiveEdge(execution, outcome)
    }
    this.liveEdgeExecution = null
  }

  private cancelMediaPreservationExecution(
    outcome: MediaPreservationCompletion,
  ): void {
    const execution = this.mediaPreservationExecution
    if (execution) {
      this.finishMediaPreservationLoop(execution)
      execution.abortController?.abort()
      this.completeMediaPreservation(execution, outcome)
    }
    this.mediaPreservationExecution = null
  }

  private cancelDirectionalHistoryExecution(
    outcome: DirectionalHistoryCompletion,
  ): void {
    const execution = this.directionalHistoryExecution
    if (execution) {
      this.finishDirectionalHistoryLoop(execution)
      execution.abortController?.abort()
      this.completeDirectionalHistory(execution, outcome)
    }
    this.directionalHistoryExecution = null
  }
}

export type { PositionRequestDraft }
