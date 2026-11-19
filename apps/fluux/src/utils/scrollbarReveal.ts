/**
 * Scroll bar reveal (see the scrollbar block in index.css).
 *
 * The 6px scroll bar strip is always reserved; only the thumb is hidden at rest.
 * This helper sets `data-scrolling` on a scroll box while the user scrolls it or
 * has the pointer over its strip, and clears it about 1s later. It never writes
 * scroll positions, and scrolls Fluux makes itself (following a new message, a
 * jump) do not reveal the thumb because only scrolls that follow a user input do.
 *
 * It also sets `data-scrollbars="always"` on <html> when the system keeps scroll
 * bars visible (macOS "Show scroll bars: Always"), so the thumb stays visible.
 */

export const REVEAL_HIDE_DELAY_MS = 1000
/** How long after a user input a scroll event still counts as user-driven. */
export const USER_INTENT_MS = 300

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '])

/** True when the system draws classic (always visible) scroll bars. */
export function measureClassicScrollbars(doc: Document = document): boolean {
  const probe = doc.createElement('div')
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;top:-100px;left:-100px;' +
    'width:50px;height:50px;overflow:scroll;scrollbar-width:thin'
  doc.body.appendChild(probe)
  const classic = probe.offsetWidth - probe.clientWidth > 0
  probe.remove()
  return classic
}

/** Windows' WebView2 always reports classic bars, so only a Mac answer is a choice. */
function isMac(nav: Navigator): boolean {
  return /Mac/.test(nav.platform ?? '') && !/iPhone|iPad|iPod/.test(nav.userAgent ?? '') && !(nav.maxTouchPoints > 1)
}

/** The scroll boxes enclosing a target, nearest first: wheel and touch input chains outward. */
function scrollBoxes(target: EventTarget | null): HTMLElement[] {
  const boxes: HTMLElement[] = []
  let el = target instanceof Element ? target : null
  while (el) {
    if (el instanceof HTMLElement) {
      const o = getComputedStyle(el)
      const y = /(auto|scroll|overlay)/.test(o.overflowY) && el.scrollHeight > el.clientHeight
      const x = /(auto|scroll|overlay)/.test(o.overflowX) && el.scrollWidth > el.clientWidth
      if (y || x) boxes.push(el)
    }
    el = el.parentElement
  }
  return boxes
}

/** Space activates these instead of scrolling, so it is not scrolling input there. */
const ACTIVATABLE = 'button, a, input, textarea, select, summary, [role="button"], [role="option"], [contenteditable]'

/**
 * Whether a pointer is over the box's own scroll bar strip, on either side.
 * Mirrors the strip geometry of useScrollContainerBinding: the strip is what
 * lies between the border edge and the client area, so borders are excluded and
 * a left-side bar (RTL) is found as well as a right-side one.
 */
function overStrip(el: HTMLElement, e: MouseEvent): boolean {
  if (e.target !== el) return false
  const r = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const bl = parseFloat(style.borderLeftWidth) || 0
  const br = parseFloat(style.borderRightWidth) || 0
  const bb = parseFloat(style.borderBottomWidth) || 0
  const left = r.left + el.clientLeft
  const right = left + el.clientWidth
  const top = r.top + el.clientTop
  const bottom = top + el.clientHeight
  const inY = e.clientY >= top && e.clientY < bottom
  const inX = e.clientX >= left && e.clientX < right
  return (
    (inY && ((e.clientX >= r.left + bl && e.clientX < left) || (e.clientX >= right && e.clientX < r.right - br))) ||
    (inX && e.clientY >= bottom && e.clientY < r.bottom - bb)
  )
}

