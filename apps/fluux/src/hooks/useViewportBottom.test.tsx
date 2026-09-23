import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useViewportBottom } from '@/hooks/useViewportBottom'
import { isViewportAtBottom, _resetViewportRegistryForTesting } from '@/utils/viewportAtBottom'

/**
 * The registry is the only path `useWindowVisibility` has to this state: it runs on focus
 * regain, outside React, and decides whether a reader who came back to the window was actually
 * looking at the newest message. A view that fails to publish reads as `false` forever, which
 * silently stops marking conversations read — so publication is the contract under test here,
 * not an implementation detail of the hook.
 */
describe('useViewportBottom', () => {
  beforeEach(() => {
    _resetViewportRegistryForTesting()
  })

  it('publishes the view value under the active entity', () => {
    const { result } = renderHook(() => useViewportBottom('conversation', 'alice@example.com'))

    expect(isViewportAtBottom('conversation', 'alice@example.com')).toBe(true)

    result.current.assume(false)
    // Read through the registered ref, so a decision reaches the global reader without a render.
    expect(isViewportAtBottom('conversation', 'alice@example.com')).toBe(false)
  })

  it('answers false for an entity no view is showing', () => {
    renderHook(() => useViewportBottom('room', 'room@conference.example.com'))

    // Never invent a position for a view we cannot see — including the other kind's namespace.
    expect(isViewportAtBottom('conversation', 'room@conference.example.com')).toBe(false)
    expect(isViewportAtBottom('room', 'other@conference.example.com')).toBe(false)
  })

  it('moves its publication when the view switches entity', () => {
    const { rerender } = renderHook(({ id }) => useViewportBottom('conversation', id), {
      initialProps: { id: 'alice@example.com' },
    })

    rerender({ id: 'bob@example.com' })

    expect(isViewportAtBottom('conversation', 'bob@example.com')).toBe(true)
    expect(isViewportAtBottom('conversation', 'alice@example.com')).toBe(false)
  })

  it('stops answering once the view unmounts', () => {
    const { unmount } = renderHook(() => useViewportBottom('conversation', 'alice@example.com'))
    expect(isViewportAtBottom('conversation', 'alice@example.com')).toBe(true)

    unmount()

    expect(isViewportAtBottom('conversation', 'alice@example.com')).toBe(false)
  })

  it('keeps one value across an entity switch, so entry arbitration is the only thing that decides', () => {
    const { result, rerender } = renderHook(({ id }) => useViewportBottom('conversation', id), {
      initialProps: { id: 'alice@example.com' },
    })
    result.current.assume(false)

    rerender({ id: 'bob@example.com' })

    // The scroll hook's entry effect positions the newly opened conversation and writes this
    // value itself. Resetting it here would answer that question twice, from a stale reading.
    expect(isViewportAtBottom('conversation', 'bob@example.com')).toBe(false)
  })
})
