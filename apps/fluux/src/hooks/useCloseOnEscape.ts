import { useEffect, useRef, type RefObject } from 'react'

interface Overlay {
  modalRef?: RefObject<HTMLElement | null>
}

// Overlays currently listening for Escape, in the order they opened. The last one is on top.
const openOverlays: Overlay[] = []
// Escape presses already given to an overlay, so one press never closes two of them.
const handledEscapes = new WeakSet<Event>()

/**
 * The overlay that takes the next Escape: the one opened last. When that one is a modal,
 * the modal drawn on top takes it instead. Modals share a z-index, so the last
 * `data-modal` root in the page is drawn over the others, whatever order they opened in:
 * the startup encryption dialog is drawn over shortcut help opened after it. A modal on
 * top that is not in the stack (it handles Escape itself, or not at all) leaves it to
 * nobody here.
 */
function escapeTarget(): Overlay | undefined {
  const top = openOverlays[openOverlays.length - 1]
  if (!top?.modalRef) return top
  const modals = document.querySelectorAll('[data-modal="true"]')
  const drawnOnTop = modals[modals.length - 1]
  for (let i = openOverlays.length - 1; i >= 0; i--) {
    if (openOverlays[i].modalRef?.current === drawnOnTop) return openOverlays[i]
  }
  return undefined
}

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
 * For a modal, pass its `data-modal="true"` root as `modalRef`. Among modals, the one
 * drawn on top is the last such root in document order, and it takes Escape even when
 * another modal opened after it (see escapeTarget). `stopPropagation()` alone cannot
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
    const overlay: Overlay = { modalRef }
    openOverlays.push(overlay)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || handledEscapes.has(e)) return
      if (escapeTarget() !== overlay) return
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
