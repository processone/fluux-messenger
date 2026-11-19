import { useCallback, useRef } from 'react'
import { markUserScrollIntent } from '../utils/scrollbarReveal'

/**
 * For a popover whose selection is moved by a key handler elsewhere (the composer's
 * completion menus keep focus in the text field). The handler counts its Up/Down
 * moves in `navSerial`; the returned function, called just before scrolling the
 * selected option, claims that option's scroll boxes only when the count has grown
 * since the last call. A selection reset (typing, dismissal) leaves the count alone
 * or lowers it, so it claims nothing, however soon after an arrow key it happens.
 */
export function useKeyboardScrollClaim(navSerial = 0): (selected: Element | null | undefined) => void {
  const seen = useRef(navSerial)
  return useCallback(
    (selected) => {
      const handled = navSerial > seen.current
      seen.current = navSerial
      if (handled) markUserScrollIntent(selected)
    },
    [navSerial],
  )
}
