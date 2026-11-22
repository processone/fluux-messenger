import { useEffect, useMemo, useRef, type RefObject } from 'react'
import type { MessageListHandle } from '@/components/conversation/messageListBoundary'
import { registerViewportBottomRef, type ViewportKind } from '@/utils/viewportAtBottom'
import { registerViewportScroller } from '@/utils/viewportScroller'

/**
 * Owns a view's command handle to its message list and publishes what the list knows to the
 * global readers that have no React path to it.
 *
 * The view passes `handleRef` to `MessageList` and uses it to issue commands; the list fills it
 * in while mounted. The same handle answers whether the viewport is showing the newest message,
 * and this hook publishes that answer under whichever entity is active — so
 * `useWindowVisibility` can read it on focus regain, telling a reader who is genuinely looking at
 * the newest message from a view merely parked at the live edge (issue #1076). Keeping creation
 * and registration in one call is the point: a view that forgets the effect leaves the global
 * reader answering `false` forever.
 *
 * Nothing here exposes the scroll element or the at-bottom flag: both stay inside the list.
 * While no list is mounted the answer is `false`, because a read position must never be invented
 * for a view we cannot see.
 */
export function useMessageListHandle(
  kind: ViewportKind,
  id: string | undefined,
): RefObject<MessageListHandle | null> {
  const handleRef = useRef<MessageListHandle | null>(null)

  // The registry reads `.current` of whatever it is given. Hand it a view of the handle rather
  // than the handle ref itself, so the boolean answer is computed at read time.
  const bottomRef = useMemo(() => ({
    get current(): boolean { return handleRef.current?.isAtBottom() ?? false },
  }), [])

  useEffect(() => {
    if (!id) return
    return registerViewportBottomRef(kind, id, bottomRef)
  }, [kind, id, bottomRef])

  // Dev-only: lets a detector measure the viewport WITHOUT going through the scroll hook's own
  // at-bottom state, which is exactly the value under suspicion when the list and its
  // affordances disagree. Not consumed in release builds.
  useEffect(() => {
    if (!__FLUUX_ANOMALY__) return
    if (!id) return
    return registerViewportScroller(kind, id, handleRef)
  }, [kind, id])

  return handleRef
}
