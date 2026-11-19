// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installScrollbarReveal, REVEAL_HIDE_DELAY_MS, USER_INTENT_MS } from './scrollbarReveal'

/** FLM-318: the helper reveals the thumb for user scrolls only and hides it after 1s. */
describe('installScrollbarReveal', () => {
  let box: HTMLDivElement
  let uninstall: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="box"></div>'
    box = document.getElementById('box') as HTMLDivElement
    box.style.overflowY = 'auto'
    Object.defineProperty(box, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 100, configurable: true })
    uninstall = installScrollbarReveal(window)
  })
  afterEach(() => {
    uninstall()
    vi.useRealTimers()
  })

  it('does not reveal for a scroll Fluux makes itself', () => {
    box.dispatchEvent(new Event('scroll'))
    expect(box.hasAttribute('data-scrolling')).toBe(false)
  })

  it('reveals on the first wheel event and hides 1s after the last one', () => {
    box.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    expect(box.hasAttribute('data-scrolling')).toBe(true)
    vi.advanceTimersByTime(REVEAL_HIDE_DELAY_MS - 100)
    box.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    vi.advanceTimersByTime(REVEAL_HIDE_DELAY_MS - 1)
    expect(box.hasAttribute('data-scrolling')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(box.hasAttribute('data-scrolling')).toBe(false)
  })

  it('ignores a scroll that arrives after the intent window has passed', () => {
    box.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    vi.advanceTimersByTime(REVEAL_HIDE_DELAY_MS)
    expect(box.hasAttribute('data-scrolling')).toBe(false)
    vi.advanceTimersByTime(USER_INTENT_MS)
    box.dispatchEvent(new Event('scroll'))
    expect(box.hasAttribute('data-scrolling')).toBe(false)
  })

  /** Give the box a right-side (or left-side) 6px strip. */
  const giveStrip = (side: 'right' | 'left' = 'right') => {
    Object.defineProperty(box, 'offsetWidth', { value: 106, configurable: true })
    Object.defineProperty(box, 'clientWidth', { value: 100, configurable: true })
    Object.defineProperty(box, 'clientLeft', { value: side === 'left' ? 6 : 0, configurable: true })
    box.getBoundingClientRect = () => ({ right: 106, bottom: 100, left: 0, top: 0, width: 106, height: 100, x: 0, y: 0, toJSON() {} })
  }
  const pointer = (type: string, clientX: number, extra: object = {}) =>
    box.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY: 20, ...extra }))

  it('keeps the thumb while a drag is paused, then hides 1s after release', () => {
    giveStrip()
    pointer('pointerdown', 104)
    vi.advanceTimersByTime(5000)
    expect(box.hasAttribute('data-scrolling')).toBe(true)
    pointer('pointerup', 104)
    vi.advanceTimersByTime(REVEAL_HIDE_DELAY_MS)
    expect(box.hasAttribute('data-scrolling')).toBe(false)
  })

  it('keeps the thumb while the pointer rests on the strip, and hides it 1s after leaving', () => {
    giveStrip()
    pointer('pointermove', 104)
    vi.advanceTimersByTime(5000)
    expect(box.hasAttribute('data-scrolling')).toBe(true)
    pointer('pointermove', 50)
    vi.advanceTimersByTime(REVEAL_HIDE_DELAY_MS)
    expect(box.hasAttribute('data-scrolling')).toBe(false)
  })

  it('finds a left-side strip and ignores the content area', () => {
    giveStrip('left')
    pointer('pointermove', 50)
    expect(box.hasAttribute('data-scrolling')).toBe(false)
    pointer('pointermove', 3)
    expect(box.hasAttribute('data-scrolling')).toBe(true)
  })

  it('does not reveal for an ordinary click or an unrelated key', () => {
    pointer('pointerup', 50)
    pointer('click', 50)
    box.dispatchEvent(new Event('scroll'))
    expect(box.hasAttribute('data-scrolling')).toBe(false)
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    box.dispatchEvent(new Event('scroll'))
    expect(box.hasAttribute('data-scrolling')).toBe(false)
  })

  it('keeps following a touch fling that outlasts the intent window', () => {
    box.dispatchEvent(new Event('touchstart', { bubbles: true }))
    box.dispatchEvent(new Event('touchend', { bubbles: true }))
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(USER_INTENT_MS - 50)
      box.dispatchEvent(new Event('scroll'))
      expect(box.hasAttribute('data-scrolling')).toBe(true)
    }
    vi.advanceTimersByTime(REVEAL_HIDE_DELAY_MS)
    expect(box.hasAttribute('data-scrolling')).toBe(false)
  })

  it('keeps a held finger owning the box after a pause before the first scroll', () => {
    box.dispatchEvent(new Event('touchstart', { bubbles: true }))
    vi.advanceTimersByTime(USER_INTENT_MS * 3)
    box.dispatchEvent(new Event('scroll'))
    expect(box.hasAttribute('data-scrolling')).toBe(true)
  })

  it('reveals the outer list when a wheel over an inner scroller chains outward', () => {
    const inner = document.createElement('div')
    inner.style.overflowX = 'auto'
    Object.defineProperty(inner, 'scrollWidth', { value: 500, configurable: true })
    Object.defineProperty(inner, 'clientWidth', { value: 100, configurable: true })
    box.appendChild(inner)
    inner.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    box.dispatchEvent(new Event('scroll'))
    expect(box.hasAttribute('data-scrolling')).toBe(true)
  })

  it('reveals a list scrolled by Up/Down in a search input beside it', () => {
    const search = document.createElement('input')
    document.body.appendChild(search)
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    box.dispatchEvent(new Event('scroll'))
    expect(box.hasAttribute('data-scrolling')).toBe(true)
  })

  it('does not let a caret move in the composer authorize a later automatic scroll', () => {
    const composer = document.createElement('textarea')
    document.body.appendChild(composer)
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
      composer.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    }
    const line = document.createElement('input')
    document.body.appendChild(line)
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    box.dispatchEvent(new Event('scroll')) // the chat list following a new message
    expect(box.hasAttribute('data-scrolling')).toBe(false)
  })

  it('does not treat Space on a button as scrolling', () => {
    const btn = document.createElement('button')
    box.appendChild(btn)
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    box.dispatchEvent(new Event('scroll'))
    expect(box.hasAttribute('data-scrolling')).toBe(false)
  })

  it('removes its attribute and listeners on uninstall', () => {
    box.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    uninstall()
    expect(box.hasAttribute('data-scrolling')).toBe(false)
    box.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    expect(box.hasAttribute('data-scrolling')).toBe(false)
  })

  it('does not mark the page as always-showing scroll bars when none are measured', () => {
    expect(document.documentElement.hasAttribute('data-scrollbars')).toBe(false)
  })
})
