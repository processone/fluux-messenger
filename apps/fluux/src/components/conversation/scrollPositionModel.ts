/**
 * Pure semantic model for message-list positioning.
 *
 * This module answers:
 *   - what position the UI wants,
 *   - whether that position is reachable yet,
 *   - which request supersedes an older one, and
 *   - how user takeover affects reconciliation and follow-live policy.
 *
 * It deliberately does NOT implement pixel reconciliation, measurement settling, rAF ownership,
 * scroll-event classification, or WebKit repaint correction. Those remain the hard responsibilities
 * of the positioning reconciler.
 */

declare const messageFractionBrand: unique symbol
declare const pixelOffsetBrand: unique symbol

/** A validated point within a message: 0 is its top and 1 is its bottom. */
export type MessageFraction = number & { readonly [messageFractionBrand]: true }

export function messageFraction(value: number): MessageFraction {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('message fraction must be a finite number between 0 and 1')
  }
  return value as MessageFraction
}

/** A finite CSS-pixel measurement. Negative values are valid where the geometry permits them. */
export type PixelOffset = number & { readonly [pixelOffsetBrand]: true }

export function pixelOffset(value: number): PixelOffset {
  if (!Number.isFinite(value)) {
    throw new RangeError('pixel offset must be finite')
  }
  return value as PixelOffset
}

export type LiveEdgePosition = {
  /** Follow future rows and bottom-of-list UI, not merely the current last row. */
  kind: 'live-edge'
  follow: true
}

export type BottomFractionAnchorPosition = {
  kind: 'anchor'
  messageId: string
  placement: {
    /**
     * Keep this message point at the viewport bottom:
     * rowTop + fraction * rowHeight = scrollTop + viewportHeight.
     */
    kind: 'bottom-fraction'
    fraction: MessageFraction
  }
}

export type TopOffsetAnchorPosition = {
  kind: 'anchor'
  messageId: string
  placement: {
    /**
     * Keep the row's top at this viewport-top offset:
     * rowTop - scrollTop = offsetPx. Negative offsets are valid.
     */
    kind: 'top-offset'
    offsetPx: PixelOffset
  }
}

export type MessagePosition<
  Align extends 'start' | 'top-third' | 'center' | 'end' =
    | 'start'
    | 'top-third'
    | 'center'
    | 'end',
> = {
  kind: 'message'
  messageId: string
  align: Align
}

export type LegacyOffsetPosition = {
  /**
   * Transitional support for saved states that predate content anchors. New code must never persist
   * this as the semantic position.
   */
  kind: 'legacy-offset'
  offsetPx: PixelOffset
}

export type DesiredPosition =
  | LiveEdgePosition
  | BottomFractionAnchorPosition
  | TopOffsetAnchorPosition
  | MessagePosition
  | { kind: 'resident-top' }
  | LegacyOffsetPosition

export type UnavailablePolicy =
  | { kind: 'wait' }
  | { kind: 'live-edge' }
  | { kind: 'legacy-offset'; offsetPx: PixelOffset; otherwise: 'live-edge' }
  | { kind: 'distance-from-bottom'; distancePx: PixelOffset }
  | { kind: 'warn-and-stop' }

type Request<
  Source,
  Desired extends DesiredPosition,
  Unavailable extends UnavailablePolicy | undefined = undefined,
> = {
  /** Monotonic token. Async work from an older generation must never affect the active request. */
  generation: number
  conversationId: string
  source: Source
  desired: Desired
} & (Unavailable extends UnavailablePolicy
  ? { onUnavailable: Unavailable }
  : { onUnavailable?: never })

type EntryRequest =
  | Request<
      { kind: 'entry'; reason: 'saved-position' },
      BottomFractionAnchorPosition,
      Extract<UnavailablePolicy, { kind: 'live-edge' | 'legacy-offset' }>
    >
  | Request<{ kind: 'entry'; reason: 'saved-position' }, LegacyOffsetPosition>
  | Request<
      { kind: 'entry'; reason: 'unread-marker' },
      MessagePosition<'start'>,
      Extract<UnavailablePolicy, { kind: 'live-edge' }>
    >
  | Request<{ kind: 'entry'; reason: 'live-edge' }, LiveEdgePosition>
  | Request<{ kind: 'entry'; reason: 'synced-live-edge' }, LiveEdgePosition>

