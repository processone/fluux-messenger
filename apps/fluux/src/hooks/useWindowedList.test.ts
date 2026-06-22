import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWindowedList } from './useWindowedList'

const items = Array.from({ length: 100 }, (_, i) => i)

describe('useWindowedList', () => {
  it('shows the initial window and reports hasMore', () => {
    const { result } = renderHook(() => useWindowedList(items, { initial: 20, step: 20 }))
    expect(result.current.visible).toHaveLength(20)
    expect(result.current.hasMore).toBe(true)
  })

  it('grows by step on loadMore and stops at the end', () => {
    const { result } = renderHook(() => useWindowedList(items, { initial: 20, step: 20 }))
    act(() => result.current.loadMore())
    expect(result.current.visible).toHaveLength(40)
    for (let i = 0; i < 10; i++) act(() => result.current.loadMore())
    expect(result.current.visible).toHaveLength(100)
    expect(result.current.hasMore).toBe(false)
  })

  it('resets the window when resetKey changes', () => {
    const { result, rerender } = renderHook(
      ({ key }) => useWindowedList(items, { initial: 20, step: 20, resetKey: key }),
      { initialProps: { key: 'a' } }
    )
    act(() => result.current.loadMore())
    expect(result.current.visible).toHaveLength(40)
    rerender({ key: 'b' })
    expect(result.current.visible).toHaveLength(20)
  })
})
