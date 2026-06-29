import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useModalTransition, MODAL_EXIT_MS } from './useModalTransition'

function setMotion(value: 'full' | 'reduced') {
  document.documentElement.setAttribute('data-motion', value)
}

describe('useModalTransition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setMotion('full')
  })
  afterEach(() => {
    vi.useRealTimers()
    document.documentElement.removeAttribute('data-motion')
  })

  it('starts with the enter classes and not closing', () => {
    const { result } = renderHook(() => useModalTransition())
    expect(result.current.panelClass).toBe('modal-panel-in')
    expect(result.current.scrimClass).toBe('scrim-in')
    expect(result.current.isClosing).toBe(false)
  })

  it('honors a custom enter class', () => {
    const { result } = renderHook(() => useModalTransition({ panelInClass: 'command-palette-in' }))
    expect(result.current.panelClass).toBe('command-palette-in')
  })

  it('plays the exit then calls onClose after the exit duration (motion full)', () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useModalTransition())
    act(() => result.current.requestClose(onClose))
    expect(result.current.panelClass).toBe('modal-panel-out')
    expect(result.current.scrimClass).toBe('scrim-out')
    expect(onClose).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(MODAL_EXIT_MS) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes immediately with no exit when motion is reduced', () => {
    setMotion('reduced')
    const onClose = vi.fn()
    const { result } = renderHook(() => useModalTransition())
    act(() => result.current.requestClose(onClose))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(result.current.isClosing).toBe(false)
  })

  it('guards against a double close', () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useModalTransition())
    act(() => {
      result.current.requestClose(onClose)
      result.current.requestClose(onClose)
    })
    act(() => { vi.advanceTimersByTime(MODAL_EXIT_MS) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