type UserNavigationRequest =
  | Request<
      { kind: 'user-navigation'; reason: 'message-target' },
      MessagePosition<'center'>,
      Extract<UnavailablePolicy, { kind: 'wait' }>
    >
  | Request<
      { kind: 'user-navigation'; reason: 'unread-marker' },
      MessagePosition<'start' | 'top-third'>,
      Extract<UnavailablePolicy, { kind: 'live-edge' }>
    >
  | Request<{ kind: 'user-navigation'; reason: 'live-edge' }, LiveEdgePosition>
  | Request<{ kind: 'user-navigation'; reason: 'resident-top' }, { kind: 'resident-top' }>

export type PositionRequest =
  | EntryRequest
  | UserNavigationRequest
  | Request<{ kind: 'live-update'; reason: 'outgoing-message' }, LiveEdgePosition>
  | Request<
      { kind: 'history-preservation'; reason: 'window-shift' },
      TopOffsetAnchorPosition,
      Extract<UnavailablePolicy, { kind: 'distance-from-bottom' }>
    >
  | Request<
      { kind: 'media-preservation'; reason: 'remeasure' },
      BottomFractionAnchorPosition,
      Extract<UnavailablePolicy, { kind: 'warn-and-stop' }>
    >
  | Request<
      {
        kind: 'late-mds-supersession'
        reason: 'read-pointer-at-live-edge' | 'divider-cleared'
      },
      LiveEdgePosition
    >
  | Request<
      {
        kind: 'fallback'
        reason: 'saved-position-unavailable'
      },
      LiveEdgePosition | LegacyOffsetPosition
    >
  | Request<
      {
        kind: 'fallback'
        reason: 'unread-marker-unavailable'
      },
      LiveEdgePosition
    >

export type PositionRequestSource = PositionRequest['source']

/**
 * Reachability/convergence lifecycle for one request.
 *
 * `pending`, `loading-around`, `mounting`, and `unavailable` make off-window/deep-history targets
 * explicit. `reconciling` says the semantic position is resolvable; the browser reconciler still
 * owns measured geometry, one-write-per-frame enforcement, convergence, and repaint behavior.
 */
export type PositioningPhase =
  | { kind: 'resolving' }
  | {
      kind: 'pending'
      reason: 'empty-window' | 'around-load' | 'live-edge-recenter' | 'target-not-indexed'
    }
  | { kind: 'loading-around'; messageId: string }
  | { kind: 'recentering-live-edge' }
  | { kind: 'mounting'; index: number; messageId?: string }
  | { kind: 'unavailable'; policy: UnavailablePolicy }
  | { kind: 'paused-user-input' }
  | { kind: 'reconciling' }
  | { kind: 'position-applied' }
  | { kind: 'settled' }

export interface PositioningModel {
  /** Highest accepted generation, retained after settle/cancellation to reject stale completions. */
  watermark: number
  /** Only an entry request changes the displayed conversation. */
  currentConversationId: string | null
  active: {
    request: PositionRequest
    phase: PositioningPhase
  } | null
  /**
   * Entry may be provisionally corrected by one late MDS request. User takeover, explicit
   * navigation, outgoing send, or an accepted MDS correction closes that entry window.
   */
  lateMdsEligibleFor: string | null
}

/**
 * Contradictory states (for example absent-but-mounted) are unrepresentable. For live edge,
 * `available` describes the current tail row; for resident top it describes the first resident row.
 */
export type ReachabilityFacts =
  | { kind: 'empty-window' }
  | {
      kind: 'target-absent'
      loadAround: 'available' | 'loading' | 'exhausted' | 'unavailable'
    }
  | {
      kind: 'available'
      index: number
      mounted: boolean
      /** Some placements are intentionally abandoned even after the row becomes reachable. */
      placement: 'viable' | 'use-unavailable-policy'
    }
  | {
      kind: 'global-live-edge'
      state:
        | { kind: 'resident-tail'; index: number; mounted: boolean }
        | { kind: 'recenter-available' }
        | { kind: 'recentering' }
        | { kind: 'unavailable' }
    }

