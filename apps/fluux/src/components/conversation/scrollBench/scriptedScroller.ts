/**
 * Scroll bench: a scripted scroller that gives the real message list, positioning controller,
 * browser adapters and installed @tanstack/virtual-core the geometry and timing of a browser, one
 * deterministic frame at a time.
 *
 * What it simulates (and what the old per-test fake geometry left out):
 *  - a scroller whose scrollTop is clamped to the content the spacer currently holds, so a write past
 *    the end of a not-yet-grown spacer is clamped the way a browser clamps it;
 *  - frames: requestAnimationFrame callbacks, scroll events, row-size observations and timers advance
 *    only when `frame()` runs, in a browser's order (input, scroll events, rAF, layout, resize
 *    observations);
 *  - scroll events delivered a frame after the position moved, never synchronously;
 *  - ResizeObserver delivery of row and scroller size changes, on demand per frame;
 *  - smooth scrolls that land over several frames, and iOS touch drags with rubber-band overscroll,
 *    flings with momentum and the touchend that ends them.
 * Row heights come from a script (`setRowHeight`) keyed by message id, so a row can grow, shrink or
 * measure differently from its estimate at any frame.
 *
 * It is a test double of the browser, not of Fluux: nothing here knows about the controller, the
 * adapters or the virtualizer adapter.
 */
import { act } from '@testing-library/react'
import { vi } from 'vitest'

const FRAME_MS = 16

type Rect = { top: number; left: number; width: number; height: number }

export interface ScriptedScrollerOptions {
  viewportHeight?: number
  width?: number
  /** Height of a message row with no scripted height. */
  defaultRowHeight?: number
  /** Height of anything else the list mounts (date separators, loaders). */
  structuralRowHeight?: number
}

interface SmoothScroll { from: number; to: number; frame: number; frames: number }
interface Fling { velocity: number }

type ObserverEntry = { target: Element; last: string | null }

const descriptorOf = (name: string) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ?? Object.getOwnPropertyDescriptor(Element.prototype, name)

export class ScriptedScroller {
  viewportHeight: number
  width: number
  private readonly defaultRowHeight: number
  private readonly structuralRowHeight: number
  private readonly rowHeights = new Map<string, number>()
  private cached: HTMLElement | null = null
  private top = 0
  private scrollEventPending = false
  private eventHoldFrames = 0
  private smooth: SmoothScroll | null = null
  private fling: Fling | null = null
  private dragging = false
  private rafQueue: Array<{ id: number; callback: FrameRequestCallback }> = []
  private rafId = 0
  private observers = new Set<ScriptedResizeObserver>()
  private restores: Array<() => void> = []
  private nowMs = 1_000_000
  /** Every programmatic write the list made, in order: the position asked for, and what it landed on. */
  readonly writes: Array<{ requested: number; landed: number; behavior: string; frame: number }> = []
  frameCount = 0

  constructor(options: ScriptedScrollerOptions = {}) {
    this.viewportHeight = options.viewportHeight ?? 600
    this.width = options.width ?? 800
    this.defaultRowHeight = options.defaultRowHeight ?? 100
    this.structuralRowHeight = options.structuralRowHeight ?? 40
  }

  // ---- script ---------------------------------------------------------------------------------

  /** The scroller's width from the next layout on: rows report their new width on the next frame. */
  setWidth(width: number): void { this.width = width }

  /** The measured height of a message row from the next layout on; observers hear of it on the next frame. */
  setRowHeight(messageId: string, height: number): void { this.rowHeights.set(messageId, height) }

  rowHeight(messageId: string): number { return this.rowHeights.get(messageId) ?? this.defaultRowHeight }

  /** The list's scroll element: the one message list mounted in the document. */
  get scroller(): HTMLElement | null {
    if (!this.cached?.isConnected) this.cached = document.querySelector<HTMLElement>('[data-message-list]')
    return this.cached
  }

  // ---- geometry ---------------------------------------------------------------------------------

  private spacerHeight(): number {
    const spacer = this.scroller?.querySelector<HTMLElement>('[data-virtualizer-spacer]')
    return spacer ? parseFloat(spacer.style.height) || 0 : 0
  }

