import { FOCUSABLE_SELECTOR } from './focusable'

// Controls Tab reaches natively but focus should not land on when an overlay opens.
const TAB_STOP_SELECTOR = `${FOCUSABLE_SELECTOR}, details > summary:first-of-type, ` +
  '[contenteditable]:not([contenteditable="false"]), audio[controls], video[controls]'

const scrolls = (overflow: string) => overflow === 'auto' || overflow === 'scroll'

function isScrollRegion(el: HTMLElement, style: CSSStyleDeclaration) {
  if (el.hasAttribute('tabindex')) return false
  return (scrolls(style.overflowY) && el.scrollHeight > el.clientHeight)
    || (scrolls(style.overflowX) && el.scrollWidth > el.clientWidth)
}

function collectFocusable(container: HTMLElement, selector: string, scrollRegions: boolean) {
  const result: HTMLElement[] = []
  const visit = (parent: HTMLElement | ShadowRoot) => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement)) continue
      const style = getComputedStyle(child)
      if (child.inert || child.hasAttribute('inert') || child.hidden || style.display === 'none' || style.visibility === 'hidden') continue
      const before = result.length
      if (child.matches(selector) && child.getAttribute('tabindex') !== '-1') result.push(child)
      visit(child.shadowRoot ?? child)
      // Chromium makes a scrollable region a Tab stop when nothing inside it can take focus.
      if (scrollRegions && result.length === before && isScrollRegion(child, style)) result.push(child)
    }
  }
  visit(container)
  return result
}

/** Focus order for touch menus containing inert message snapshots and web components. */
export function getComposedFocusableElements(container: HTMLElement): HTMLElement[] {
  return collectFocusable(container, FOCUSABLE_SELECTOR, false)
}

export function getComposedActiveElement(): Element | null {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active
}

const isGroupedRadio = (el: Element): el is HTMLInputElement =>
  el instanceof HTMLInputElement && el.type === 'radio' && el.name !== ''

/**
 * The controls Tab moves through inside `container`, in order. A named radio group
 * counts once, as it does natively: its focused radio, else its checked one, else its first.
 */
export function getTabStops(container: HTMLElement, active: Element | null): HTMLElement[] {
  const found = collectFocusable(container, TAB_STOP_SELECTOR, true)
  const isControl = found.map((stop) => stop.matches(TAB_STOP_SELECTOR))
  // A read-only window with nothing to operate keeps focus on its panel.
  const firstControl = isControl.indexOf(true)
  if (firstControl < 0) return []
  // The trap wraps at its first and last control, so only a region between them is a stop.
  const stops = found.slice(firstControl, isControl.lastIndexOf(true) + 1)
  return stops.filter((stop) => {
    if (!isGroupedRadio(stop)) return true
    const group = stops.filter((el): el is HTMLInputElement =>
      isGroupedRadio(el) && el.name === stop.name && el.form === stop.form)
    return stop === (group.find((radio) => radio === active) ?? group.find((radio) => radio.checked) ?? group[0])
  })
}

/** Index of the first stop after `active`, for focus on something that is not a stop itself. */
function firstStopAfter(stops: HTMLElement[], active: Element | null) {
  if (!active) return 0
  const after = stops.findIndex((stop) => {
    const position = active.compareDocumentPosition(stop)
    return !(position & Node.DOCUMENT_POSITION_DISCONNECTED) && !!(position & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  return after < 0 ? stops.length : after
}

/**
 * Move focus to the next stop, wrapping at both ends. A stop that refuses focus is passed
 * over: WebKit cannot focus a scrollable region, and a closed `<details>` hides its content.
 * Returns false when no stop took focus.
 */
export function focusNextTabStop(stops: HTMLElement[], active: Element | null, backward: boolean): boolean {
  const count = stops.length
  const index = stops.indexOf(active as HTMLElement)
  const next = index >= 0 ? index + 1 : firstStopAfter(stops, active)
  const start = backward ? (index >= 0 ? index : next) - 1 : next
  for (let step = 0; step < count; step++) {
    const offset = backward ? start - step : start + step
    const stop = stops[((offset % count) + count) % count]
    stop.focus()
    if (getComposedActiveElement() === stop) return true
  }
  return false
}
