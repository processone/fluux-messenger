import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SCROLL_IDLE_MS,
  installScrollbarAutohide,
  __resetScrollbarAutohideForTests,
} from './scrollbarAutohide'

describe('scrollbarAutohide', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installScrollbarAutohide()
  })

  afterEach(() => {
    __resetScrollbarAutohideForTests()
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  function scrollableDiv(): HTMLDivElement {
    const el = document.createElement('div')
    document.body.appendChild(el)
    return el
  }

  it('stamps data-scrolling on the scrolled element', () => {
    const el = scrollableDiv()
    el.dispatchEvent(new Event('scroll'))
    expect(el.hasAttribute('data-scrolling')).toBe(true)
  })

  it('clears data-scrolling after the idle delay', () => {
    const el = scrollableDiv()
    el.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(SCROLL_IDLE_MS - 1)
    expect(el.hasAttribute('data-scrolling')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(el.hasAttribute('data-scrolling')).toBe(false)
  })

  it('debounces: a fresh scroll resets the idle countdown', () => {
    const el = scrollableDiv()
    el.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(SCROLL_IDLE_MS - 100)
    el.dispatchEvent(new Event('scroll')) // restart the timer
    vi.advanceTimersByTime(200) // past the original deadline, before the new one
    expect(el.hasAttribute('data-scrolling')).toBe(true)
    vi.advanceTimersByTime(SCROLL_IDLE_MS)
    expect(el.hasAttribute('data-scrolling')).toBe(false)
  })

  it('tracks elements independently', () => {
    const a = scrollableDiv()
    const b = scrollableDiv()
    a.dispatchEvent(new Event('scroll'))
    expect(a.hasAttribute('data-scrolling')).toBe(true)
    expect(b.hasAttribute('data-scrolling')).toBe(false)
  })

  it('installs only once', () => {
    const el = scrollableDiv()
    installScrollbarAutohide() // second call should be a no-op
    const addSpy = vi.spyOn(el, 'setAttribute')
    el.dispatchEvent(new Event('scroll'))
    // A duplicate listener would stamp twice; one listener = one setAttribute.
    expect(addSpy).toHaveBeenCalledTimes(1)
  })
})
