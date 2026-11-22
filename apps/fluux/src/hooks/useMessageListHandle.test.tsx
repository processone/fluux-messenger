import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMessageListHandle } from '@/hooks/useMessageListHandle'
import { listHandleOver } from '@/components/conversation/MessageList.test-utils'
import { isViewportAtBottom, _resetViewportRegistryForTesting } from '@/utils/viewportAtBottom'

/**
 * The registry is the only path `useWindowVisibility` has to this state: it runs on focus
 * regain, outside React, and decides whether a reader who came back to the window was actually
 * looking at the newest message. A view that fails to publish reads as `false` forever, which
 * silently stops marking conversations read — so publication is the contract under test here,
 * not an implementation detail of the hook.
 */
describe('useMessageListHandle', () => {
  beforeEach(() => {
    _resetViewportRegistryForTesting()
  })

  /** Mount the list the hook's ref is for: what MessageList does through `handleRef`. */
  function mountList(ref: { current: unknown }, atBottom: { value: boolean }) {
    const handle = listHandleOver()
    handle.current.isAtBottom = () => atBottom.value
    ref.current = handle.current
  }

  it('publishes what the mounted list answers under the active entity', () => {
    const atBottom = { value: true }
    const { result } = renderHook(() => useMessageListHandle('conversation', 'alice@example.com'))
    mountList(result.current, atBottom)

    expect(isViewportAtBottom('conversation', 'alice@example.com')).toBe(true)

    // Read through the handle at read time, so a move reaches the global reader without a render.
    atBottom.value = false
    expect(isViewportAtBottom('conversation', 'alice@example.com')).toBe(false)
  })

  it('answers false while no list is mounted', () => {
    renderHook(() => useMessageListHandle('conversation', 'alice@example.com'))

    // Never invent a position for a view we cannot see.
    expect(isViewportAtBottom('conversation', 'alice@example.com')).toBe(false)
  })

  it('answers false for an entity no view is showing, in either namespace', () => {
    const { result } = renderHook(() => useMessageListHandle('room', 'room@conference.example.com'))
    mountList(result.current, { value: true })

    expect(isViewportAtBottom('conversation', 'room@conference.example.com')).toBe(false)
    expect(isViewportAtBottom('room', 'other@conference.example.com')).toBe(false)
  })

  it('moves its publication when the view switches entity', () => {
    const { result, rerender } = renderHook(({ id }) => useMessageListHandle('conversation', id), {
      initialProps: { id: 'alice@example.com' },
    })
    mountList(result.current, { value: true })

    rerender({ id: 'bob@example.com' })

    expect(isViewportAtBottom('conversation', 'bob@example.com')).toBe(true)
    expect(isViewportAtBottom('conversation', 'alice@example.com')).toBe(false)
  })

  it('stops answering once the view unmounts', () => {
    const { result, unmount } = renderHook(() => useMessageListHandle('conversation', 'alice@example.com'))
    mountList(result.current, { value: true })
    expect(isViewportAtBottom('conversation', 'alice@example.com')).toBe(true)

    unmount()

    expect(isViewportAtBottom('conversation', 'alice@example.com')).toBe(false)
  })
})
