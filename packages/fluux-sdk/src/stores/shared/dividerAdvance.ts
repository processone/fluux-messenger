/**
 * Moving the new-message divider forward on evidence that the reader already read past it.
 *
 * Scrolling this view is navigation: it advances the read pointer but leaves the line where the
 * view opened. A read marker published by ANOTHER of the user's clients is a different kind of
 * fact — it states that those messages were read, elsewhere — so the line follows it rather than
 * standing in front of messages the reader has already seen.
 *
 * Three rules the callers depend on:
 *
 * - never create. A divider that is not parked stays absent, so a marker cannot resurrect one the
 *   reader deliberately cleared.
 * - never clear. A pointer that has caught up is not a reason to retire the landmark; removing it
 *   belongs to read-through scroll, Esc, mark-all-read and deactivation.
 * - never backward, and never on a guess. Both ends must be present in the resident slice: an index
 *   comparison with one end missing cannot order them, and a marker whose target is outside the
 *   window says nothing about where the line should sit.
 */
export function advanceDividerToRemoteRead(
  parkedDivider: string | undefined,
  remoteDivider: string | undefined,
  messages: readonly { id: string }[],
): string | undefined {
  if (parkedDivider === undefined) return undefined
  if (remoteDivider === undefined || remoteDivider === parkedDivider) return parkedDivider

  const parkedIndex = messages.findIndex((message) => message.id === parkedDivider)
  const remoteIndex = messages.findIndex((message) => message.id === remoteDivider)
  if (parkedIndex === -1 || remoteIndex === -1) return parkedDivider

  return remoteIndex > parkedIndex ? remoteDivider : parkedDivider
}
