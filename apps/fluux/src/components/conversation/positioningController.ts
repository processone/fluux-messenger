import {
  acceptPositionRequest,
  advancePhaseIfCurrent,
  cancelReconciliationForUserInput,
  deactivateConversation,
  initialPositioningModel,
  resolveReachability,
  selectEntryPosition,
  selectLiveEdgeNavigation,
  settleUserPosition,
  shouldReconcileAfterAppend,
  type EntryPositionFacts,
  type LiveEdgeNavigationFacts,
  type PositionRequest,
  type PositioningModel,
  type ReachabilityFacts,
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

  snapshot(): PositioningModel {
    return this.model
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
      },
    })
  }
}

export type { PositionRequestDraft }
