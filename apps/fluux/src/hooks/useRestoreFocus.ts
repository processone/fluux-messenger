import { useEffect, useRef, type RefObject } from 'react'
import { FOCUSABLE_SELECTOR } from './focusable'

/**
 * Keeps keyboard focus inside an open modal/overlay across OS window blur and
 * refocus.
 *
 * WebKit (Tauri) and browser tab-switching reset `document.activeElement` to
 * `<body>` when the app window loses and regains focus. With focus outside the
 * modal, the global keyboard handlers (`useFocusZones`, `useKeyboardShortcuts`)
 * no longer recognise that a modal is open and treat keys as app-level
 * shortcuts again - e.g. ArrowUp/Down move the sidebar selection instead of the
 * command-palette selection. This hook restores focus into the container when
 * the window regains focus, so the modal keeps keyboard control.
 *
 * @param containerRef   The modal/overlay root element.
 * @param initialFocusRef Preferred element to focus when nothing else inside the
 *   modal was focused (e.g. a search input). Falls back to the first focusable
 *   element in the container.
 */
export function useRestoreFocus<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  // The most-recently focused element inside the container, so we restore the
  // user to exactly where they were rather than always jumping to the first field.
  const lastFocusedRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Seed from whatever the modal focused on mount (e.g. via useModalInput).
    if (container.contains(document.activeElement)) {
      lastFocusedRef.current = document.activeElement as HTMLElement
    }

    const focusTarget = (): HTMLElement | null => {
      const last = lastFocusedRef.current
      if (last && container.contains(last)) return last
      if (initialFocusRef?.current) return initialFocusRef.current
      return container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
    }

    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null
      if (target && container.contains(target)) lastFocusedRef.current = target
    }

    const restore = () => {
      // Only reclaim focus if it has escaped the modal; never yank it from an
      // element the user deliberately focused inside.
      if (!container.contains(document.activeElement)) {
        focusTarget()?.focus()
      }
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') restore()
    }

    container.addEventListener('focusin', handleFocusIn)
    window.addEventListener('focus', restore)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      container.removeEventListener('focusin', handleFocusIn)
      window.removeEventListener('focus', restore)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [containerRef, initialFocusRef])
}
