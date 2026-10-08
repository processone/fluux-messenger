import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWindowedList } from './useWindowedList'

const stateWrites = vi.hoisted(() => vi.fn())
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useState: (<T,>(initial: T | (() => T)) => {
      const [value, setValue] = react.useState(initial)
      const trackedSetter = react.useCallback((next: import('react').SetStateAction<T>) => {
        stateWrites()
        setValue(next)
      }, [setValue])
      return [value, trackedSetter]
    }) as typeof react.useState,
  }
})

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
    act(() => {
      result.current.loadMore()
      result.current.loadMore()
    })
    expect(result.current.visible).toHaveLength(80)
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

  it('does not render again for an unchanged reset after the window shrinks', () => {
    let renders = 0
    const { result, rerender } = renderHook(
      ({ list, key }) => {
        renders++
        return useWindowedList(list, { initial: 20, step: 20, resetKey: key })
      },
      { initialProps: { list: items, key: 'a' } }
    )
    act(() => result.current.loadMore())
    rerender({ list: items, key: 'b' })
    expect(result.current.visible).toHaveLength(20)

    const before = renders
    // React can eagerly bail out a no-op dispatch; count requests as well as renders.
    stateWrites.mockClear()
    rerender({ list: [...items, 100], key: 'c' })
    expect(stateWrites).not.toHaveBeenCalled()
    expect(renders - before).toBe(1)
    expect(result.current.visible).toHaveLength(20)
  })

  it('resets a grown window when the list length or initial count changes', () => {
    const { result, rerender } = renderHook(
      ({ list, initial }) => useWindowedList(list, { initial, step: 20 }),
      { initialProps: { list: items, initial: 20 } }
    )
    act(() => result.current.loadMore())
    rerender({ list: items.slice(0, 60), initial: 20 })
    expect(result.current.visible).toHaveLength(20)
    act(() => result.current.loadMore())
    rerender({ list: items.slice(0, 60), initial: 10 })
    expect(result.current.visible).toHaveLength(10)
  })
})
