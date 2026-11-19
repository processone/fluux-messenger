import { useCallback, useEffect, useRef } from 'react'
import { markUserScrollIntent } from '../utils/scrollbarReveal'

/** How soon after an Up/Down key a selection scroll still counts as that key's doing. */
const KEY_TO_SCROLL_MS = 200

/**
 * For a popover whose selection is moved by a key handler elsewhere (the composer's
 * completion menus keep focus in the text field). Returns a function to call just
 * before scrolling the selected option: it claims the scroll for the option's own
 * scroll boxes only when an Up/Down key just moved the selection, so a selection
 * reset while typing does not reveal the thumb.
 */
export function useKeyboardScrollClaim(): (selected: Element | null | undefined) => void {
  const lastKeyAt = useRef(-Infinity)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') lastKeyAt.current = performance.now()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])
  return useCallback((selected) => {
    if (performance.now() - lastKeyAt.current < KEY_TO_SCROLL_MS) markUserScrollIntent(selected)
  }, [])
}
