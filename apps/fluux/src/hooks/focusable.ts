// Tab-order focusable elements, excluding programmatically-removed ones.
export const FOCUSABLE_SELECTOR =
  'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), ' +
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Focusable descendants of `container`, in DOM (tab) order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getAttribute('tabindex') !== '-1'
  )
}
