// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useStaticContextLanding, type StaticContextLanding } from './useStaticContextLanding'

/**
 * Static previews (search context, Saved) land themselves on a target row. These cases pin the
 * landing the list performed before it owned the scroll element: ~1/3 down the viewport,
 * persistent highlight, a hold while context loads, and no fighting a reader who takes over.
 */
describe('useStaticContextLanding', () => {
  let frames: FrameRequestCallback[]
  let scroller: HTMLDivElement
  let row: HTMLDivElement

  const runFrames = (count = 1) => {
    for (let i = 0; i < count; i++) {
      const pending = frames.splice(0)
      pending.forEach(cb => cb(0))
    }
  }

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', () => { frames = [] })
    vi.stubGlobal('CSS', { escape: (value: string) => value })
    scroller = document.createElement('div')
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 5000, configurable: true })
    scroller.getBoundingClientRect = () => ({ top: 100, bottom: 700 } as DOMRect)
    row = document.createElement('div')
    row.dataset.messageRowId = 'row-1'
    // The row sits 1000px below the scroller top once scrolled to 0.
    row.getBoundingClientRect = () => ({ top: 100 + 1000 - scroller.scrollTop, bottom: 0 } as DOMRect)
    scroller.appendChild(row)
    document.body.appendChild(scroller)
  })

  afterEach(() => {
    scroller.remove()
    vi.unstubAllGlobals()
  })

  const mount = (landing: StaticContextLanding) =>
    renderHook(({ l }) => useStaticContextLanding({ current: scroller }, l), { initialProps: { l: landing } })

  it('lands the target a third of the way down the viewport and highlights it', () => {
    mount({ rowId: 'row-1', key: 'result-1' })
    runFrames(3)

    expect(scroller.scrollTop).toBe(1000 - 600 / 3)
    expect(row.classList.contains('message-highlight-persistent')).toBe(true)
  })

  it('waits while the preview context is still loading, then lands once', () => {
    const { rerender } = mount({ rowId: 'row-1', key: 'result-1', holding: true })
    runFrames(3)
    expect(scroller.scrollTop).toBe(0)

    rerender({ l: { rowId: 'row-1', key: 'result-1', holding: false } })
    runFrames(3)
    expect(scroller.scrollTop).toBe(1000 - 600 / 3)
  })

  it('stops once the reader takes over with a wheel gesture', () => {
    mount({ rowId: 'row-1', key: 'result-1' })
    runFrames(1)
    scroller.scrollTop = 123
    scroller.dispatchEvent(new Event('wheel'))
    runFrames(3)

    expect(scroller.scrollTop).toBe(123)
  })

  it('removes the highlight when the preview unmounts', () => {
    const { unmount } = mount({ rowId: 'row-1', key: 'result-1' })
    runFrames(3)
    unmount()

    expect(row.classList.contains('message-highlight-persistent')).toBe(false)
  })
})