  get clientHeight(): number { return this.viewportHeight }

  /** The viewport changes size (composer grows, keyboard opens); observers hear of it on the next layout. */
  setViewportHeight(height: number): void { this.viewportHeight = height }

  get scrollHeight(): number { return Math.max(this.viewportHeight, this.spacerHeight()) }

  get maxScrollTop(): number { return Math.max(0, this.scrollHeight - this.viewportHeight) }

  get scrollTop(): number { return this.top }

  /** What a scrollTop assignment lands on: the browser clamps to the content, outside a touch drag. */
  private landed(value: number): number {
    if (this.dragging) return value
    return Math.min(Math.max(0, value), this.maxScrollTop)
  }

  private setTop(value: number, behavior = 'instant', record = false): void {
    const requested = value
    const next = this.landed(value)
    if (next !== this.top) this.scrollEventPending = true
    this.top = next
    if (record) this.writes.push({ requested, landed: next, behavior, frame: this.frameCount })
  }

  /** Delays the next scroll event by `frames` frames: the position has moved and the page has not heard yet. */
  holdScrollEvents(frames: number): void { this.eventHoldFrames = frames }

  /** Moves the scroller as if the reader did (wheel, scrollbar, keyboard): no write is recorded. */
  readerScrollTo(top: number): void { this.setTop(top) }

  /** Sets the position without a scroll event, as the browser does for layout clamping. */
  private clampToContent(): void {
    if (!this.dragging && !this.fling && (this.top > this.maxScrollTop || this.top < 0)) {
      this.top = Math.min(Math.max(0, this.top), this.maxScrollTop)
      this.scrollEventPending = true
    }
  }

  private rowElementHeight(element: HTMLElement): number {
    const id = element.querySelector<HTMLElement>('[data-message-row-id]')?.dataset.messageRowId
    return id === undefined ? this.structuralRowHeight : this.rowHeight(id)
  }

  private rectOf(element: Element): Rect | null {
    if (element === this.scroller) return { top: 0, left: 0, width: this.width, height: this.viewportHeight }
    const wrapper = element.closest<HTMLElement>('[data-index]')
    if (!wrapper || !this.scroller?.contains(wrapper)) return null
    const wrapperTop = parseFloat(wrapper.style.top) || 0
    const height = this.rowElementHeight(wrapper)
    const own = element === wrapper || element.hasAttribute('data-message-row-id')
    return { top: wrapperTop - this.top, left: 0, width: this.width, height: own ? height : 0 }
  }

  // ---- install ----------------------------------------------------------------------------------

