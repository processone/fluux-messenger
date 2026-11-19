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

  it('reveals while the pointer is held on the strip (a bar drag)', () => {
    Object.defineProperty(box, 'offsetWidth', { value: 106, configurable: true })
    Object.defineProperty(box, 'clientWidth', { value: 100, configurable: true })
    box.getBoundingClientRect = () => ({ right: 106, bottom: 100, left: 0, top: 0, width: 106, height: 100, x: 0, y: 0, toJSON() {} })
    box.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 104, clientY: 20 }))
    expect(box.hasAttribute('data-scrolling')).toBe(true)
    vi.advanceTimersByTime(5000)
    box.dispatchEvent(new Event('scroll'))
    expect(box.hasAttribute('data-scrolling')).toBe(true)
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
