/**
 * useAmbientAnchorPreservation - preserve a reading point through ambient layout mutations
 *
 * Two mutations move a scrolled-up reader without them asking for it:
 *
 * 1. The unread divider changes position.
 * 2. A delayed arrival — offline replay, gateway/MUC history, the MAM `{ids}` fetch — reaches the
 *    LIVE path carrying an OLD timestamp, so `appendLive` sorts it into the MIDDLE of the resident
 *    array. Landing above the reader it pushes the reading position down by the inserted height:
 *    the reader drifts backwards in time.
 *
 * Nothing else covers case 2. Media-growth compensation is reachable only from `onMediaLoad` and an
 * insertion fires no media event; the new-message effect deliberately does nothing for an incoming
 * message while scrolled up; and browser-native CSS scroll anchoring — which handles this in normal
 * flow — is inert under virtualization, because the virtualizer rewrites every row's inline `top` on
 * each commit, and WebKit does not implement it at all.
 *
 * Both are ambient layout preservation, NOT navigation: they go through the layout-preservation
 * request source, so the model rejects them while an entry restore, explicit target, or Home/End
 * command is still in flight rather than superseding what the reader asked for.
 *
 * Every branch decision lives in `ambientAnchorDecisions`; this hook only measures, holds the
 * captured anchors, and submits requests.
 */

import { useCallback, useLayoutEffect, useRef } from 'react'
import { AT_BOTTOM_THRESHOLD, type ScrollAnchor } from '@/utils/scrollStateManager'
import { findBottomAnchor } from './bottomAnchor'
import {
  decideDividerMutation,
  decideInsertionMutation,
  insertionAnchorApplies,
  residentArrayUnchanged,
  shouldCaptureDividerAnchor,
  shouldRecaptureInsertionAnchor,
  type ResidentTrackingState,
  type ScrollGeometrySample,
} from './ambientAnchorDecisions'
import { runScrollShadowSafely } from './scrollPositionShadow'
import { messageFraction, type AnchorPreservationRequest } from './scrollPositionModel'
import type { AnchorPreservationExecutor } from './positioningController'

type AmbientReason = 'divider-mutation' | 'message-insertion'
type AmbientLoopLabel = 'divider-anchor' | 'insertion-anchor'

export interface AmbientAnchorPorts {
  getScroller: () => HTMLElement | null
  /** The viewport session's own bottom anchor, preferred over a locally captured one. */
  getSessionBottomAnchor: (conversationId: string) => ScrollAnchor | null | undefined
  recordBottomAnchor: (conversationId: string, anchor: ScrollAnchor | null) => void
  /** True while a directional load's snapshot is landing in THIS commit. */
  isDirectionalLoadLanding: (conversationId: string, firstMessageId: string) => boolean
  beginLayoutPreservation: (input: {
    conversationId: string
    desired: AnchorPreservationRequest['desired']
    reason: AmbientReason
    executor: AnchorPreservationExecutor
  }) => void
}

export interface UseAmbientAnchorPreservationInput {
  ports: AmbientAnchorPorts
  conversationId: string
  firstNewMessageId: string | undefined
  /** The reader is away from the live edge, so there is a reading point worth holding. */
  showScrollToBottom: boolean
  bottomVisibleMessageId: string | null
  messageCount: number
  firstMessageId: string | undefined
  lastMessageId: string | undefined
  interiorPlacementVersion: number
  /** Identity churns with the live window; kept in the effect dependency arrays deliberately. */
  createAnchorPreservationExecutor: (
    loopLabel: AmbientLoopLabel,
  ) => AnchorPreservationExecutor
}

export interface AmbientAnchorPreservation {
  /**
   * Refresh the pre-mutation insertion anchor from a measurement the caller already took, but only
   * while the resident array is unchanged.
   */
  refreshInsertionAnchorIfStable: (
    scroller: HTMLElement,
    measuredAnchor: ScrollAnchor | null,
  ) => void
}

