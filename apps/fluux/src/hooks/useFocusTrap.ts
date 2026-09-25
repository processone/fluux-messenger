import { useLayoutEffect, type RefObject } from 'react'
import { getFocusableElements } from './focusable'
import { getComposedActiveElement, getComposedFocusableElements } from './composedFocus'

interface FocusTrapOptions {
  /** Preferred element to focus on open; falls back to the first focusable
   *  element, then the container itself. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Gate the trap (e.g. an overlay's `open`/`isOpen` flag). Default true. */
  active?: boolean
  /** Include open shadow roots and skip inert snapshots in touch menus. */
  includeShadowRoots?: boolean
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
  { initialFocusRef, active = true, includeShadowRoots = false }: FocusTrapOptions = {},
) {
  useLayoutEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    const focusableElements = includeShadowRoots ? getComposedFocusableElements : getFocusableElements

    // Captured before we move focus, so we can restore the opener on close.
    const previouslyFocused =
      document.activeElement instanceof HTMLElement &&
      !container.contains(document.activeElement)
        ? document.activeElement
        : null

    // Let the container hold focus itself when it has no focusable children, so
    // focus can never fall through to the page beneath.
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1')

    if (!container.contains(document.activeElement)) {
      const target =
        initialFocusRef?.current ?? focusableElements(container)[0] ?? container
      target.focus({ preventScroll: true })
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const focusables = focusableElements(container)
      if (focusables.length === 0) {
        e.preventDefault()
        container.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const activeEl = includeShadowRoots ? getComposedActiveElement() : document.activeElement
      if (includeShadowRoots) {
        // WebKit may skip buttons in its native Tab order depending on the OS
        // keyboard preference. A modal menu owns the complete traversal.
        e.preventDefault()
        const index = focusables.indexOf(activeEl as HTMLElement)
        const next = index < 0 ? (e.shiftKey ? focusables.length - 1 : 0)
          : (index + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length
        focusables[next].focus()
      } else if (e.shiftKey && activeEl === first) {
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
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true })
    }
  }, [containerRef, initialFocusRef, active, includeShadowRoots])
}
