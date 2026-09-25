import { FOCUSABLE_SELECTOR } from './focusable'

/** Focus order for touch menus containing inert message snapshots and web components. */
export function getComposedFocusableElements(container: HTMLElement): HTMLElement[] {
  const result: HTMLElement[] = []
  const visit = (parent: HTMLElement | ShadowRoot) => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement)) continue
      const style = getComputedStyle(child)
      if (child.inert || child.hasAttribute('inert') || child.hidden || style.display === 'none' || style.visibility === 'hidden') continue
      if (child.matches(FOCUSABLE_SELECTOR) && child.getAttribute('tabindex') !== '-1') result.push(child)
      visit(child.shadowRoot ?? child)
    }
  }
  visit(container)
  return result
}

export function getComposedActiveElement(): Element | null {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active
}