export interface EntryPositionFacts {
  /**
   * The already-resolved remote read pointer says the local saved position is obsolete. This is
   * evaluated before the ordinary saved/unread/live entry priority.
   */
  syncedLiveEdge: boolean
  savedAnchor?: BottomFractionAnchorPosition
  savedOffsetPx?: PixelOffset
  firstUnreadMessageId?: string
}

export type EntryPositionSelection =
  | {
      source: { kind: 'entry'; reason: 'saved-position' }
      desired: BottomFractionAnchorPosition
      onUnavailable: Extract<UnavailablePolicy, { kind: 'live-edge' | 'legacy-offset' }>
    }
  | {
      source: { kind: 'entry'; reason: 'saved-position' }
      desired: LegacyOffsetPosition
    }
  | {
      source: { kind: 'entry'; reason: 'unread-marker' }
      desired: MessagePosition<'start'>
      onUnavailable: Extract<UnavailablePolicy, { kind: 'live-edge' }>
    }
  | {
      source: { kind: 'entry'; reason: 'live-edge' }
      desired: LiveEdgePosition
    }
  | {
      source: { kind: 'entry'; reason: 'synced-live-edge' }
      desired: LiveEdgePosition
    }

export interface LiveEdgeNavigationFacts {
  firstUnreadMessageId?: string
  /**
   * Computed from live geometry by the adapter. Virtualized callers treat an unknown marker offset
   * as needing a visit; non-virtualized callers only set this when the row exists below the
   * viewport.
   */
  unreadMarkerNeedsVisit: boolean
  unreadMarkerAlign: 'start' | 'top-third'
}

export type LiveEdgeNavigationSelection =
  | {
      source: { kind: 'user-navigation'; reason: 'unread-marker' }
      desired: MessagePosition<'start' | 'top-third'>
      onUnavailable: Extract<UnavailablePolicy, { kind: 'live-edge' }>
    }
  | {
      source: { kind: 'user-navigation'; reason: 'live-edge' }
      desired: LiveEdgePosition
    }

export const initialPositioningModel = (): PositioningModel => ({
  watermark: 0,
  currentConversationId: null,
  active: null,
  lateMdsEligibleFor: null,
})

export function isCurrentGeneration(
  model: PositioningModel,
  conversationId: string,
  generation: number,
): boolean {
  return (
    model.active?.request.conversationId === conversationId &&
    model.active.request.generation === generation
  )
}

/**
 * Accept a newer request and supersede the previous one.
 *
 * Entry chooses the displayed conversation. Automatic late MDS may only correct that same
 * conversation while its provisional entry window is still eligible. Other requests cannot
 * resurrect a conversation that is no longer displayed.
 */
export function acceptPositionRequest(
  model: PositioningModel,
  request: PositionRequest,
): PositioningModel {
  if (
    !Number.isSafeInteger(request.generation) ||
    request.generation <= model.watermark ||
    request.generation <= 0
  ) {
    return model
  }

  const isEntry = request.source.kind === 'entry'
  const isLateMds = request.source.kind === 'late-mds-supersession'
  if (
    (!isEntry && request.conversationId !== model.currentConversationId) ||
    (isLateMds && model.lateMdsEligibleFor !== request.conversationId)
  ) {
    return model
  }

  const active = model.active
  const preservationPending =
    active !== null &&
    active.phase.kind !== 'position-applied' &&
    active.phase.kind !== 'settled' &&
    ((active.request.source.kind === 'entry' &&
      active.request.source.reason === 'saved-position') ||
      active.request.source.kind === 'history-preservation')
  if (request.source.kind === 'live-update' && preservationPending) {
    // Current behavior drops this pin attempt; it does not queue an ownership change behind restore.
    return model
  }

  const closesMdsWindow =
    isLateMds ||
    request.source.kind === 'user-navigation' ||
    request.source.kind === 'live-update'

  return {
    watermark: request.generation,
    currentConversationId: isEntry ? request.conversationId : model.currentConversationId,
    active: {
      request,
      phase: { kind: 'resolving' },
    },
    lateMdsEligibleFor: isEntry
      ? request.source.reason === 'synced-live-edge'
        ? null
        : request.conversationId
      : closesMdsWindow
        ? null
        : model.lateMdsEligibleFor,
  }
}

