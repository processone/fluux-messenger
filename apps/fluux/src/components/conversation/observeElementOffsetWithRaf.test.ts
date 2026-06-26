/**
 * Unit coverage for observeElementOffsetWithRaf — the rAF scroll-offset poller that keeps the
 * @tanstack virtualizer re-windowing during WebKit inertial ("kinetic") momentum, when the
 * desktop webview withholds `scroll` events and the default scroll-event-only observer freezes
 * the mounted window (the "looping images" report on the Tauri build).
 *
 * jsdom/happy-dom can't produce real momentum, so we drive the exact failure deterministically:
 * change scrollTop WITHOUT firing a `scroll` event and assert the offset is still re-emitted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { observeElementOffsetWithRaf } from './tanstackMessageVirtualizer'

describe('observeElementOffsetWithRaf', () => {
  let rafQueue: Array<FrameRequestCallback | undefined>
  let realRaf: typeof requestAnimationFrame
  let realCaf: typeof cancelAnimationFrame

  beforeEach(() => {
    rafQueue = []
    realRaf = globalThis.requestAnimationFrame
    realCaf = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((id: number) => {
      rafQueue[id - 1] = undefined
    }) as typeof cancelAnimationFrame
  })
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf
    globalThis.cancelAnimationFrame = realCaf
  })

  const flush = (frames: number) => {
    for (let i = 0; i < frames; i++) rafQueue.splice(0).forEach((cb) => cb && cb(0))
  }

  function makeEl(initial = 0) {
    let top = initial
    const listeners: Record<string, Array<() => void>> = {}
    return {
      get scrollTop() { return top },
      set scrollTop(v: number) { top = v },
      addEventListener: (t: string, h: () => void) => { (listeners[t] = listeners[t] || []).push(h) },
      removeEventListener: (t: string, h: () => void) => { listeners[t] = (listeners[t] || []).filter((x) => x !== h) },
      _fire: (t: string) => { (listeners[t] || []).forEach((h) => h()) },
      _count: (t: string) => (listeners[t] || []).length,
    }
  }

  it('re-emits the offset when scrollTop changes WITHOUT a scroll event (WebKit momentum)', () => {
    const el = makeEl(0)
    const cb = vi.fn()
    observeElementOffsetWithRaf({ scrollElement: el as unknown as HTMLElement }, cb)
    cb.mockClear()

    // A wheel kicks off momentum; the inertial phase moves scrollTop but fires NO scroll event.
    el._fire('wheel')
    el.scrollTop = 500
    flush(1)
    expect(cb).toHaveBeenCalledWith(500, true)

    el.scrollTop = 900
    flush(1)
    expect(cb).toHaveBeenCalledWith(900, true)
  })

  it('stops polling and emits isScrolling=false once the offset is stable', () => {
    const el = makeEl(0)
    const cb = vi.fn()
    observeElementOffsetWithRaf({ scrollElement: el as unknown as HTMLElement }, cb)
    cb.mockClear()

    el._fire('scroll')
    el.scrollTop = 300
    flush(1)
    cb.mockClear()

    // No further movement → after the idle window the poll emits false and stops rescheduling.
    flush(12)
    expect(cb).toHaveBeenCalledWith(300, false)

    cb.mockClear()
    flush(5)
    expect(cb).not.toHaveBeenCalled() // poll is no longer running
  })

  it('still re-windows on a normal scroll event (Chromium path unchanged)', () => {
    const el = makeEl(0)
    const cb = vi.fn()
    observeElementOffsetWithRaf({ scrollElement: el as unknown as HTMLElement }, cb)
    cb.mockClear()

    el.scrollTop = 250
    el._fire('scroll')
    expect(cb).toHaveBeenCalledWith(250, true)
  })

  it('detaches all listeners and cancels the poll on cleanup', () => {
    const el = makeEl(0)
    const cb = vi.fn()
    const cleanup = observeElementOffsetWithRaf({ scrollElement: el as unknown as HTMLElement }, cb)
    el._fire('wheel')
    el.scrollTop = 100
    cleanup?.()
    cb.mockClear()
    flush(5)
    expect(cb).not.toHaveBeenCalled()
    expect(el._count('scroll')).toBe(0)
    expect(el._count('wheel')).toBe(0)
  })

  it('is inert when there is no scroll element', () => {
    const cb = vi.fn()
    const cleanup = observeElementOffsetWithRaf({ scrollElement: null }, cb)
    flush(3)
    expect(cb).not.toHaveBeenCalled()
    expect(cleanup).toBeUndefined()
  })
})
