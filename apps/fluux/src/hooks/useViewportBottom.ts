import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { registerViewportBottomRef, type ViewportKind } from '@/utils/viewportAtBottom'

export interface ViewportBottom {
  /**
   * The living value. `useMessageListScroll` maintains it as the reader scrolls; everything
   * else reads it. It is a ref rather than state because the scroll hook writes it many times
   * per gesture and nobody should re-render for that.
   */
  ref: MutableRefObject<boolean>
  /**
   * A decision moved the reader — a keyboard jump away from the newest message, say. It reports
   * nothing: only a measured geometry read may become viewport evidence, because that evidence
   * advances a read pointer that never moves back.
   */
  assume(atBottom: boolean): void
}

/**
 * Owns a view's at-bottom state: whether its viewport is currently showing the newest message.
 *
 * The view holds one value for as long as it is mounted, and publishes it to the registry under
 * whichever entity is active — so `useWindowVisibility` can read it on focus regain without a
 * React path to this component. Keeping creation, registration and cleanup in one call is the
 * point: a view that forgets the effect leaves the global reader answering `false` forever.
 *
 * The value deliberately does NOT reset per entity. The scroll hook's entry arbitration decides
 * where a newly opened conversation starts, and a per-entity memory here would answer that same
 * question a second time from a reading taken before the switch.
 */
export function useViewportBottom(
  kind: ViewportKind,
  id: string | undefined,
  initial = true,
): ViewportBottom {
  const ref = useRef(initial)

  useEffect(() => {
    if (!id) return
    return registerViewportBottomRef(kind, id, ref)
  }, [kind, id])

  const assume = useCallback((atBottom: boolean) => { ref.current = atBottom }, [])

  return useMemo(() => ({ ref, assume }), [assume])
}
