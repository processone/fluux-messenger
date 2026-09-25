import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { useIosEdgeBack } from './useIosEdgeBack'

describe('interactive iOS back gesture', () => {
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
    const { result } = renderHook(() => useIosEdgeBack(ref, true, back))
    start(); move(150)
    expect(result.current).toBe(true)
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
    const { result } = renderHook(() => useIosEdgeBack(ref, true, back))
    start(); move(150); move(40); end(40)
    act(() => vi.runAllTimers())
    expect(back).not.toHaveBeenCalled()
    expect(result.current).toBe(false)
    expect(pane.style.transform).toBe('')
  })
  it('cancels an interrupted gesture instead of navigating', () => {
    const back = vi.fn()
    const ref = { current: pane }
    renderHook(() => useIosEdgeBack(ref, true, back))
    start(); move(150); fireEvent.touchCancel(pane)
    act(() => vi.runAllTimers())
    expect(back).not.toHaveBeenCalled()
    expect(pane.style.transform).toBe('')
  })
  it('leaves vertical scrolling and wide layouts alone', () => {
    const back = vi.fn()
    const ref = { current: pane }
    renderHook(() => useIosEdgeBack(ref, true, back))
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
    const { result } = renderHook(() => useIosEdgeBack(ref, true, back))
    start(); move(150)
    expect(result.current).toBe(false)
    expect(pane.style.transform).toBe('')
    expect(back).not.toHaveBeenCalled()
    end(150)
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('does not finish a pending return after switching conversations', () => {
    const back = vi.fn()
    const ref = { current: pane }
    const { rerender } = renderHook(({ id }) => useIosEdgeBack(ref, true, back, id), {
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
    renderHook(() => useIosEdgeBack(ref, true, back))
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    start(); move(150); end(150)
    act(() => vi.runAllTimers())
    expect(back).not.toHaveBeenCalled()
    dialog.remove()
  })
})
