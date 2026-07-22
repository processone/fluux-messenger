/**
 * Viewport-at-bottom registry.
 *
 * `windowAtLiveEdge` (SDK) says where the *loaded message window* sits; it is true
 * for any backgrounded conversation parked at the tail, because that is how the
 * window is built. It is therefore NOT evidence that the user saw anything.
 *
 * The only real evidence is the scroll viewport: is the newest message actually on
 * screen? That truth lives in `isAtBottomRef`, a ref owned by ChatView/RoomView and
 * maintained by `useMessageListScroll`. `useWindowVisibility` is a global hook with
 * no access to it, so the views register their ref here and it reads it on focus
 * regain — mirroring Gajim's `view_is_at_bottom()` gate on the same transition.
 *
 * The ref OBJECT is registered, not its value: the scroll hook mutates
 * `.current` from ~24 call sites, and reading through the ref means none of them
 * need to notify anyone.
 *
 * Unknown id → `false`. A read position must never be invented for a view we
 * cannot see.
 */

export type ViewportKind = 'conversation' | 'room'

interface BooleanRef {
  current: boolean
}

const refs = new Map<string, BooleanRef>()

function key(kind: ViewportKind, id: string): string {
  return `${kind}:${id}`
}

/**
 * Register a view's at-bottom ref. Returns an unregister function for effect
 * cleanup. Re-registering the same key replaces the previous ref (view remount).
 */
export function registerViewportBottomRef(kind: ViewportKind, id: string, ref: BooleanRef): () => void {
  const k = key(kind, id)
  refs.set(k, ref)
  return () => {
    // Only drop it if we still own the slot — a remount may have replaced it.
    if (refs.get(k) === ref) refs.delete(k)
  }
}

/** Is this view's viewport currently showing the newest message? */
export function isViewportAtBottom(kind: ViewportKind, id: string): boolean {
  return refs.get(key(kind, id))?.current ?? false
}

/** Test-only: drop all registrations. */
export function _resetViewportRegistryForTesting(): void {
  refs.clear()
}