  /** Replaces the browser surfaces the list reads. Call `uninstall` (afterEach) to restore them. */
  install(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the patched getters run with their own `this`
    const self = this
    const define = (proto: object, name: string, descriptor: PropertyDescriptor) => {
      const original = Object.getOwnPropertyDescriptor(proto, name)
      Object.defineProperty(proto, name, { configurable: true, ...descriptor })
      this.restores.push(() => {
        if (original) Object.defineProperty(proto, name, original)
        else delete (proto as Record<string, unknown>)[name]
      })
    }
    const isScroller = (element: Element) => element.hasAttribute('data-message-list')
    const isRow = (element: Element) => element.hasAttribute('data-index') && self.scroller?.contains(element)
    const withFallback = <T,>(name: string, scripted: (element: HTMLElement) => T | undefined) => {
      const original = descriptorOf(name)
      define(HTMLElement.prototype, name, {
        get(this: HTMLElement) {
          const value = scripted(this)
          return value !== undefined ? value : original?.get?.call(this)
        },
        set: original?.set,
      })
    }
    withFallback('clientHeight', e => isScroller(e) ? self.clientHeight : undefined)
    withFallback('offsetHeight', e => isScroller(e) ? self.clientHeight : isRow(e) ? self.rowElementHeight(e) : undefined)
    withFallback('clientWidth', e => isScroller(e) ? self.width : undefined)
    withFallback('offsetWidth', e => isScroller(e) || isRow(e) ? self.width : undefined)
    withFallback('scrollHeight', e => isScroller(e) ? self.scrollHeight : undefined)
    withFallback('offsetTop', e => isRow(e) ? parseFloat(e.style.top) || 0 : undefined)
    const scrollTopOriginal = descriptorOf('scrollTop')
    define(Element.prototype, 'scrollTop', {
      get(this: Element) { return isScroller(this) ? self.top : scrollTopOriginal?.get?.call(this) },
      set(this: Element, value: number) {
        if (isScroller(this)) self.setTop(value)
        else scrollTopOriginal?.set?.call(this, value)
      },
    })
    const rectOriginal = Element.prototype.getBoundingClientRect
    define(Element.prototype, 'getBoundingClientRect', {
      value(this: Element) {
        const rect = self.rectOf(this)
        if (!rect) return rectOriginal.call(this)
        return new DOMRect(rect.left, rect.top, rect.width, rect.height)
      },
    })
    const scrollToScripted = function (this: Element, first?: ScrollToOptions | number, second?: number) {
      if (!isScroller(this)) return
      const top = typeof first === 'number' ? second ?? 0 : first?.top ?? self.top
      const behavior = typeof first === 'object' && first?.behavior ? first.behavior : 'instant'
      if (behavior === 'smooth') {
        self.smooth = { from: self.top, to: self.landed(top), frame: 0, frames: 12 }
        self.writes.push({ requested: top, landed: self.landed(top), behavior, frame: self.frameCount })
        return
      }
      self.smooth = null
      self.setTop(top, behavior, true)
    }
    define(Element.prototype, 'scrollTo', { value: scrollToScripted })
    define(Element.prototype, 'scroll', { value: scrollToScripted })
    define(Element.prototype, 'scrollBy', {
      value(this: Element, first?: ScrollToOptions | number, second?: number) {
        const delta = typeof first === 'number' ? second ?? 0 : first?.top ?? 0
        scrollToScripted.call(this, typeof first === 'object' ? { ...first, top: self.top + delta } : self.top + delta)
      },
    })

    // Time and frames belong to the script.
    const stubs: Array<[string, unknown]> = [
      ['requestAnimationFrame', (callback: FrameRequestCallback) => {
        this.rafQueue.push({ id: ++this.rafId, callback })
        return this.rafId
      }],
      ['cancelAnimationFrame', (id: number) => { this.rafQueue = this.rafQueue.filter(entry => entry.id !== id) }],
      ['ResizeObserver', class extends ScriptedResizeObserver { constructor(cb: ResizeObserverCallback) { super(cb, self.observers) } }],
    ]
    for (const [name, value] of stubs) vi.stubGlobal(name, value)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'], now: this.nowMs })
    this.restores.push(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  }

  uninstall(): void {
    for (const restore of this.restores.splice(0).reverse()) restore()
    this.cached = null
  }

  // ---- time -----------------------------------------------------------------------------------

  /** One browser frame: input and momentum, scroll events, animation callbacks, layout, resize observations. */
  frame(): void {
    this.frameCount++
    this.nowMs += FRAME_MS
    act(() => { vi.advanceTimersByTime(FRAME_MS) })
    this.advanceMotion()
    act(() => {
      if (this.scrollEventPending && this.eventHoldFrames > 0) this.eventHoldFrames--
      else if (this.scrollEventPending && this.scroller) {
        this.scrollEventPending = false
        this.scroller.dispatchEvent(new Event('scroll'))
      }
      const callbacks = this.rafQueue.splice(0)
      for (const { callback } of callbacks) callback(this.nowMs)
    })
    this.layout()
  }

  frames(count: number): void { for (let i = 0; i < count; i++) this.frame() }

  /** Frames until nothing is pending (events, animation callbacks, motion) or the cap, which fails the replay. */
  settle(cap = 240): void {
    for (let i = 0; i < cap; i++) {
      this.frame()
      if (!this.busy()) return
    }
    throw new Error(`scroller still moving after ${cap} frames`)
  }

  private busy(): boolean {
    return this.scrollEventPending || this.smooth !== null || this.fling !== null || this.rafQueue.length > 0
  }

  private advanceMotion(): void {
    if (this.smooth) {
      const motion = this.smooth
      motion.frame++
      const progress = Math.min(1, motion.frame / motion.frames)
      this.setTop(motion.from + (motion.to - motion.from) * (1 - (1 - progress) ** 2))
      if (progress === 1) this.smooth = null
    }
    if (this.fling) {
      const momentum = this.fling
      const before = this.top
      this.setTop(before + momentum.velocity)
      momentum.velocity *= 0.94
      if (Math.abs(momentum.velocity) < 0.5 || this.top === before) this.fling = null
    }
  }

  /** The browser's layout step: clamp to the content, then deliver resize observations until stable. */
  private layout(): void {
    for (let pass = 0; pass < 4; pass++) {
      this.clampToContent()
      let delivered = false
      act(() => { for (const observer of [...this.observers]) delivered = observer.deliver() || delivered })
      if (!delivered) break
    }
    this.clampToContent()
  }

  // ---- touch ------------------------------------------------------------------------------------

  /** An iOS finger: down, drag (with rubber-band overscroll past the ends), up with an optional fling. */
  private fingerY = 400
  private touchEvent(type: 'touchstart' | 'touchmove' | 'touchend'): void {
    const point = { identifier: 1, clientX: 200, clientY: this.fingerY, target: this.scroller }
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.assign(event, {
      touches: type === 'touchend' ? [] : [point],
      changedTouches: [point],
      targetTouches: type === 'touchend' ? [] : [point],
    })
    act(() => { this.scroller?.dispatchEvent(event) })
  }

  readonly touch = {
    start: () => {
      this.fling = null
      this.smooth = null
      this.dragging = true
      this.fingerY = 400
      this.touchEvent('touchstart')
    },
    /** Content follows the finger: a positive delta scrolls toward the end. */
    drag: (delta: number) => {
      this.fingerY -= delta
      this.setTop(this.top + delta)
      this.touchEvent('touchmove')
    },
    end: (velocity = 0) => {
      this.dragging = false
      this.touchEvent('touchend')
      // Rubber band snaps back to the content edge; momentum carries on from the release.
      if (this.top < 0 || this.top > this.maxScrollTop) this.setTop(this.top)
      this.fling = velocity === 0 ? null : { velocity }
    },
  }

  /** A wheel or trackpad tick: the page hears the wheel, and the content moves with it. */
  wheel(deltaY: number): void {
    act(() => { this.scroller?.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })) })
    this.setTop(this.top + deltaY)
  }

  get flinging(): boolean { return this.fling !== null }
}

