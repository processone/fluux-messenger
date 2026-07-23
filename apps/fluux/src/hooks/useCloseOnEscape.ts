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
 */
export function useCloseOnEscape(onClose: () => void): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])
}
