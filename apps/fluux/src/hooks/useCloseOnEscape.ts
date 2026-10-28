import { useEffect, useRef, type RefObject } from 'react'

// Overlays currently listening for Escape, in the order they opened. The last one is on top.
const openOverlays: object[] = []
// Escape presses already given to an overlay, so one press never closes two of them.
const handledEscapes = new WeakSet<Event>()

/**
 * Close an overlay when Escape is pressed, CONSUMING the event so it cannot also
 * trigger the app's window-level keyboard shortcuts.
 *
 * The shortcut layer (useKeyboardShortcuts) listens on `window`; its Escape branch
 * falls through to `onConversationEscape`, which marks the conversation read and
 * calls `scrollToBottom()`. An overlay that closes on Escape via its own document
 * listener but lets the event keep bubbling therefore fires BOTH: it closes AND
 * snaps a reader who had scrolled up into history back to the newest message
 * (the "opening an image resets my scroll position" report).
 *
 * The listener is attached to `document`, which sits inside `window` in the bubble
 * path, so `stopPropagation()` here reliably prevents the window-level handler from
 * also running — the overlay "wins" the Escape, mirroring {@link useFocusTrap}'s
 * stacked-overlay behavior. Other overlays listening on `document` are not stopped by
 * that, so the stack rule below decides which one acts.
 *
 * `enabled` (default `true`) gates the listener for overlays that stay mounted and
 * toggle open/closed via state — dropdown and bottom-sheet menus. Pass the open
 * flag so Escape is consumed ONLY while the overlay is open; when closed the event
 * must flow through untouched (e.g. to the conversation's own Escape handling).
 * Overlays that unmount when closed (lightboxes) can omit it.
 *
 * When overlays are stacked, Escape belongs to the one on top: the one opened last. A
 * context menu opened in the image lightbox closes and the lightbox stays; shortcut help
 * opened over a context menu closes and the menu stays. Each press closes one overlay.
 *
 * For a modal, pass its `data-modal="true"` root as `modalRef`. Only the last
 * such root in document order handles Escape: stacked overlays share a z-index
 * and must mount after the overlay underneath. `stopPropagation()` alone cannot
 * prevent sibling document listeners from closing the rest of the stack.
 */
export function useCloseOnEscape(
  onClose: () => void,
  enabled = true,
  modalRef?: RefObject<HTMLElement | null>,
): void {
  // Read the latest onClose at key time, so a new callback identity never re-registers the
  // overlay and moves it to the top of the stack.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    if (!enabled) return
    const overlay = {}
    openOverlays.push(overlay)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || handledEscapes.has(e)) return
      if (openOverlays[openOverlays.length - 1] !== overlay) return
      if (modalRef) {
        const modals = document.querySelectorAll('[data-modal="true"]')
        if (modals[modals.length - 1] !== modalRef.current) return
      }
      handledEscapes.add(e)
      e.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      openOverlays.splice(openOverlays.indexOf(overlay), 1)
    }
  }, [enabled, modalRef])
}
