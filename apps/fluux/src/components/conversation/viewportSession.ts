import type { ScrollAnchor } from '@/utils/scrollStateManager'

export interface ViewportInput {
  deltaY: number
  source?: 'gesture' | 'keyboard'
}

export interface ViewportGeometry {
  top: number
  height: number
  client: number
  anchor?: { rowId: string; top: number }
  visibleAnchor?: { rowId: string; top: number } | null
}

export function scrollDeltaBeyondClamp(previous: Pick<ViewportGeometry, 'top'>, current: ViewportGeometry): number {
  const expectedTop = Math.max(0, Math.min(previous.top, current.height - current.client))
  return current.top - expectedTop
}

export interface ViewportSessionSnapshot {
  conversationId: string
  geometry: ViewportGeometry | null
  bottomAnchor: ScrollAnchor | null
  measuredAtLiveEdge: boolean | null
  hasGenuineInput: boolean
  previousScrollHeight: number | null
  lastProgrammaticScrollAt: number
  lastUserIntentAt: number
  travelledAwayFromTop: boolean
  travelledAwayFromBottom: boolean
}

export interface ViewportMovementObservation {
  delta: number
  userDelta: number
  viewportClamped: boolean
}

export interface ViewportScrollObservation extends ViewportMovementObservation {
  previousScrollHeight: number | null
  heightChanged: boolean
  growthDrivenDuringControllerScroll: boolean
  genuineUserScroll: boolean
  userScrollGeometry: ViewportGeometry | null
}

// Chromium can report a few pixels of scrollTop rounding while content grows under an active
// controller write. Input is observed separately, so this bound only filters geometry noise.
const CONTROLLER_GROWTH_JITTER_PX = 4

export type ViewportEdge = 'top' | 'bottom'

type MutableViewportSessionState = ViewportSessionSnapshot

function createInitialState(conversationId: string): MutableViewportSessionState {
  return {
    conversationId,
    geometry: null,
    bottomAnchor: null,
    measuredAtLiveEdge: null,
    hasGenuineInput: false,
    previousScrollHeight: null,
    lastProgrammaticScrollAt: 0,
    lastUserIntentAt: 0,
    travelledAwayFromTop: false,
    travelledAwayFromBottom: false,
  }
}

/**
 * Conversation-scoped observation state shared by scroll positioning consumers.
 *
 * This class deliberately accepts and returns geometry values rather than DOM elements or a
 * virtualizer. It owns no positioning operation or pixel-write capability.
 */
export class ViewportSession {
  private state: MutableViewportSessionState
  private observedGeometry: ViewportGeometry | null = null
  private pendingUserScrollGeometry: ViewportGeometry | null = null
  private pendingLayoutAdjustment = 0
  private pendingTrustedInput: {
    source: ViewportInput['source']
    direction: -1 | 1
    released: boolean
  } | null = null

  constructor(conversationId: string) {
    this.state = createInitialState(conversationId)
  }

  enterConversation(conversationId: string): void {
    this.state = createInitialState(conversationId)
    this.observedGeometry = null
    this.pendingUserScrollGeometry = null
    this.pendingLayoutAdjustment = 0
    this.pendingTrustedInput = null
  }

  snapshotFor(conversationId: string): ViewportSessionSnapshot | null {
    if (!this.isCurrent(conversationId)) return null
    return {
      ...this.state,
      geometry: this.state.geometry ? { ...this.state.geometry } : null,
      bottomAnchor: this.state.bottomAnchor ? { ...this.state.bottomAnchor } : null,
    }
  }

  recordViewport(
    conversationId: string,
    geometry: ViewportGeometry,
    bottomAnchor: ScrollAnchor | null,
  ): boolean {
    if (!this.isCurrent(conversationId)) return false
    this.state.geometry = { ...geometry }
    this.state.bottomAnchor = bottomAnchor ? { ...bottomAnchor } : null
    return true
  }