class ScriptedResizeObserver {
  private readonly entries = new Map<Element, ObserverEntry>()
  constructor(private readonly callback: ResizeObserverCallback, private readonly all: Set<ScriptedResizeObserver>) {
    all.add(this)
  }
  observe(target: Element) { if (!this.entries.has(target)) this.entries.set(target, { target, last: null }) }
  unobserve(target: Element) { this.entries.delete(target) }
  disconnect() { this.entries.clear(); this.all.delete(this) }
  /** Reports each observed element whose border box changed since it was last reported. */
  deliver(): boolean {
    const changed: ResizeObserverEntry[] = []
    for (const entry of this.entries.values()) {
      if (!entry.target.isConnected) continue
      const rect = entry.target.getBoundingClientRect()
      const signature = `${rect.width}x${rect.height}`
      if (signature === entry.last) continue
      entry.last = signature
      changed.push({
        target: entry.target,
        contentRect: rect,
        borderBoxSize: [{ blockSize: rect.height, inlineSize: rect.width }],
        contentBoxSize: [{ blockSize: rect.height, inlineSize: rect.width }],
        devicePixelContentBoxSize: [],
      } as unknown as ResizeObserverEntry)
    }
    if (changed.length > 0) this.callback(changed, this as unknown as ResizeObserver)
    return changed.length > 0
  }
}
