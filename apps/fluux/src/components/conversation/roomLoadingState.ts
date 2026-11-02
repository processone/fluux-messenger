/** Membership presentation is derived from SDK state; confirmed membership wins. */
export function selectRoomMembershipPhase({ joined, isJoining }: {
  joined?: boolean
  isJoining?: boolean
}): 'joined' | 'joining' | 'not-joined' {
  if (joined) return 'joined'
  return isJoining ? 'joining' : 'not-joined'
}

/**
 * Only an uncached first history fetch replaces the room reading area.
 * Joining is presented in the footer, so cached history remains readable.
 * With cached messages, inline history indicators own the catch-up affordance.
 */
export function selectRoomInitialLoading(args: {
  joined: boolean
  isCatchingUp: boolean
  messageCount: number
}): boolean {
  const { joined, isCatchingUp, messageCount } = args
  return joined && isCatchingUp && messageCount === 0
}