  recordBottomAnchor(conversationId: string, bottomAnchor: ScrollAnchor | null): boolean {
    if (!this.isCurrent(conversationId)) return false
    this.state.bottomAnchor = bottomAnchor ? { ...bottomAnchor } : null
    return true
  }

  rebaseViewport(conversationId: string, geometry: ViewportGeometry, bottomAnchor: ScrollAnchor | null): boolean {
    if (!this.recordViewport(conversationId, geometry, bottomAnchor)) return false
    if (this.observedGeometry) this.observedGeometry.anchor = geometry.anchor
    return true
  }

  recordMeasuredLiveEdge(conversationId: string, atEdge: boolean): boolean {
    if (!this.isCurrent(conversationId)) return false
    this.state.measuredAtLiveEdge = atEdge
    return true
  }

  recordProgrammaticWrite(conversationId: string, at: number, geometry: ViewportGeometry): boolean {
    if (!this.isCurrent(conversationId)) return false
    this.state.lastProgrammaticScrollAt = at
    this.observedGeometry = { ...geometry }
    this.pendingLayoutAdjustment = 0
    this.pendingTrustedInput = null
    return true
  }

  consumeLayoutAdjustment(conversationId: string): number {
    if (!this.isCurrent(conversationId)) return 0
    const adjustment = this.pendingLayoutAdjustment
    this.pendingLayoutAdjustment = 0
    return adjustment
  }

  layoutAdjustmentFor(conversationId: string): number {
    return this.isCurrent(conversationId) ? this.pendingLayoutAdjustment : 0
  }

  recordUserInput(conversationId: string, at: number): boolean {
    if (!this.isCurrent(conversationId)) return false
    this.state.hasGenuineInput = true
    this.state.lastUserIntentAt = at
    return true
  }

  endUserInput(conversationId: string): boolean {
    if (!this.isCurrent(conversationId)) return false
    if (this.pendingTrustedInput?.source === 'keyboard') {
      this.pendingTrustedInput.released = true
    } else {
      this.pendingTrustedInput = null
    }
    return true
  }

  hasGenuineInput(conversationId: string): boolean {
    return this.isCurrent(conversationId) && this.state.hasGenuineInput
  }

  lastUserIntentAt(conversationId: string): number {
    return this.isCurrent(conversationId) ? this.state.lastUserIntentAt : 0
  }

  observedRowIdFor(conversationId: string): string | undefined {
    return this.isCurrent(conversationId) ? this.observedGeometry?.anchor?.rowId : undefined
  }

