/**
 * useMediaGrowthPreservation - debounce media-load reconciliation requests
 *
 * The hook owns the pending snapshot and timer; the controller owns the resulting reconciliation.
 * Batch outcomes live in `mediaGrowthDecisions`; anchor lifecycle and takeover follow
 * docs/2026-07-23-scroll-positioning-contract.md.
 */

import { useCallback, useRef } from 'react'
import type { ScrollAnchor } from '@/utils/scrollStateManager'
import { decideMediaBatchOutcome } from './mediaGrowthDecisions'
import { runScrollShadowSafely } from './scrollPositionShadow'
import { messageFraction, type AnchorPreservationRequest } from './scrollPositionModel'
import type { AnchorPreservationExecutor } from './positioningController'

/** Debounce window for batching media load events. */
export const MEDIA_LOAD_DEBOUNCE_MS = 150

interface MediaBatchSnapshot {
  wasAtBottom: boolean
  userScrolled: boolean
  anchor: ScrollAnchor | null
}

export interface MediaGrowthPorts {
  getScroller: () => HTMLElement | null
  observeViewportGeometry: () => void
  getSessionBottomAnchor: (conversationId: string) => ScrollAnchor | null
  getCurrentBottomAnchor: () => ScrollAnchor | null
  getPendingLayoutAdjustment: (conversationId: string) => number
  isAtBottom: () => boolean
  reconcileLiveEdge: (trigger: string, rearmEligibleFromGeometry: boolean) => void
  beginMediaPreservation: (input: {
    conversationId: string
    desired: AnchorPreservationRequest['desired']
    executor: AnchorPreservationExecutor
  }) => void
  log: (action: string, data?: Record<string, unknown>) => void
}

export interface UseMediaGrowthPreservationInput {
  ports: MediaGrowthPorts
  conversationId: string
  /** Identity churns with the live window; kept in the callback dependencies deliberately. */
  createAnchorPreservationExecutor: (
    loopLabel: 'media-anchor',
  ) => AnchorPreservationExecutor
}

export interface MediaGrowthPreservation {
  /** A media element finished decoding. Starts or extends the current batch. */
  handleMediaLoad: () => void
  /** True while a batch is open; ordinary live-edge growth defers to its debounced correction. */
  isBatchActive: () => boolean
  /**
   * Consume the viewport session's movement verdict; content-height changes do not invalidate it.
   */
  observeScroll: (userDelta: number) => void
  /** Drop the captured anchor and pending timer when their ownership ends. */
  cancelBatch: () => void
  rebaseAnchor: (anchor: ScrollAnchor | null) => void
}

export function useMediaGrowthPreservation({
  ports,
  conversationId,
  createAnchorPreservationExecutor,
}: UseMediaGrowthPreservationInput): MediaGrowthPreservation {
  const portsRef = useRef(ports)
  portsRef.current = ports

  const snapshotRef = useRef<MediaBatchSnapshot | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelBatch = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    snapshotRef.current = null
  }, [])

  const isBatchActive = useCallback(() => snapshotRef.current !== null, [])

  const observeScroll = useCallback((userDelta: number) => {
    const snapshot = snapshotRef.current
    if (snapshot && userDelta !== 0) snapshot.userScrolled = true
  }, [])

  const rebaseAnchor = useCallback((anchor: ScrollAnchor | null) => {
    if (snapshotRef.current) snapshotRef.current.anchor = anchor
  }, [])

  const handleMediaLoad = useCallback(() => {
    const active = portsRef.current
    const scroller = active.getScroller()
    if (!scroller) return
    const pendingLayoutAdjustmentBefore = active.getPendingLayoutAdjustment(conversationId)
    active.observeViewportGeometry()

    if (!snapshotRef.current) {
      const sessionAnchor = active.getSessionBottomAnchor(conversationId)
      const currentAnchor = active.getCurrentBottomAnchor()
      const pendingLayoutAdjustmentAfter = active.getPendingLayoutAdjustment(conversationId)
      const layoutChangedDuringCapture =
        pendingLayoutAdjustmentAfter !== pendingLayoutAdjustmentBefore
      const anchor = layoutChangedDuringCapture
        ? sessionAnchor ?? currentAnchor
        : currentAnchor ?? sessionAnchor
      snapshotRef.current = {
        wasAtBottom: active.isAtBottom(),
        userScrolled: false,
        anchor,
      }
      active.log('MEDIA LOAD: batch started', {
        currentAnchorId: currentAnchor?.messageId,
        pendingLayoutAdjustmentBefore,
        pendingLayoutAdjustmentAfter,
        layoutChangedDuringCapture,
        wasAtBottom: snapshotRef.current.wasAtBottom,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        anchorId: anchor?.messageId,
        sessionAnchorId: sessionAnchor?.messageId,
      })
    }

    if (debounceRef.current) clearTimeout(debounceRef.current)

    debounceRef.current = setTimeout(() => {
      const settled = portsRef.current
      settled.observeViewportGeometry()
      const currentScroller = settled.getScroller()
      const snapshot = snapshotRef.current
      if (!currentScroller || !snapshot) return

      const { wasAtBottom, userScrolled, anchor } = snapshot
      const outcome = decideMediaBatchOutcome({
        wasAtBottom,
        userScrolled,
        hasAnchor: Boolean(anchor),
      })

      if (outcome.kind === 'live-edge') {
        settled.log('MEDIA LOAD: batch complete, scrolling to bottom', {
          wasAtBottom,
          userScrolled,
          scrollHeight: currentScroller.scrollHeight,
        })
        settled.reconcileLiveEdge('media-load', wasAtBottom && !userScrolled)
      } else if (outcome.kind === 'preserve-anchor' && anchor) {
        // Media that decoded ABOVE the viewport grew the content and pushed the reading position
        // down. Re-pin to the anchor captured BEFORE the growth so the reader stays put. Mirrors
        // live-edge reconciliation, but for a held position.
        runScrollShadowSafely({
          event: 'media-preservation',
          conversationId,
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
            settled.beginMediaPreservation({
              conversationId,
              desired,
              executor: createAnchorPreservationExecutor('media-anchor'),
            })
          },
        })
        settled.log('MEDIA LOAD: batch complete, re-anchoring scrolled-up position', {
          wasAtBottom,
          anchorId: anchor.messageId,
        })
      } else {
        settled.log('MEDIA LOAD: batch complete, no correction', {
          wasAtBottom,
          userScrolled,
          outcome: outcome.kind,
        })
      }

      snapshotRef.current = null
      debounceRef.current = null
    }, MEDIA_LOAD_DEBOUNCE_MS)
  }, [conversationId, createAnchorPreservationExecutor])

  return { handleMediaLoad, isBatchActive, observeScroll, cancelBatch, rebaseAnchor }
}
