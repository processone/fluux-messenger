import type { ScrollAnchor } from '@/utils/scrollStateManager'
import { isProgrammaticScroll } from './scrollGate'

export interface ViewportGeometry {
  top: number
  height: number
  client: number
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

export interface ViewportScrollObservation {
  previousScrollHeight: number | null
  heightChanged: boolean
  growthDrivenDuringControllerScroll: boolean
  genuineUserScroll: boolean
}

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
 * virtualizer. It owns no positioning operation: controller executors remain the only live-list
 * pixel writers.
 */
export class ViewportSession {
  private state: MutableViewportSessionState

  constructor(conversationId: string) {
    this.state = createInitialState(conversationId)
  }

  enterConversation(conversationId: string): void {
    this.state = createInitialState(conversationId)
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

  recordMeasuredLiveEdge(conversationId: string, atEdge: boolean): boolean {
    if (!this.isCurrent(conversationId)) return false
    this.state.measuredAtLiveEdge = atEdge
    return true
  }

  recordProgrammaticWrite(conversationId: string, at: number): boolean {
    if (!this.isCurrent(conversationId)) return false
    this.state.lastProgrammaticScrollAt = at
    return true
  }

  recordUserInput(conversationId: string, at: number): boolean {
    if (!this.isCurrent(conversationId)) return false
    this.state.hasGenuineInput = true
    this.state.lastUserIntentAt = at
    return true
  }

  hasGenuineInput(conversationId: string): boolean {
    return this.isCurrent(conversationId) && this.state.hasGenuineInput
  }

  lastUserIntentAt(conversationId: string): number {
    return this.isCurrent(conversationId) ? this.state.lastUserIntentAt : 0
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

    this.recordViewport(
      facts.conversationId,
      facts.geometry,
      facts.bottomAnchor,
    )

    // A measurement change can arrive long after the original positioning write. Re-anchor the
    // settle window so a later height-stable settle frame cannot masquerade as a scrollbar drag.
    if (heightChanged) {
      this.state.lastProgrammaticScrollAt = facts.now
    }

    const genuineUserScroll =
      !isProgrammaticScroll(
        facts.controllerOwnsPixels,
        facts.now,
        this.state.lastProgrammaticScrollAt,
      ) &&
      previousScrollHeight === facts.geometry.height

    if (genuineUserScroll) {
      this.state.hasGenuineInput = true
    }
    this.state.previousScrollHeight = facts.geometry.height

    return {
      previousScrollHeight,
      heightChanged,
      growthDrivenDuringControllerScroll:
        facts.controllerOwnsPixels &&
        previousScrollHeight !== null &&
        facts.geometry.height > previousScrollHeight,
      genuineUserScroll,
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