  observeGeometry(conversationId: string, geometry: ViewportGeometry, context: {
    now: number
    controllerOwnsPixels: boolean
    input?: ViewportInput
    resetInput?: boolean
    nativeScroll?: boolean
  }): ViewportMovementObservation | null {
    if (!this.isCurrent(conversationId)) return null
    const previous = this.observedGeometry
    const delta = previous ? scrollDeltaBeyondClamp(previous, geometry) : 0
    if (context.resetInput) this.pendingTrustedInput = null
    if (context.input?.deltaY) {
      this.pendingTrustedInput = {
        source: context.input.source,
        direction: context.input.deltaY < 0 ? -1 : 1,
        released: false,
      }
    }
    const retainedAnchorChanged = previous?.anchor !== undefined && (
      previous.anchor.rowId !== geometry.anchor?.rowId ||
      previous.anchor.top !== geometry.anchor?.top
    )
    const layoutChanged = previous !== null && (
      previous.height !== geometry.height ||
      previous.client !== geometry.client ||
      retainedAnchorChanged
    )
    // A released keyboard input may still own the next native scroll event. An independently
    // observed layout change ends that causal chain, regardless of elapsed wall-clock time.
    if (this.pendingTrustedInput?.released && !context.nativeScroll && layoutChanged) {
      this.pendingTrustedInput = null
    }
    const sameAnchor = previous?.anchor !== undefined &&
      previous.anchor.rowId === geometry.anchor?.rowId
    const layoutDelta = sameAnchor ? geometry.anchor!.top - previous!.anchor!.top : 0
    const viewportClamped = previous !== null && previous.top !== geometry.top && delta === 0
    const controllerGrowthJitter =
      context.controllerOwnsPixels &&
      previous !== null &&
      previous.height !== geometry.height &&
      Math.abs(delta) <= CONTROLLER_GROWTH_JITTER_PX
    const trustedInputMatchesMovement = this.pendingTrustedInput !== null &&
      delta !== 0 &&
      Math.sign(delta) === this.pendingTrustedInput.direction
    const layoutAnchored = sameAnchor && delta === layoutDelta && !trustedInputMatchesMovement
    const userDelta = controllerGrowthJitter || layoutAnchored ? 0 : delta
    if (sameAnchor && previous) {
      this.pendingLayoutAdjustment += layoutDelta - (
        geometry.top - previous.top - (layoutAnchored ? 0 : delta)
      )
    }
    if (userDelta !== 0) {
      if (geometry.visibleAnchor !== undefined && geometry.visibleAnchor?.rowId !== previous?.anchor?.rowId) {
        this.pendingLayoutAdjustment = 0
      }
      this.state.hasGenuineInput = true
      this.pendingUserScrollGeometry = { ...geometry }
      this.pendingTrustedInput = null
    }
    if (context.nativeScroll && this.pendingTrustedInput?.released) {
      this.pendingTrustedInput = null
    }
    if (context.resetInput) {
      this.pendingUserScrollGeometry = null
    }
    this.observedGeometry = {
      ...geometry,
      anchor: userDelta !== 0 && geometry.visibleAnchor !== undefined
        ? geometry.visibleAnchor ?? undefined : geometry.anchor,
    }
    return {
      delta,
      userDelta,
      viewportClamped,
    }
  }

  observeScroll(facts: {
    conversationId: string
    geometry: ViewportGeometry
    bottomAnchor: ScrollAnchor | null
    controllerOwnsPixels: boolean
    now: number
  }): ViewportScrollObservation | null {
    if (!this.isCurrent(facts.conversationId)) return null

    const previousScrollHeight = this.state.previousScrollHeight
    const heightChanged =
      previousScrollHeight !== null &&
      previousScrollHeight !== facts.geometry.height
    const movement = this.observeGeometry(facts.conversationId, facts.geometry, {
      ...facts,
      nativeScroll: true,
    })!

    this.recordViewport(
      facts.conversationId,
      facts.geometry,
      facts.bottomAnchor,
    )

    const genuineUserScroll = movement.userDelta !== 0
    const userScrollGeometry = this.pendingUserScrollGeometry
    this.pendingUserScrollGeometry = null

    this.state.previousScrollHeight = facts.geometry.height

    return {
      previousScrollHeight,
      heightChanged,
      ...movement,
      growthDrivenDuringControllerScroll:
        facts.controllerOwnsPixels &&
        previousScrollHeight !== null &&
        facts.geometry.height > previousScrollHeight,
      genuineUserScroll,
      userScrollGeometry,
    }
  }

  markTravelAway(conversationId: string, edge: ViewportEdge): boolean {
    if (!this.isCurrent(conversationId)) return false
    if (edge === 'top') {
      this.state.travelledAwayFromTop = true
    } else {
      this.state.travelledAwayFromBottom = true
    }
    return true
  }

  clearTravel(conversationId: string, edge: ViewportEdge): boolean {
    if (!this.isCurrent(conversationId)) return false
    if (edge === 'top') {
      this.state.travelledAwayFromTop = false
    } else {
      this.state.travelledAwayFromBottom = false
    }
    return true
  }

  hasTravelledAway(conversationId: string, edge: ViewportEdge): boolean {
    if (!this.isCurrent(conversationId)) return false
    return edge === 'top'
      ? this.state.travelledAwayFromTop
      : this.state.travelledAwayFromBottom
  }

  private isCurrent(conversationId: string): boolean {
    return this.state.conversationId === conversationId
  }
}
