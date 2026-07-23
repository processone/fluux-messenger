import { AT_BOTTOM_THRESHOLD, type ScrollAnchor } from '@/utils/scrollStateManager'
import type { MessageVirtualizer } from './messageVirtualizer'
import {
  messageFraction,
  pixelOffset,
  type BottomFractionAnchorPosition,
  type DesiredPosition,
  type EntryPositionFacts,
  type LiveEdgeNavigationFacts,
  type ReachabilityFacts,
} from './scrollPositionModel'

export interface ScrollGeometrySnapshot {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  distanceFromBottom: number
}

export function readScrollGeometry(scroller: Pick<
  HTMLElement,
  'scrollTop' | 'scrollHeight' | 'clientHeight'
>): ScrollGeometrySnapshot {
  const { scrollTop, scrollHeight, clientHeight } = scroller
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    distanceFromBottom: scrollHeight - scrollTop - clientHeight,
  }
}

export function deriveAtLiveEdge(
  geometry: ScrollGeometrySnapshot,
  threshold = AT_BOTTOM_THRESHOLD,
): boolean {
  return geometry.distanceFromBottom < threshold
}

export function deriveEntryPositionFacts(input: {
  syncedLiveEdge: boolean
  savedAnchor: ScrollAnchor | null
  savedOffsetPx: number | null
  firstUnreadMessageId?: string
}): EntryPositionFacts {
  const savedAnchor: BottomFractionAnchorPosition | undefined = input.savedAnchor
    ? {
        kind: 'anchor',
        messageId: input.savedAnchor.messageId,
        placement: {
          kind: 'bottom-fraction',
          fraction: messageFraction(input.savedAnchor.fraction),
        },
      }
    : undefined
  return {
    syncedLiveEdge: input.syncedLiveEdge,
    ...(savedAnchor ? { savedAnchor } : {}),
    ...(input.savedOffsetPx === null
      ? {}
      : { savedOffsetPx: pixelOffset(input.savedOffsetPx) }),
    ...(input.firstUnreadMessageId
      ? { firstUnreadMessageId: input.firstUnreadMessageId }
      : {}),
  }
}

export function deriveLiveEdgeNavigationFacts(input: {
  firstUnreadMessageId?: string
  markerOffsetPx: number | null
  geometry: ScrollGeometrySnapshot
  virtualized: boolean
}): LiveEdgeNavigationFacts {
  const markerNeedsVisit =
    !!input.firstUnreadMessageId &&
    (input.virtualized
      ? input.markerOffsetPx === null ||
        input.markerOffsetPx > input.geometry.scrollTop + input.geometry.clientHeight
      : input.markerOffsetPx !== null &&
        input.markerOffsetPx > input.geometry.scrollTop + input.geometry.clientHeight)
  return {
    ...(input.firstUnreadMessageId
      ? { firstUnreadMessageId: input.firstUnreadMessageId }
      : {}),
    unreadMarkerNeedsVisit: markerNeedsVisit,
    unreadMarkerAlign: input.virtualized ? 'start' : 'top-third',
  }
}

function isVirtualIndexMounted(virtualizer: MessageVirtualizer, index: number): boolean {
  return typeof virtualizer.getVirtualItems === 'function' &&
    virtualizer.getVirtualItems().some((item) => item.index === index)
}

export function deriveTargetReachability(input: {
  messageId: string
  hasRows: boolean
  virtualizer?: MessageVirtualizer
  scroller?: HTMLElement | null
  loadAround: 'available' | 'loading' | 'exhausted' | 'unavailable'
  placementViable?: boolean
}): ReachabilityFacts {
  if (!input.hasRows) return { kind: 'empty-window' }
  const index =
    input.virtualizer &&
    typeof input.virtualizer.getIndexForMessageId === 'function'
      ? input.virtualizer.getIndexForMessageId(input.messageId)
      : null
  if (input.virtualizer) {
    if (index === null) {
      return { kind: 'target-absent', loadAround: input.loadAround }
    }
    return {
      kind: 'available',
      index,
      mounted: isVirtualIndexMounted(input.virtualizer, index),
      placement: input.placementViable === false ? 'use-unavailable-policy' : 'viable',
    }
  }
  const element = input.scroller?.querySelector(
    `[data-message-id="${CSS.escape(input.messageId)}"]`,
  )
  if (!element) return { kind: 'target-absent', loadAround: input.loadAround }
  return {
    kind: 'available',
    index: 0,
    mounted: true,
    placement: input.placementViable === false ? 'use-unavailable-policy' : 'viable',
  }
}

export function deriveGlobalLiveEdgeReachability(input: {
  hasRows: boolean
  windowAtLiveEdge: boolean
  virtualizer?: MessageVirtualizer
  recentering?: boolean
  canRecenter?: boolean
}): ReachabilityFacts {
  if (!input.hasRows) return { kind: 'empty-window' }
  if (!input.windowAtLiveEdge) {
    return {
      kind: 'global-live-edge',
      state: input.recentering
        ? { kind: 'recentering' }
        : input.canRecenter === false
          ? { kind: 'unavailable' }
          : { kind: 'recenter-available' },
    }
  }
  const index = Math.max(0, (input.virtualizer?.itemCount ?? 1) - 1)
  return {
    kind: 'global-live-edge',
    state: {
      kind: 'resident-tail',
      index,
      mounted: input.virtualizer
        ? isVirtualIndexMounted(input.virtualizer, index)
        : true,
    },
  }
}

export function deriveReachabilityForDesired(input: {
  desired: DesiredPosition
  hasRows: boolean
  windowAtLiveEdge: boolean
  virtualizer?: MessageVirtualizer
  scroller?: HTMLElement | null
  loadAround: 'available' | 'loading' | 'exhausted' | 'unavailable'
  canRecenter?: boolean
  legacyOffsetViable?: boolean
}): ReachabilityFacts {
  if (input.desired.kind === 'live-edge') {
    return deriveGlobalLiveEdgeReachability(input)
  }
  if (input.desired.kind === 'anchor' || input.desired.kind === 'message') {
    let placementViable = true
    if (
      input.desired.kind === 'message' &&
      input.desired.align === 'start' &&
      input.scroller
    ) {
      const virtualOffset =
        input.virtualizer &&
        typeof input.virtualizer.getOffsetForMessageId === 'function'
          ? input.virtualizer.getOffsetForMessageId(input.desired.messageId)
          : null
      const offset =
        virtualOffset ??
        (
          input.scroller.querySelector(
            `[data-message-id="${CSS.escape(input.desired.messageId)}"]`,
          ) as HTMLElement | null
        )?.offsetTop ??
        null
      placementViable =
        offset === null || offset > input.scroller.clientHeight / 3
    }
    return deriveTargetReachability({
      messageId: input.desired.messageId,
      hasRows: input.hasRows,
      virtualizer: input.virtualizer,
      scroller: input.scroller,
      loadAround: input.loadAround,
      placementViable,
    })
  }
  if (!input.hasRows) return { kind: 'empty-window' }
  const index = input.desired.kind === 'resident-top' ? 0 : Math.max(
    0,
    (input.virtualizer?.itemCount ?? 1) - 1,
  )
  return {
    kind: 'available',
    index,
    mounted: input.virtualizer
      ? isVirtualIndexMounted(input.virtualizer, index)
      : true,
    placement:
      input.desired.kind === 'legacy-offset' &&
      input.legacyOffsetViable === false
        ? 'use-unavailable-policy'
        : 'viable',
  }
}