/** Advance only the active conversation/generation; stale async work is an exact no-op. */
export function advancePhaseIfCurrent(
  model: PositioningModel,
  conversationId: string,
  generation: number,
  phase: PositioningPhase,
): PositioningModel {
  if (!isCurrentGeneration(model, conversationId, generation) || !model.active) return model
  if (model.active.phase.kind === 'paused-user-input') return model
  return {
    ...model,
    active: {
      ...model.active,
      phase,
    },
  }
}

/**
 * Genuine input cancels the current reconciliation run and closes the late-MDS entry window. A
 * live-edge request remains generation-bearing in a paused phase until settled geometry says
 * whether the reader left it. Fixed-position requests are cancelled immediately.
 */
export function cancelReconciliationForUserInput(
  model: PositioningModel,
  conversationId: string,
  generation: number,
): PositioningModel {
  if (!isCurrentGeneration(model, conversationId, generation)) return model
  return {
    ...model,
    active:
      model.active?.request.desired.kind === 'live-edge'
        ? {
            ...model.active,
            phase: { kind: 'paused-user-input' },
          }
        : null,
    lateMdsEligibleFor: null,
  }
}

/**
 * Resolve a paused live-edge request from settled user geometry. Remaining at the edge preserves
 * its generation; leaving cancels it. Manually returning after another request requires a new,
 * generation-bearing live-edge request supplied by the adapter.
 */
export function settleUserPosition(
  model: PositioningModel,
  conversationId: string,
  atLiveEdge: boolean,
  rearmRequest?: Extract<
    PositionRequest,
    { source: { kind: 'user-navigation'; reason: 'live-edge' } }
  >,
): PositioningModel {
  if (conversationId !== model.currentConversationId) return model
  const active = model.active
  if (
    active?.request.desired.kind === 'live-edge' &&
    active.phase.kind === 'paused-user-input'
  ) {
    return atLiveEdge
      ? {
          ...model,
          active: {
            ...active,
            phase: { kind: 'settled' },
          },
        }
      : { ...model, active: null }
  }
  if (!atLiveEdge || !rearmRequest) return model
  const rearmed = acceptPositionRequest(model, rearmRequest)
  return rearmed === model || !rearmed.active
    ? model
    : {
        ...rearmed,
        active: {
          ...rearmed.active,
          phase: { kind: 'settled' },
        },
      }
}

/**
 * Clear semantic ownership when the list unmounts or navigation leaves conversations. The
 * generation guard prevents a stale cleanup from deactivating a newer entry.
 */
export function deactivateConversation(
  model: PositioningModel,
  conversationId: string,
  generation: number,
): PositioningModel {
  if (
    model.currentConversationId !== conversationId ||
    model.watermark !== generation
  ) {
    return model
  }
  return {
    ...model,
    currentConversationId: null,
    active: null,
    lateMdsEligibleFor: null,
  }
}

/**
 * Resolve semantic reachability without reading DOM/layout geometry.
 *
 * The request's unavailable policy preserves source-specific behavior: saved restore can use a
 * legacy offset then live edge, unread falls back to live edge, explicit targets wait, directional
 * history preserves distance from bottom, and media-preservation failures stop with a warning.
 */
