/**
 * What to do when the unread divider disappears while the conversation is open.
 *
 * XEP-0490 read positions arrive from other devices after the conversation has already been
 * rendered. When one lands past the divider, the store clears it: the boundary the reader was
 * looking at no longer exists, and the list is left holding a position that was chosen to show it.
 * Settling to the live edge is the only position that still means anything.
 *
 * This is ambient — the reader did not ask for it — so it must not run when they have moved the
 * list themselves, and it must not fire on a conversation switch, where the previous conversation's
 * divider says nothing about this one.
 */
export type MdsSettleDecision = 'settle' | 'skip'

export interface MdsSettleFacts {
  /** The list is rendered without a positioning owner (previews, selection surfaces). */
  staticMode: boolean
  /** The previous render was the SAME conversation, so its divider is comparable. */
  sameConversation: boolean
  /** Divider at the previous render. */
  previousDivider: string | undefined
  /** Divider now. */
  currentDivider: string | undefined
  /**
   * The reader has scrolled, wheeled or keyed this conversation themselves.
   *
   * Genuine input, not any scroll event: the list's own corrections produce scroll events too, and
   * treating those as the reader would make an ambient settle cancel itself.
   */
  hasGenuineInput: boolean
}

export function decideMdsSettle(facts: MdsSettleFacts): MdsSettleDecision {
  if (facts.staticMode) return 'skip'

  // A conversation switch rebaselines. The divider that vanished belonged to the conversation being
  // left, and settling the newly-entered one to its bottom would override its own entry position.
  if (!facts.sameConversation) return 'skip'

  // The edge is present -> absent. No divider before means nothing was cleared; a divider still
  // present means the read-sync has not superseded it, and the position showing it is still right.
  if (facts.previousDivider === undefined) return 'skip'
  if (facts.currentDivider !== undefined) return 'skip'

  // The reader has taken the list somewhere. A late marker from another device is not a reason to
  // pull them away from it.
  if (facts.hasGenuineInput) return 'skip'

  return 'settle'
}
