import { useLayoutEffect, useRef, type RefObject } from 'react'
import { getFocusableElements } from './focusable'
import {
  focusNextTabStop,
  getComposedActiveElement,
  getComposedFocusableElements,
  getTabStops,
} from './composedFocus'

interface FocusTrapOptions {
  /** Preferred element to focus on open; falls back to the first focusable
   *  element, then the container itself. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Replaces default opener restoration on every effect cleanup, including StrictMode probes. */
  restoreFocus?: (opener: HTMLElement | null) => void
  /** Gate the trap (e.g. an overlay's `open`/`isOpen` flag). Default true. */
  active?: boolean
  /** For menus hosting web components: pick the opening focus through open shadow
   *  roots, skipping inert snapshots, and listen for Tab in the capture phase. */
  includeShadowRoots?: boolean
}

/**
 * Hard focus trap for an open modal / overlay:
 *
 * - moves focus into the container when it opens,
 * - cycles Tab / Shift+Tab within the container so focus never reaches the UI
 *   beneath it,
 * - restores the opener on cleanup by default, or calls the custom restorer;
 *   the caller decides whether that cleanup should move focus.
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
  { initialFocusRef, restoreFocus, active = true, includeShadowRoots = false }: FocusTrapOptions = {},
) {
  const openerRef = useRef<HTMLElement | null>(null)
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
    // A custom restorer can defer focus until explicit close. StrictMode's probe
    // then leaves focus inside the panel, so retain the first captured opener.
    if (previouslyFocused) openerRef.current = previouslyFocused

    // Let the container hold focus itself when it has no focusable children, so
    // focus can never fall through to the page beneath.
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1')

    if (!container.contains(document.activeElement)) {
      const target =
        initialFocusRef?.current ?? focusableElements(container)[0] ?? container
      target.focus({ preventScroll: true })
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // A control inside that already used Tab (a list moving its highlight) keeps focus,
      // and a key that belongs to an IME composition is the input method's.
      if (e.key !== 'Tab' || e.defaultPrevented || e.isComposing || e.keyCode === 229) return
      // WebKit may skip buttons in its native Tab order depending on the OS keyboard
      // preference, so native Tab can leave the trap from any control. The trap owns the
      // complete traversal. A control that uses Tab itself must claim it in the capture
      // phase, because this listener runs before React's bubble handlers.
      e.preventDefault()
      const activeEl = getComposedActiveElement()
      if (!focusNextTabStop(getTabStops(container, activeEl), activeEl, e.shiftKey)) container.focus()
    }

    // Shadow-aware menus host widgets (the emoji picker) that may stop Tab
    // before it bubbles, so they listen in the capture phase. Other traps keep
    // the bubble phase so a nested inner trap wraps before its outer trap.
    const capture = includeShadowRoots
    container.addEventListener('keydown', handleKeyDown, capture)

    return () => {
      container.removeEventListener('keydown', handleKeyDown, capture)
      if (restoreFocus) restoreFocus(openerRef.current)
      else if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true })
    }
  }, [containerRef, initialFocusRef, restoreFocus, active, includeShadowRoots])
}