export function resolveReachability(
  request: PositionRequest,
  facts: ReachabilityFacts,
): PositioningPhase {
  if (facts.kind === 'empty-window') return { kind: 'pending', reason: 'empty-window' }

  if (facts.kind === 'target-absent') {
    const desired = request.desired
    if (desired.kind !== 'anchor' && desired.kind !== 'message') {
      return { kind: 'reconciling' }
    }
    if (facts.loadAround === 'available') {
      return { kind: 'loading-around', messageId: desired.messageId }
    }
    if (facts.loadAround === 'loading') {
      return { kind: 'pending', reason: 'around-load' }
    }
    return request.onUnavailable?.kind === 'wait'
      ? { kind: 'pending', reason: 'target-not-indexed' }
      : {
          kind: 'unavailable',
          policy: request.onUnavailable ?? { kind: 'warn-and-stop' },
        }
  }

  if (request.desired.kind === 'live-edge') {
    if (facts.kind !== 'global-live-edge') {
      return { kind: 'unavailable', policy: { kind: 'warn-and-stop' } }
    }
    const state = facts.state
    if (state.kind === 'recenter-available') {
      return { kind: 'recentering-live-edge' }
    }
    if (state.kind === 'recentering') {
      return { kind: 'pending', reason: 'live-edge-recenter' }
    }
    if (state.kind === 'unavailable') {
      return { kind: 'unavailable', policy: { kind: 'warn-and-stop' } }
    }
    return state.mounted
      ? { kind: 'reconciling' }
      : { kind: 'mounting', index: state.index }
  }

  if (request.desired.kind === 'legacy-offset') {
    return { kind: 'reconciling' }
  }

  if (facts.kind === 'global-live-edge') {
    return { kind: 'unavailable', policy: { kind: 'warn-and-stop' } }
  }

  if (facts.placement === 'use-unavailable-policy') {
    return request.onUnavailable?.kind === 'wait'
      ? { kind: 'pending', reason: 'target-not-indexed' }
      : {
          kind: 'unavailable',
          policy: request.onUnavailable ?? { kind: 'warn-and-stop' },
        }
  }

  if (!facts.mounted) {
    const desired = request.desired
    return {
      kind: 'mounting',
      index: facts.index,
      ...(desired.kind === 'anchor' || desired.kind === 'message'
        ? { messageId: desired.messageId }
        : {}),
    }
  }

  return { kind: 'reconciling' }
}

/** Select exactly one provisional position for conversation entry. */
export function selectEntryPosition(facts: EntryPositionFacts): EntryPositionSelection {
  if (facts.syncedLiveEdge) {
    return {
      source: { kind: 'entry', reason: 'synced-live-edge' },
      desired: { kind: 'live-edge', follow: true },
    }
  }

  if (facts.savedAnchor) {
    return {
      source: { kind: 'entry', reason: 'saved-position' },
      desired: facts.savedAnchor,
      onUnavailable:
        facts.savedOffsetPx === undefined
          ? { kind: 'live-edge' }
          : {
              kind: 'legacy-offset',
              offsetPx: facts.savedOffsetPx,
              otherwise: 'live-edge',
            },
    }
  }

  if (facts.savedOffsetPx !== undefined) {
    return {
      source: { kind: 'entry', reason: 'saved-position' },
      desired: { kind: 'legacy-offset', offsetPx: facts.savedOffsetPx },
    }
  }

  if (facts.firstUnreadMessageId) {
    return {
      source: { kind: 'entry', reason: 'unread-marker' },
      desired: {
        kind: 'message',
        messageId: facts.firstUnreadMessageId,
        align: 'start',
      },
      onUnavailable: { kind: 'live-edge' },
    }
  }

  return {
    source: { kind: 'entry', reason: 'live-edge' },
    desired: { kind: 'live-edge', follow: true },
  }
}

/**
 * Preserve FAB/End two-step behavior. The adapter decides from current geometry whether the unread
 * marker is still below the viewport; the pure arbiter chooses marker first or live edge.
 */
export function selectLiveEdgeNavigation(
  facts: LiveEdgeNavigationFacts,
): LiveEdgeNavigationSelection {
  if (facts.firstUnreadMessageId && facts.unreadMarkerNeedsVisit) {
    return {
      source: { kind: 'user-navigation', reason: 'unread-marker' },
      desired: {
        kind: 'message',
        messageId: facts.firstUnreadMessageId,
        align: facts.unreadMarkerAlign,
      },
      onUnavailable: { kind: 'live-edge' },
    }
  }
  return {
    source: { kind: 'user-navigation', reason: 'live-edge' },
    desired: { kind: 'live-edge', follow: true },
  }
}

/** Appended content re-opens reconciliation only while follow-live policy remains armed. */
export function shouldReconcileAfterAppend(
  model: PositioningModel,
  conversationId: string,
): boolean {
  return (
    model.currentConversationId === conversationId &&
    model.active?.request.desired.kind === 'live-edge' &&
    model.active.phase.kind !== 'paused-user-input'
  )
}
