import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useHasHover, useIsTouch, hasHover, isTouchDevice } from './useHasHover'

/** Install a controllable matchMedia whose `matches` can be toggled at runtime. */
function mockMatchMedia(initial: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql = {
    matches: initial,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb)),
    removeEventListener: vi.fn((_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb)),
    dispatchEvent: vi.fn(),
  }
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockReturnValue(mql),
  })
  return {
    emit(next: boolean) {
      mql.matches = next
      listeners.forEach((cb) => cb({ matches: next } as MediaQueryListEvent))
    },
  }
}

describe('useHasHover / useIsTouch', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns true on a hovering, fine pointer (mouse)', () => {
    mockMatchMedia(true)
    const { result } = renderHook(() => useHasHover())
    expect(result.current).toBe(true)
  })

  it('returns false on a touch device (no hover / coarse pointer)', () => {
    mockMatchMedia(false)
    const { result } = renderHook(() => useHasHover())
    expect(result.current).toBe(false)
  })

  it('useIsTouch is the inverse of useHasHover', () => {
    mockMatchMedia(false)
    const { result } = renderHook(() => useIsTouch())
    expect(result.current).toBe(true)
  })

  it('reacts to a capability change (e.g. docking a mouse to a tablet)', () => {
    const mm = mockMatchMedia(false)
    const { result } = renderHook(() => useHasHover())
    expect(result.current).toBe(false)
    act(() => mm.emit(true))
    expect(result.current).toBe(true)
  })

  it('non-reactive helpers read the current capability', () => {
    mockMatchMedia(true)
    expect(hasHover()).toBe(true)
    expect(isTouchDevice()).toBe(false)
    mockMatchMedia(false)
    expect(hasHover()).toBe(false)
    expect(isTouchDevice()).toBe(true)
  })
})
