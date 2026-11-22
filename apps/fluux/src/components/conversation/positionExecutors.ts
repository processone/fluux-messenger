import type { ScrollWriteOwner } from './messageVirtualizer'
import type {
  AnchorPreservationRequest,
  DirectionalHistoryRequest,
  ExplicitTargetRequest,
  LiveEdgeRequest,
  ReachabilityFacts,
  ResidentTopRequest,
  SavedPositionRequest,
  UnreadMarkerRequest,
} from './scrollPositionModel'

/**
 * What the browser adapters hand the positioning controller: one executor per placement path, the
 * lease each run holds while it owns the position, and the frame loop a run drives.
 */

export type SavedPositionLoadAroundStatus =
  | 'available'
  | 'loading'
  | 'exhausted'
  | 'unavailable'

export interface PositionExecutionLease {
  conversationId: string
  generation: number
  operation: number
  /**
   * Frames this run may take before it gives up. The loop monitor derives its non-converging
   * threshold from it, so a run must report the budget it was actually given: understating it
   * calls a healthy loop non-converging, overstating it never calls anything.
   */
  frameBudget: number
  signal: AbortSignal
  isCurrent: () => boolean
  /** Owns the navigation writes this run makes: current while the request is, loop or not. */
  owner: ScrollWriteOwner
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
  /**
   * The frame wrote, and a released iOS fling holds that write until the fling ends: the list is
   * still where the fling carries it, so nothing landed.
   */
  | { kind: 'held' }
  | {
      kind: 'positioned'
      scrollTop: number
      atLiveEdge: boolean
    }

export interface UnreadMarkerGeometry {
  scrollTop: number
  /** The scroller's full content height (`scrollHeight`). */
  contentHeight: number
  /** A released iOS fling is still moving the list; the virtualizer holds absolute writes until it ends. */
  pendingFling?: boolean
}

/** How an unread-marker loop ended. A fallback hands the entry to a live-edge request instead. */
export type UnreadMarkerCompletion =
  | 'settled'
  | 'user-takeover'
  | 'unread-marker-unavailable'
  | 'unread-marker-resolved-at-live-edge'

export interface UnreadMarkerExecutor {
  reachability: (desired: UnreadMarkerRequest['desired']) => ReachabilityFacts
  beginLoop: (lease: PositionExecutionLease) => UnreadMarkerFrameLoop | null
  readGeometry: () => UnreadMarkerGeometry | null
  positionFrame: (
    request: UnreadMarkerRequest,
    lease: PositionExecutionLease,
  ) => UnreadMarkerFrameResult
  complete?: (request: UnreadMarkerRequest, outcome: UnreadMarkerCompletion) => void
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
  /**
   * The frame wrote, and a released iOS fling holds that write until the fling ends: the list is
   * still where the fling carries it, so nothing landed.
   */
  | { kind: 'held' }
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

export type AnchorPreservationCompletion =
  | 'settled'
  | 'best-effort'
  | 'user-takeover'
  | 'superseded'

export type AnchorPreservationFrameResult =
  | { kind: 'unavailable' }
  | {
      kind: 'positioned'
      scrollTop: number
      reassert: boolean
    }

export interface AnchorPreservationExecutor {
  observeGeometry: () => void
  reachability: (
    desired: AnchorPreservationRequest['desired'],
  ) => ReachabilityFacts
  beginLoop: (lease: PositionExecutionLease) => PositionFrameLoop | null
  positionFrame: (
    request: AnchorPreservationRequest,
    lease: PositionExecutionLease,
  ) => AnchorPreservationFrameResult
  complete: (
    request: AnchorPreservationRequest,
    outcome: AnchorPreservationCompletion,
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
  /**
   * The frame wrote, and a released iOS fling holds that write until the fling ends: the list is
   * still where the fling carries it, so nothing landed.
   */
  | { kind: 'held' }
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
  observeGeometry: (resetInput?: boolean) => void
  positionFrame: (
    request: ExplicitTargetRequest,
    lease: PositionExecutionLease,
    placement?: 'center' | 'keep-visible',
  ) => ExplicitTargetFrameResult
  complete: (
    request: ExplicitTargetRequest,
    outcome: ExplicitTargetCompletion,
    applied: boolean,
  ) => void
}

export type ResidentTopCompletion =
  | 'settled'
  | 'best-effort'
  | 'user-takeover'
  | 'superseded'

export type ResidentTopStartResult =
  | { kind: 'started' }
  | { kind: 'unavailable' }

export interface ResidentTopExecutor {
  reachability: () => ReachabilityFacts
  beginLoop: (lease: PositionExecutionLease) => PositionFrameLoop | null
  start: (
    request: ResidentTopRequest,
    lease: PositionExecutionLease,
  ) => ResidentTopStartResult
  positionFrame: (lease: PositionExecutionLease) => number | null
  complete: (
    request: ResidentTopRequest,
    outcome: ResidentTopCompletion,
  ) => void
}
