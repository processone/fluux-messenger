import { useCallback, useRef, useState } from 'react'

/** Exit animation duration. Matches --fluux-duration-fast in index.css. */
export const MODAL_EXIT_MS = 150

/** Whether motion should be suppressed: explicit data-motion wins, else the OS query. */
function isReducedMotion(): boolean {
  const attr = document.documentElement.getAttribute('data-motion')
  if (attr === 'reduced') return true
  if (attr === 'full') return false
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

interface ModalTransitionOptions {
  /** Override the enter animation class (e.g. the command palette's drop). */
  panelInClass?: string
}

/**
 * Drives a modal's enter and exit animation. The panel and scrim get enter
 * classes on mount; `requestClose` swaps to the exit classes, then calls the
 * caller's `onClose` after the exit animation (so the parent unmounts on
 * schedule). When motion is reduced the exit is skipped and onClose fires at
 * once. A double close fires onClose only once.
 */
export function useModalTransition(options?: ModalTransitionOptions) {
  const [isClosing, setIsClosing] = useState(false)
  const closingRef = useRef(false)

  const requestClose = useCallback((onClose: () => void) => {
    if (closingRef.current) return
    closingRef.current = true
    if (isReducedMotion()) {
      onClose()
      return
    }
    setIsClosing(true)
    setTimeout(onClose, MODAL_EXIT_MS)
  }, [])

  const panelClass = isClosing ? 'modal-panel-out' : (options?.panelInClass ?? 'modal-panel-in')
  const scrimClass = isClosing ? 'scrim-out' : 'scrim-in'

  return { panelClass, scrimClass, isClosing, requestClose }
}
