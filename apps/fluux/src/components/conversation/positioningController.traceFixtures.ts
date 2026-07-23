/**
 * Normalized semantic captures from real scroll traces.
 *
 * The raw traces contain timing, DOM, and paint data that the semantic controller deliberately
 * does not consume. These fixtures retain only the facts presented at each arbitration seam.
 */
export const recordedPositioningTraces = {
  savedRestoreThenOutgoing: {
    provenance:
      'Safari room-switch trace, 2026-07-23: RESTORE via virtualizer index before restore-anchor rAF settle',
    conversationId: 'fluux-messenger@conference.process-one.net',
    messageCount: 100,
    savedOffsetPx: 4949,
    anchor: {
      messageId: 'f863062b-c179-49e4-956c-d12ab4c5f60b',
      fraction: 0.9257401714932859,
      index: 41,
    },
  },
  mediaThenOutgoing: {
    provenance:
      'scroll-invariants invariant-11: media batch preserves stress-0-33 while scrolled up',
    conversationId: 'stress-0@conference.fluux.chat',
    anchor: {
      messageId: 'stress-0-33',
      fraction: 0.75,
      index: 33,
    },
  },
  syncedLiveEdgeEntry: {
    provenance:
      'useMessageListScroll synced-live-edge entry scenario: resolved remote pointer equals resident tail before entry arbitration',
    conversationId: 'synced-live-edge',
    savedOffsetPx: 200,
    savedAnchor: {
      messageId: 'msg-5',
      fraction: 1,
    },
    firstUnreadMessageId: 'msg-6',
  },
} as const
