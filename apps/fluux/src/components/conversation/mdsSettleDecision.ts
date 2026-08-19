/**
 * What to do when the unread divider disappears while the conversation is open.
 *
 * Once the divider is removed, the list may still hold the position chosen to show that landmark.
 * Before the reader has moved, settling to the live edge gives that obsolete position a stable
 * replacement.
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
  // present means the position showing it is still valid.
  if (facts.previousDivider === undefined) return 'skip'
  if (facts.currentDivider !== undefined) return 'skip'

  // The reader has taken the list somewhere. An ambient divider removal is not a reason to pull
  // them away from it.
  if (facts.hasGenuineInput) return 'skip'

  return 'settle'
}
