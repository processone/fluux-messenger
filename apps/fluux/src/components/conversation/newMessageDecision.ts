/**
 * What a commit carrying a new bottom row means for the reading position.
 *
 * This is the decision, separated from carrying it out. The scroll hook used to reach the same
 * conclusion inside nested conditions in an effect, reading refs as it went, which is why it
 * could only be exercised by rendering a list and why the same "is this our own send?" branch
 * appeared three times.
 *
 * The rules, in the order they apply:
 *
 * 1. While a saved position or a directional history restore is still waiting to land, the
 *    window is not ours to move — except for the reader's own send, which always wins.
 * 2. A new bottom row follows the live edge when the reader is already there, or when they sent
 *    it. An incoming message while scrolled up never yanks them.
 * 3. "New bottom row" keys off the last message id as well as the count: a send REPLACES the
 *    optimistic row in place when it reconciles to its server id, growing nothing.
 * 4. A bottom row the resident window's slide brought in is not an arrival. Past the window bound
 *    a load trims the far end, so the bottom row changes with nothing sent or received. While the
 *    window is off the live edge the store holds live messages out of it, and a window that just
 *    came back to the live edge came back by a load — so a changed bottom row on either side of a
 *    slide is the slide. Following it pinned the reader to the bottom of a window slid back into
 *    history, which loaded newer history until the window snapped back to the newest messages.
 *
 * @module Components/Conversation/NewMessageDecision
 */

/** Everything the decision reads. Nothing here is a ref or a DOM measurement. */
export interface NewMessageFacts {
  messageCount: number
  /** What an arrival is measured against — re-based whenever rows change for another reason. */
  baselineMessageCount: number
  lastMessageId: string | undefined
  baselineLastMessageId: string | undefined
  /** The reader sent it. Their own message is followed from anywhere in the history. */
  lastMessageIsOutgoing: boolean
  /** Whether the viewport is showing the newest message right now. */
  atBottom: boolean
  /** A controller-owned restore of a saved position has not landed yet. */
  savedPositionPending: boolean
  /** A controller-owned directional (prepend) restore has not landed yet. */
  directionalHistoryPending: boolean
  /** Whether the resident window holds the newest message of the conversation now. */
  windowAtLiveEdge: boolean
  /** Whether it did when the baseline was taken. */
  baselineWindowAtLiveEdge: boolean
}

export type NewMessageDecision =
  /** Own send while a saved position is still landing: go to the edge, and stop claiming it. */
  | 'outgoing-during-restore'
  /** A saved position is still landing: leave it alone, and stop claiming the edge. */
  | 'restore-pending'
  /** Own send while a prepend restore is still landing: go to the edge. */
  | 'outgoing-during-prepend'
  /** A prepend restore is still landing: leave it alone. */
  | 'prepend-pending'
  /** The reader's own message arrived: follow it wherever they were. */
  | 'follow-outgoing'
  /** The reader is at the edge and a message arrived: keep them there. */
  | 'follow-incoming'
  /** A message arrived while the reader is scrolled up: do not move them. */
  | 'hold-incoming'
  /**
   * The resident window slid, carrying a different bottom row with it: nothing arrived. The load
   * that slid it owns the reading position.
   */
  | 'window-slid'
  /**
   * The effect ran without a new bottom row. Named rather than silent: it is the blind spot
   * behind "I sent a message and it did not scroll", where the row's props had not propagated
   * yet, and a trace that says nothing cannot distinguish that from a decision.
   */
  | 'no-bottom-row'

export function decideOnNewMessage(facts: NewMessageFacts): NewMessageDecision {
  const windowSlid = !facts.windowAtLiveEdge || !facts.baselineWindowAtLiveEdge
  // A send can only reach a window at the live edge: off it, an outgoing bottom row is history.
  const ownSend = facts.lastMessageIsOutgoing && !windowSlid

  if (facts.savedPositionPending) {
    return ownSend ? 'outgoing-during-restore' : 'restore-pending'
  }
  if (facts.directionalHistoryPending) {
    return ownSend ? 'outgoing-during-prepend' : 'prepend-pending'
  }

  const countIncreased = facts.messageCount > facts.baselineMessageCount
  const lastMessageChanged =
    facts.lastMessageId !== undefined && facts.lastMessageId !== facts.baselineLastMessageId
  if (!countIncreased && !lastMessageChanged) return 'no-bottom-row'
  if (windowSlid) return 'window-slid'

  if (ownSend) return 'follow-outgoing'
  return facts.atBottom ? 'follow-incoming' : 'hold-incoming'
}