export function installScrollbarReveal(win: Window & typeof globalThis = window): () => void {
  const doc = win.document
  const timers = new Map<HTMLElement, number>()
  /** Boxes the user is scrolling (weak, so detached lists and dialogs are not retained): when the intent lapses, and whether scroll events renew it (touch fling). */
  const intents = new WeakMap<HTMLElement, { until: number; momentum: boolean }>()
  /** The box whose strip the pointer rests on, and the box whose bar is being dragged. */
  let hovered: HTMLElement | null = null
  let held: HTMLElement | null = null
  let touchBoxes: HTMLElement[] = []
  /** Keyboard navigation can scroll a list the focus is not in (selected rows), so it opens a short global window. */
  let keyIntentUntil = 0

  const now = () => win.performance.now()
  const scheduleHide = (el: HTMLElement) => {
    const prev = timers.get(el)
    if (prev !== undefined) win.clearTimeout(prev)
    timers.set(
      el,
      win.setTimeout(() => {
        timers.delete(el)
        // A resting pointer on the strip or a paused drag keeps the thumb.
        if (el === hovered || el === held) return
        el.removeAttribute('data-scrolling')
      }, REVEAL_HIDE_DELAY_MS),
    )
  }
  const reveal = (el: HTMLElement) => {
    el.setAttribute('data-scrolling', '')
    scheduleHide(el)
  }
  const markIntent = (el: HTMLElement, momentum = false) => {
    intents.set(el, { until: now() + USER_INTENT_MS, momentum })
  }
  const releaseHover = () => {
    if (!hovered) return
    const el = hovered
    hovered = null
    if (el.hasAttribute('data-scrolling')) scheduleHide(el)
  }

  const onWheel = (e: WheelEvent) => {
    const boxes = scrollBoxes(e.target)
    for (const b of boxes) markIntent(b)
    if (boxes[0]) reveal(boxes[0])
  }
  const onKey = (e: KeyboardEvent) => {
    if (!NAV_KEYS.has(e.key)) return
    if (e.key === ' ' && e.target instanceof Element && e.target.closest(ACTIVATABLE)) return
    keyIntentUntil = now() + USER_INTENT_MS
  }
  const onTouchStart = (e: TouchEvent) => {
    touchBoxes = scrollBoxes(e.target)
    for (const b of touchBoxes) markIntent(b, true)
  }
  const onTouchEnd = () => {
    for (const b of touchBoxes) markIntent(b, true)
    touchBoxes = []
  }
  const onPointerDown = (e: PointerEvent) => {
    const el = e.target instanceof HTMLElement ? e.target : null
    if (el && e.button === 0 && overStrip(el, e)) {
      held = el
      reveal(el)
    }
  }
  const onPointerUp = () => {
    const el = held
    held = null
    if (el && el.hasAttribute('data-scrolling')) scheduleHide(el)
  }
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return
    const el = e.target instanceof HTMLElement ? e.target : null
    if (el && overStrip(el, e)) {
      if (hovered !== el) releaseHover()
      hovered = el
      reveal(el)
    } else releaseHover()
  }
  const onPointerOut = (e: MouseEvent) => {
    if (!e.relatedTarget) releaseHover()
  }
  const onScroll = (e: Event) => {
    const el = e.target
    if (!(el instanceof HTMLElement)) return
    const intent = intents.get(el)
    // A finger still down owns its boxes however long it pauses.
    if (touchBoxes.includes(el)) markIntent(el, true)
    if (el === held || touchBoxes.includes(el) || keyIntentUntil > now() || (intent && intent.until > now())) {
      if (intent?.momentum) markIntent(el, true)
      reveal(el)
    }
  }

  const opts = { capture: true, passive: true } as const
  const bindings: Array<[string, EventListener]> = [
    ['wheel', onWheel as EventListener],
    ['keydown', onKey as EventListener],
    ['touchstart', onTouchStart as EventListener],
    ['touchend', onTouchEnd],
    ['touchcancel', onTouchEnd],
    ['pointerdown', onPointerDown as EventListener],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerUp],
    ['pointermove', onPointerMove as EventListener],
    ['pointerout', onPointerOut as EventListener],
    ['scroll', onScroll],
  ]
  for (const [type, fn] of bindings) doc.addEventListener(type, fn, opts)

  const syncSystemSetting = () => {
    const always = isMac(win.navigator) && measureClassicScrollbars(doc)
    if (always) doc.documentElement.setAttribute('data-scrollbars', 'always')
    else doc.documentElement.removeAttribute('data-scrollbars')
  }
  const setting: Array<[EventTarget, string]> = [
    [win, 'focus'],
    [win, 'resize'],
    [doc, 'visibilitychange'],
  ]
  for (const [t, type] of setting) t.addEventListener(type, syncSystemSetting)
  syncSystemSetting()

  return () => {
    for (const [type, fn] of bindings) doc.removeEventListener(type, fn, opts)
    for (const [t, type] of setting) t.removeEventListener(type, syncSystemSetting)
    for (const [el, id] of timers) {
      win.clearTimeout(id)
      el.removeAttribute('data-scrolling')
    }
    timers.clear()
    hovered = held = null
    touchBoxes = []
    doc.documentElement.removeAttribute('data-scrollbars')
  }
}
