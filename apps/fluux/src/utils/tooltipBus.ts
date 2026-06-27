/**
 * Tiny global bus to dismiss every visible (or pending) tooltip at once.
 *
 * Tooltips portal to `document.body` at a very high z-index (see Tooltip.tsx),
 * so a tooltip left hovering over the UI floats ABOVE modals like the Cmd-K
 * command palette. Keyboard-opened modals never fire the pointerdown/blur that
 * would otherwise dismiss a tooltip, so we dismiss them explicitly the moment a
 * modal opens (see modalStore.ts).
 *
 * A DOM CustomEvent keeps the contract decoupled: the modal store dispatches,
 * each Tooltip instance listens — neither imports the other.
 */
const DISMISS_TOOLTIPS_EVENT = 'fluux:dismiss-tooltips'

/** Ask every mounted Tooltip to hide itself (and cancel any pending show). */
export function dismissAllTooltips(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(DISMISS_TOOLTIPS_EVENT))
}

/** Subscribe to the dismiss signal. Returns an unsubscribe function. */
export function onDismissAllTooltips(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(DISMISS_TOOLTIPS_EVENT, handler)
  return () => window.removeEventListener(DISMISS_TOOLTIPS_EVENT, handler)
}
