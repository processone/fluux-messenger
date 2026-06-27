/**
 * Auto-hide scrollbars.
 *
 * The thumb is transparent at rest (see index.css) and only painted while the
 * user is hovering a scrollable container or actively scrolling it. This module
 * supplies the "actively scrolling" signal so the thumb also appears for wheel /
 * keyboard / programmatic scrolls where the pointer may not be over the area,
 * then fades out shortly after scrolling stops.
 *
 * A single capture-phase listener on `document` catches every scrollable
 * element (scroll events don't bubble, but they do propagate in the capture
 * phase). The scrolled element is stamped with a `data-scrolling` attribute that
 * CSS keys off; the attribute is cleared after a short idle delay.
 *
 * Why a data attribute and not a class: no component renders `data-scrolling`,
 * so React's reconciler never touches it — the stamp survives re-renders. A
 * className toggle could be clobbered when the owning component re-renders with
 * a changed `className` prop (e.g. the virtualized message list).
 */

/** How long the thumb lingers after the last scroll event, in milliseconds. */
export const SCROLL_IDLE_MS = 700

const SCROLLING_ATTR = 'data-scrolling'

const idleTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>()

function handleScroll(event: Event): void {
  const el = event.target
  // Document/window scroll targets aren't Elements that can hold the attribute.
  if (!(el instanceof Element)) return

  el.setAttribute(SCROLLING_ATTR, '')

  const pending = idleTimers.get(el)
  if (pending !== undefined) clearTimeout(pending)

  idleTimers.set(
    el,
    setTimeout(() => {
      el.removeAttribute(SCROLLING_ATTR)
      idleTimers.delete(el)
    }, SCROLL_IDLE_MS),
  )
}

let installed = false

/**
 * Install the global scroll listener. Idempotent and safe to call from multiple
 * entry points (the app and the demo). No-op outside a DOM environment.
 */
export function installScrollbarAutohide(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('scroll', handleScroll, { capture: true, passive: true })
}

/** Test-only: reset module state so the listener can be reinstalled. */
export function __resetScrollbarAutohideForTests(): void {
  if (typeof document !== 'undefined') {
    document.removeEventListener('scroll', handleScroll, { capture: true })
  }
  installed = false
}
