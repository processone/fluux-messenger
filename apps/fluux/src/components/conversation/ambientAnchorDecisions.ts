/**
 * Pure decisions for ambient layout preservation.
 *
 * Two mutations move a scrolled-up reader without them asking: the unread divider changing position,
 * and a delayed live-path message sorting into the MIDDLE of the resident array. Both are ambient —
 * they preserve a reading point rather than navigating — so the controller rejects them while a
 * requested position is still unsettled.
 *
 * Everything here is a value-only decision over facts. No DOM, no controller, no measurement.
 */

export interface DividerTrackingState {
  conversationId: string
  dividerId: string | undefined
}

export interface ResidentTrackingState {
  conversationId: string
  messageCount: number
  firstMessageId: string | undefined
  lastMessageId: string | undefined
  interiorPlacementVersion: number
}

export interface ScrollGeometrySample {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export type AmbientMutationDecision =
  /** Conversation changed: adopt the new tracking and drop the departed room's anchor. */
  | { kind: 'reset' }
  /** Nothing this owner reacts to moved. */
  | { kind: 'unchanged' }
  /** Something moved, but there is no reading point worth preserving. */
  | { kind: 'retrack' }
  /** Preserve the captured reading point, then adopt the new tracking. */
  | { kind: 'preserve' }

/**
 * Capture is allowed only while the tracked state still describes this render. On the very commit
 * where the divider moves, the id mismatch deliberately blocks capture so a POST-mutation
 * measurement cannot overwrite the pre-mutation geometry the restore needs.
 */
export function shouldCaptureDividerAnchor(input: {
  tracked: DividerTrackingState
  conversationId: string
  dividerId: string | undefined
  readerScrolledUp: boolean
}): boolean {
  return (
    input.tracked.conversationId === input.conversationId &&
    input.tracked.dividerId === input.dividerId &&
    input.readerScrolledUp
  )
}

export function decideDividerMutation(input: {
  tracked: DividerTrackingState
  conversationId: string
  dividerId: string | undefined
  readerScrolledUp: boolean
  hasAnchor: boolean
}): AmbientMutationDecision {
  if (input.tracked.conversationId !== input.conversationId) return { kind: 'reset' }
  if (input.tracked.dividerId === input.dividerId) return { kind: 'unchanged' }
  return input.readerScrolledUp && input.hasAnchor
    ? { kind: 'preserve' }
    : { kind: 'retrack' }
}

/**
 * True while the resident array is identical to what the last capture saw. Both the capture effect
 * and the scroll handler gate on this so the commit that mutates the array still holds geometry
 * measured BEFORE the mutation.
 */
export function residentArrayUnchanged(
  tracked: ResidentTrackingState,
  next: ResidentTrackingState,
): boolean {
  return (
    tracked.conversationId === next.conversationId &&
    tracked.messageCount === next.messageCount &&
    tracked.firstMessageId === next.firstMessageId &&
    tracked.lastMessageId === next.lastMessageId &&
    tracked.interiorPlacementVersion === next.interiorPlacementVersion
  )
}

/**
 * Re-measuring is a per-row scan, so it is gated on the two cheap scalar reads that between them
 * cover every way the geometry can move: `scrollTop` (the reader scrolled) and `scrollHeight` (rows
 * re-measured, viewport resized). A virtualizer re-measure moves every row's content offset without
 * changing any message id, `bottomVisibleMessageId`, or firing a scroll event — keyed on any of
 * those the snapshot silently ages out and the restore lands on geometry the reader already left.
 */
export function shouldRecaptureInsertionAnchor(input: {
  captured: ScrollGeometrySample | null
  current: ScrollGeometrySample
}): boolean {
  const { captured, current } = input
  if (!captured) return true
  return (
    captured.scrollTop !== current.scrollTop ||
    captured.scrollHeight !== current.scrollHeight ||
    captured.clientHeight !== current.clientHeight
  )
}

/** At the live edge nothing above the reader can be pushed down, so no anchor is kept. */
export function insertionAnchorApplies(
  geometry: ScrollGeometrySample,
  atBottomThreshold: number,
): boolean {
  const distanceFromBottom =
    geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight
  return distanceFromBottom >= atBottomThreshold
}

/**
 * Distinguish a mid-array insertion from the three other ways the resident array changes.
 *
 * - A live-edge arrival moves the LAST row. Content added below a scrolled-up reader cannot move
 *   them, and the bottom-pin loop owns the at-bottom case.
 * - A load-older/newer batch also rewrites the array without moving the bottom row and owns its own
 *   directional restore, which must not be fought. It is identified by a snapshot landing in THIS
 *   commit, not merely by a first-id change: at the resident bound an insertion evicts the oldest
 *   row and so moves the first id too.
 * - An interior placement bump is authoritative on its own, even when the ids look unchanged.
 */
export function decideInsertionMutation(input: {
  tracked: ResidentTrackingState
  next: ResidentTrackingState
  directionalLoadLanding: boolean
  hasAnchor: boolean
}): AmbientMutationDecision {
  const { tracked, next } = input
  if (tracked.conversationId !== next.conversationId) return { kind: 'reset' }

  const bottomMoved = tracked.lastMessageId !== next.lastMessageId
  const residentChanged =
    tracked.messageCount !== next.messageCount ||
    tracked.firstMessageId !== next.firstMessageId
  const interiorPlacementAdvanced =
    next.interiorPlacementVersion > tracked.interiorPlacementVersion

  const inserted =
    !input.directionalLoadLanding &&
    (interiorPlacementAdvanced || (residentChanged && !bottomMoved))

  return inserted && input.hasAnchor ? { kind: 'preserve' } : { kind: 'retrack' }
}
