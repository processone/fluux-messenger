import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { useIosPaneNavigation, type IosPaneEntry } from './useIosPaneNavigation'

describe('iOS pane navigation', () => {
  let pane: HTMLElement
  let restore: () => void
  let width: number
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    width = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    pane = document.createElement('main')
    document.body.append(pane)
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 390 } as DOMRect)
  })
  afterEach(() => {
    restore()
    pane.remove()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const touch = (x: number, y = 300) => ({ identifier: 1, clientX: x, clientY: y })
  function start() { fireEvent.touchStart(pane, { touches: [touch(12)] }) }
  function move(x: number, y = 300) { fireEvent.touchMove(pane, { touches: [touch(x, y)] }) }
  function end(x: number) { fireEvent.touchEnd(pane, { changedTouches: [touch(x)] }) }

  it('follows the finger and navigates only after release and the exit animation', () => {
    const back = vi.fn()
    const ref = { current: pane }
    const { result } = renderHook(() => useIosPaneNavigation(ref, true, back))
    start(); move(150)
    expect(result.current.preview).toBe(true)
    expect(pane.style.transform).toContain('138px')
    expect(back).not.toHaveBeenCalled()
    end(150)
    expect(back).not.toHaveBeenCalled()
    act(() => vi.runAllTimers())
    expect(back).toHaveBeenCalledTimes(1)
    expect(pane.style.transform).toBe('')
  })
  it('returns to the conversation when the finger moves back below the threshold', () => {
    const back = vi.fn()
    const ref = { current: pane }
    const { result } = renderHook(() => useIosPaneNavigation(ref, true, back))
    start(); move(150); move(40); end(40)
    act(() => vi.runAllTimers())
    expect(back).not.toHaveBeenCalled()
    expect(result.current.preview).toBe(false)
    expect(pane.style.transform).toBe('')
  })
  it('cancels an interrupted gesture instead of navigating', () => {
    const back = vi.fn()
    const ref = { current: pane }
    renderHook(() => useIosPaneNavigation(ref, true, back))
    start(); move(150); fireEvent.touchCancel(pane)
    act(() => vi.runAllTimers())
    expect(back).not.toHaveBeenCalled()
    expect(pane.style.transform).toBe('')
  })
  it('leaves vertical scrolling and wide layouts alone', () => {
    const back = vi.fn()
    const ref = { current: pane }
    renderHook(() => useIosPaneNavigation(ref, true, back))
    start(); move(25, 380); end(150)
    expect(back).not.toHaveBeenCalled()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    start(); move(150); end(150)
    act(() => vi.runAllTimers())
    expect(back).not.toHaveBeenCalled()
  })

  it('respects reduced motion while still requiring release', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    const back = vi.fn()
    const ref = { current: pane }
    const { result } = renderHook(() => useIosPaneNavigation(ref, true, back))
    start(); move(150)
    expect(result.current.preview).toBe(false)
    expect(pane.style.transform).toBe('')
    expect(back).not.toHaveBeenCalled()
    end(150)
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('does not finish a pending return after switching conversations', () => {
    const back = vi.fn()
    const ref = { current: pane }
    const { rerender } = renderHook(({ id }) => useIosPaneNavigation(ref, true, back, id), {
      initialProps: { id: 'alice' },
    })
    start(); move(150); end(150)
    rerender({ id: 'bob' })
    act(() => vi.runAllTimers())
    expect(back).not.toHaveBeenCalled()
    expect(pane.style.transform).toBe('')
  })

  it('ignores gestures while a dialog is open', () => {
    const back = vi.fn()
    const ref = { current: pane }
    renderHook(() => useIosPaneNavigation(ref, true, back))
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    start(); move(150); end(150)
    act(() => vi.runAllTimers())
    expect(back).not.toHaveBeenCalled()
    dialog.remove()
  })

  describe('entering', () => {
    function render(entry: IosPaneEntry, id: string | null = null) {
      const ref = { current: pane }
      return renderHook(({ entry, id }) => useIosPaneNavigation(ref, true, vi.fn(), id, entry), {
        initialProps: { entry, id },
      })
    }

    it('slides the pane in over the list when it is shown', () => {
      const { result, rerender } = render({ shown: false, animated: true })
      rerender({ entry: { shown: true, animated: true }, id: null })
      expect(result.current.preview).toBe(true)
      expect(pane.style.transform).toBe('translate3d(100%, 0, 0)')
      act(() => vi.advanceTimersToNextFrame())
      act(() => vi.advanceTimersToNextFrame())
      expect(pane.style.transform).toBe('translate3d(0, 0, 0)')
      expect(pane.style.transition).toContain('transform')
      act(() => vi.runAllTimers())
      expect(result.current.preview).toBe(false)
      expect(pane.style.transform).toBe('')
    })

    it('keeps sliding in when the conversation id lands', () => {
      const { result, rerender } = render({ shown: false, animated: true })
      rerender({ entry: { shown: true, animated: true }, id: null })
      act(() => vi.advanceTimersToNextFrame())
      rerender({ entry: { shown: true, animated: true }, id: 'alice' })
      act(() => vi.advanceTimersToNextFrame())
      expect(result.current.preview).toBe(true)
      expect(pane.style.transform).toBe('translate3d(0, 0, 0)')
    })

    it('stops when the pane is hidden mid-slide', () => {
      const { result, rerender } = render({ shown: false, animated: true })
      rerender({ entry: { shown: true, animated: true }, id: null })
      rerender({ entry: { shown: false, animated: false }, id: null })
      expect(result.current.preview).toBe(false)
      expect(pane.style.transform).toBe('')
      act(() => vi.runAllTimers())
      expect(pane.style.transform).toBe('')
    })

    it('shows the pane in place when already shown, not animated, or with reduced motion', () => {
      const shownAtLaunch = render({ shown: true, animated: true })
      expect(shownAtLaunch.result.current.preview).toBe(false)
      shownAtLaunch.unmount()

      const notAnimated = render({ shown: false, animated: false })
      notAnimated.rerender({ entry: { shown: true, animated: false }, id: null })
      expect(notAnimated.result.current.preview).toBe(false)
      notAnimated.unmount()

      vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
      const reduced = render({ shown: false, animated: true })
      reduced.rerender({ entry: { shown: true, animated: true }, id: null })
      expect(reduced.result.current.preview).toBe(false)
      expect(pane.style.transform).toBe('')
    })

    it('shows the pane in place on another platform', () => {
      restore()
      restore = setPlatformForTesting({ shell: 'web', os: 'ios' })
      const { result, rerender } = render({ shown: false, animated: true })
      rerender({ entry: { shown: true, animated: true }, id: null })
      expect(result.current.preview).toBe(false)
      expect(pane.style.transform).toBe('')
    })
  })

  describe('back button', () => {
    it('slides the pane out before navigating, once', () => {
      const ref = { current: pane }
      const navigate = vi.fn()
      const { result } = renderHook(() => useIosPaneNavigation(ref, true, vi.fn()))
      act(() => result.current.back(navigate))
      act(() => result.current.back(navigate))
      expect(result.current.preview).toBe(true)
      expect(pane.style.transform).toBe('translate3d(390px, 0, 0)')
      expect(navigate).not.toHaveBeenCalled()
      act(() => vi.runAllTimers())
      expect(navigate).toHaveBeenCalledTimes(1)
      expect(result.current.preview).toBe(false)
      expect(pane.style.transform).toBe('')
    })

    it('keeps the pane off-screen until the navigation hides it', () => {
      const ref = { current: pane }
      const navigate = vi.fn()
      const { result, rerender } = renderHook(({ shown }) => useIosPaneNavigation(ref, true, vi.fn(), null, { shown, animated: true }), {
        initialProps: { shown: true },
      })
      act(() => result.current.back(navigate))
      act(() => vi.advanceTimersByTime(300))
      expect(navigate).toHaveBeenCalledTimes(1)
      expect(pane.style.transform).toBe('translate3d(390px, 0, 0)')
      expect(result.current.preview).toBe(true)
      rerender({ shown: false })
      expect(pane.style.transform).toBe('')
      expect(result.current.preview).toBe(false)
    })

    it('navigates at once with reduced motion', () => {
      vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
      const ref = { current: pane }
      const navigate = vi.fn()
      const { result } = renderHook(() => useIosPaneNavigation(ref, true, vi.fn()))
      act(() => result.current.back(navigate))
      expect(navigate).toHaveBeenCalledTimes(1)
      expect(pane.style.transform).toBe('')
    })
  })
})
