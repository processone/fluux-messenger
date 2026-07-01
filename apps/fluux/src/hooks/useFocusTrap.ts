import { useLayoutEffect, type RefObject } from 'react'
import { getFocusableElements } from './focusable'

interface FocusTrapOptions {
  /** Preferred element to focus on open; falls back to the first focusable
   *  element, then the container itself. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Gate the trap (e.g. an overlay's `open`/`isOpen` flag). Default true. */
  active?: boolean
}

/**
 * Hard focus trap for an open modal / overlay:
 *
 * - moves focus into the container when it opens,
 * - cycles Tab / Shift+Tab within the container so focus never reaches the UI
 *   beneath it,
 * - returns focus to the element that was focused before it opened, on close.
 *
 * The keydown listener is attached to the container (not `document`), so a
 * stacked overlay wins automatically: the lower overlay's container never
 * receives the event because focus lives in the top one.
 *
 * Complements {@link useRestoreFocus}, which reclaims focus across OS window
 * blur; this hook owns entering and leaving the trap.
 */
export function useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  { initialFocusRef, active = true }: FocusTrapOptions = {},
) {
  useLayoutEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    // Captured before we move focus, so we can restore the opener on close.
    const previouslyFocused =
      document.activeElement instanceof HTMLElement &&
      !container.contains(document.activeElement)
        ? document.activeElement
        : null

    // Let the container hold focus itself when it has no focusable children, so
    // focus can never fall through to the page beneath.
    if (!container.hasAttribute('tabindex')) container.tabIndex = -1

    if (!container.contains(document.activeElement)) {
      const target =
        initialFocusRef?.current ?? getFocusableElements(container)[0] ?? container
      target.focus()
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const focusables = getFocusableElements(container)
      if (focusables.length === 0) {
        e.preventDefault()
        container.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const activeEl = document.activeElement
      if (e.shiftKey && activeEl === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault()
        first.focus()
      }
    }

    container.addEventListener('keydown', handleKeyDown)

    return () => {
      container.removeEventListener('keydown', handleKeyDown)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [containerRef, initialFocusRef, active])
}
