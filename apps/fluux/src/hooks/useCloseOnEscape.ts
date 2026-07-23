import { useEffect } from 'react'

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
 * stacked-overlay behavior. Same-target listeners (e.g. a nested context menu on
 * `document`) are unaffected, so their own Escape handling still works.
 *
 * `enabled` (default `true`) gates the listener for overlays that stay mounted and
 * toggle open/closed via state — dropdown and bottom-sheet menus. Pass the open
 * flag so Escape is consumed ONLY while the overlay is open; when closed the event
 * must flow through untouched (e.g. to the conversation's own Escape handling).
 * Overlays that unmount when closed (lightboxes) can omit it.
 */
export function useCloseOnEscape(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, enabled])
}
