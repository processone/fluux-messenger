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

function scrollBox(target: EventTarget | null): HTMLElement | null {
  let el = target instanceof Element ? target : null
  while (el) {
    if (el instanceof HTMLElement) {
      const o = getComputedStyle(el)
      const y = /(auto|scroll|overlay)/.test(o.overflowY) && el.scrollHeight > el.clientHeight
      const x = /(auto|scroll|overlay)/.test(o.overflowX) && el.scrollWidth > el.clientWidth
      if (y || x) return el
    }
    el = el.parentElement
  }
  return null
}

/** Whether a pointer position is over the box's own scroll bar strip. */
function overStrip(el: HTMLElement, e: PointerEvent | MouseEvent): boolean {
  const r = el.getBoundingClientRect()
  const sw = el.offsetWidth - el.clientWidth
  const sh = el.offsetHeight - el.clientHeight
  return (sw > 0 && e.clientX >= r.right - sw - el.clientLeft) || (sh > 0 && e.clientY >= r.bottom - sh)
}

export function installScrollbarReveal(win: Window & typeof globalThis = window): () => void {
  const doc = win.document
  const timers = new Map<HTMLElement, number>()
  let intentUntil = 0
  let touching = false
  let dragging = false

  const reveal = (el: HTMLElement) => {
    el.setAttribute('data-scrolling', '')
    const prev = timers.get(el)
    if (prev !== undefined) win.clearTimeout(prev)
    timers.set(
      el,
      win.setTimeout(() => {
        timers.delete(el)
        el.removeAttribute('data-scrolling')
      }, REVEAL_HIDE_DELAY_MS),
    )
  }
  const markIntent = () => {
    intentUntil = win.performance.now() + USER_INTENT_MS
  }
  const hasIntent = () => touching || dragging || win.performance.now() < intentUntil

  const onWheel = (e: WheelEvent) => {
    markIntent()
    const el = scrollBox(e.target)
    if (el) reveal(el)
  }
  const onKey = (e: KeyboardEvent) => {
    if (NAV_KEYS.has(e.key)) markIntent()
  }
  const onTouchStart = () => {
    touching = true
    markIntent()
  }
  const onTouchEnd = () => {
    touching = false
    markIntent()
  }
  const onPointerDown = (e: PointerEvent) => {
    const el = e.target instanceof HTMLElement ? e.target : null
    if (el && overStrip(el, e)) {
      dragging = true
      reveal(el)
    }
  }
  const onPointerUp = () => {
    dragging = false
    markIntent()
  }
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return
    const el = e.target instanceof HTMLElement ? e.target : null
    if (el && overStrip(el, e)) reveal(el)
  }
  const onScroll = (e: Event) => {
    if (!hasIntent()) return
    if (e.target instanceof HTMLElement) reveal(e.target)
  }

  const opts = { capture: true, passive: true } as const
  const bindings: Array<[string, EventListener]> = [
    ['wheel', onWheel as EventListener],
    ['keydown', onKey as EventListener],
    ['touchstart', onTouchStart],
    ['touchend', onTouchEnd],
    ['touchcancel', onTouchEnd],
    ['pointerdown', onPointerDown as EventListener],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerUp],
    ['pointermove', onPointerMove as EventListener],
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
    doc.documentElement.removeAttribute('data-scrollbars')
  }
}