export function useAmbientAnchorPreservation({
  ports,
  conversationId,
  firstNewMessageId,
  showScrollToBottom,
  bottomVisibleMessageId,
  messageCount,
  firstMessageId,
  lastMessageId,
  interiorPlacementVersion,
  createAnchorPreservationExecutor,
}: UseAmbientAnchorPreservationInput): AmbientAnchorPreservation {
  const portsRef = useRef(ports)
  portsRef.current = ports

  const dividerAnchorRef = useRef<ScrollAnchor | null>(null)
  const dividerTrackingRef = useRef({
    conversationId,
    dividerId: firstNewMessageId,
  })

  // Tracked by BOTH ends of the resident array, not by count: at the resident bound `appendLive`
  // trims the oldest row as it inserts, so the count does not change and only the first id moves.
  const insertionAnchorRef = useRef<ScrollAnchor | null>(null)
  const insertionGeometryRef = useRef<ScrollGeometrySample | null>(null)
  const insertionTrackingRef = useRef<ResidentTrackingState>({
    conversationId,
    messageCount,
    firstMessageId,
    lastMessageId,
    interiorPlacementVersion,
  })

  // This render's resident facts, read by the scroll-event path, which runs outside a commit.
  const residentRef = useRef<ResidentTrackingState>({
    conversationId,
    messageCount,
    firstMessageId,
    lastMessageId,
    interiorPlacementVersion,
  })
  residentRef.current = {
    conversationId,
    messageCount,
    firstMessageId,
    lastMessageId,
    interiorPlacementVersion,
  }

  const readGeometry = (scroller: HTMLElement): ScrollGeometrySample => ({
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
  })

  const captureInsertionAnchor = useCallback(
    (scroller: HTMLElement, measuredAnchor?: ScrollAnchor | null) => {
      const geometry = readGeometry(scroller)
      insertionGeometryRef.current = geometry
      if (!insertionAnchorApplies(geometry, AT_BOTTOM_THRESHOLD)) {
        insertionAnchorRef.current = null
        return
      }
      insertionAnchorRef.current =
        measuredAnchor === undefined ? findBottomAnchor(scroller) : measuredAnchor
    },
    [],
  )

  const submitPreservation = useCallback(
    (
      anchor: ScrollAnchor,
      reason: AmbientReason,
      activeConversationId: string,
      executor: AnchorPreservationExecutor,
    ) => {
      runScrollShadowSafely({
        event:
          reason === 'divider-mutation'
            ? 'divider-anchor-preservation'
            : 'insertion-anchor-preservation',
        conversationId: activeConversationId,
        fallback: undefined,
        observe: () => {
          const desired: AnchorPreservationRequest['desired'] = {
            kind: 'anchor',
            messageId: anchor.messageId,
            placement: {
              kind: 'bottom-fraction',
              fraction: messageFraction(anchor.fraction),
            },
          }
          portsRef.current.beginLayoutPreservation({
            conversationId: activeConversationId,
            desired,
            reason,
            executor,
          })
        },
      })
    },
    [],
  )

  // Keep a pre-mutation divider anchor while the reader is scrolled up. On the render where the
  // divider moves, the id mismatch deliberately prevents this effect from replacing the old
  // geometry with a post-mutation measurement.
  useLayoutEffect(() => {
    if (
      !shouldCaptureDividerAnchor({
        tracked: dividerTrackingRef.current,
        conversationId,
        dividerId: firstNewMessageId,
        readerScrolledUp: showScrollToBottom,
      })
    ) {
      return
    }
    const scroller = portsRef.current.getScroller()
    if (!scroller) return
    const anchor = findBottomAnchor(scroller)
    dividerAnchorRef.current = anchor
    portsRef.current.recordBottomAnchor(conversationId, anchor)
  }, [
    bottomVisibleMessageId,
    conversationId,
    firstNewMessageId,
    showScrollToBottom,
  ])

  // Divider mutation may correct immediately before paint when no requested navigation owns the
  // controller; the model rejects it while one is still in flight.
  useLayoutEffect(() => {
    const anchor =
      portsRef.current.getSessionBottomAnchor(conversationId) ??
      dividerAnchorRef.current
    const decision = decideDividerMutation({
      tracked: dividerTrackingRef.current,
      conversationId,
      dividerId: firstNewMessageId,
      readerScrolledUp: showScrollToBottom,
      hasAnchor: Boolean(anchor),
    })
    if (decision.kind === 'unchanged') return
    if (decision.kind === 'reset') {
      dividerTrackingRef.current = { conversationId, dividerId: firstNewMessageId }
      dividerAnchorRef.current = null
      return
    }
    if (decision.kind === 'preserve' && anchor) {
      submitPreservation(
        anchor,
        'divider-mutation',
        conversationId,
        createAnchorPreservationExecutor('divider-anchor'),
      )
    }
    dividerTrackingRef.current = { conversationId, dividerId: firstNewMessageId }
  }, [
    conversationId,
    createAnchorPreservationExecutor,
    firstNewMessageId,
    showScrollToBottom,
    submitPreservation,
  ])

  // No dependency array. The anchor has to survive a virtualizer RE-MEASURE, which re-renders and
  // moves every row's content offset without changing the message identifiers,
  // `bottomVisibleMessageId`, or firing a scroll event. See shouldRecaptureInsertionAnchor.
  useLayoutEffect(() => {
    if (!residentArrayUnchanged(insertionTrackingRef.current, residentRef.current)) {
      return
    }
    const scroller = portsRef.current.getScroller()
    if (!scroller) return
    if (
      !shouldRecaptureInsertionAnchor({
        captured: insertionGeometryRef.current,
        current: readGeometry(scroller),
      })
    ) {
      return
    }
    captureInsertionAnchor(scroller)
  })

  useLayoutEffect(() => {
    const next: ResidentTrackingState = {
      conversationId,
      messageCount,
      firstMessageId,
      lastMessageId,
      interiorPlacementVersion,
    }
    // Declared before the directional restore effect, so an in-flight snapshot is still unrestored
    // here when its load genuinely lands.
    const decision = decideInsertionMutation({
      tracked: insertionTrackingRef.current,
      next,
      directionalLoadLanding: portsRef.current.isDirectionalLoadLanding(
        conversationId,
        firstMessageId ?? '',
      ),
      hasAnchor: Boolean(insertionAnchorRef.current),
    })
    if (decision.kind === 'reset') {
      insertionTrackingRef.current = next
      insertionAnchorRef.current = null
      insertionGeometryRef.current = null
      return
    }
    const anchor = insertionAnchorRef.current
    if (decision.kind === 'preserve' && anchor) {
      submitPreservation(
        anchor,
        'message-insertion',
        conversationId,
        createAnchorPreservationExecutor('insertion-anchor'),
      )
    }
    insertionTrackingRef.current = next
  }, [
    conversationId,
    createAnchorPreservationExecutor,
    firstMessageId,
    interiorPlacementVersion,
    lastMessageId,
    messageCount,
    submitPreservation,
  ])

  const refreshInsertionAnchorIfStable = useCallback(
    (scroller: HTMLElement, measuredAnchor: ScrollAnchor | null) => {
      // The tracked state is the authority here, not a captured render: this runs inside a scroll
      // event, so it must compare against the newest resident facts.
      if (!residentArrayUnchanged(insertionTrackingRef.current, residentRef.current)) {
        return
      }
      captureInsertionAnchor(scroller, measuredAnchor)
    },
    [captureInsertionAnchor],
  )

  return { refreshInsertionAnchorIfStable }
}
