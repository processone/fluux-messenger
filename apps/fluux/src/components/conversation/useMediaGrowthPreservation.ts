/**
 * useMediaGrowthPreservation - one scroll correction per media-load batch
 *
 * Images, videos and link previews change content height when they decode. A batch captures the
 * reader's intent at its START — at the live edge, or reading at a particular anchor — resets a
 * debounce on every subsequent load, and applies exactly one correction once decoding quiesces.
 * Without the batch a run of images produces a run of scroll writes, which is visible as jitter.
 *
 * The hook owns the snapshot and the timer. What a settled batch should do is a pure function in
 * `mediaGrowthDecisions`.
 */

import { useCallback, useRef } from 'react'
import type { ScrollAnchor } from '@/utils/scrollStateManager'
import { findBottomAnchor } from './bottomAnchor'
import {
  decideMediaBatchOutcome,
  isGenuineScrollDuringBatch,
} from './mediaGrowthDecisions'
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
  /** True while a batch is open; the content observer defers to the debounced correction. */
  isBatchActive: () => boolean
  /**
   * Feed a scroll observation to the open batch. Only a genuine reader move counts — media growth
   * fires scroll events of its own.
   */
  observeScroll: (input: {
    controllerOwnsPixels: boolean
    previousScrollHeight: number | null | undefined
    scrollHeight: number
  }) => void
  /** Conversation switch or unmount: drop the batch and its pending timer. */
  cancelBatch: () => void
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

  const observeScroll = useCallback(
    (input: {
      controllerOwnsPixels: boolean
      previousScrollHeight: number | null | undefined
      scrollHeight: number
    }) => {
      const snapshot = snapshotRef.current
      if (!snapshot) return
      if (
        isGenuineScrollDuringBatch({
          batchActive: true,
          controllerOwnsPixels: input.controllerOwnsPixels,
          previousScrollHeight: input.previousScrollHeight,
          scrollHeight: input.scrollHeight,
        })
      ) {
        snapshot.userScrolled = true
      }
    },
    [],
  )

  const handleMediaLoad = useCallback(() => {
    const active = portsRef.current
    const scroller = active.getScroller()
    if (!scroller) return

    // Capture on the first load in the batch (the reader's intent at its start). The anchor is taken
    // BEFORE the media grows the layout, so a scrolled-up reader can be re-pinned once it settles:
    // media above the viewport would otherwise push their position down and out of view.
    if (!snapshotRef.current) {
      snapshotRef.current = {
        wasAtBottom: active.isAtBottom(),
        userScrolled: false,
        anchor: findBottomAnchor(scroller),
      }
      active.log('MEDIA LOAD: batch started', {
        wasAtBottom: snapshotRef.current.wasAtBottom,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
      })
    }

    if (debounceRef.current) clearTimeout(debounceRef.current)

    debounceRef.current = setTimeout(() => {
      const settled = portsRef.current
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

  return { handleMediaLoad, isBatchActive, observeScroll, cancelBatch }
}
