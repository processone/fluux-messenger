/**
 * Decides whether the room message area should show its full-view loading
 * indicator (the centered spinner) rather than message content or an empty state.
 *
 * There are two distinct "still loading" phases when entering a room, and only
 * the first one used to be covered:
 *
 *   1. Joining — presence sent, waiting for the server's self-presence (status
 *      110). `isJoining` is true, `joined` is false.
 *   2. First catch-up — the room is joined (the "Joining…" spinner is gone), but
 *      MAM history is still being fetched and there is nothing cached to render.
 *      Without this, the view fell through to the "No messages" empty state while
 *      messages were actively loading, reading as a silent, animation-less wait.
 *
 * Once any message is on screen (cache hit), the inline gap marker / older-history
 * spinner owns the catch-up affordance, so the full-view loader steps aside.
 */
export function selectRoomInitialLoading(args: {
  isJoining: boolean
  joined: boolean
  isCatchingUp: boolean
  messageCount: number
}): boolean {
  const { isJoining, joined, isCatchingUp, messageCount } = args

  // Phase 1: still joining.
  if (isJoining && !joined) return true

  // Phase 2: joined, first history fetch in flight, nothing to show yet.
  if (joined && isCatchingUp && messageCount === 0) return true

  return false
}
