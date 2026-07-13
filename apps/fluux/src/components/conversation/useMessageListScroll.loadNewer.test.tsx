/**
 * @vitest-environment jsdom
 *
 * Sliding window: the load-newer scroll trigger. When the resident window is slid up
 * (windowAtLiveEdge === false), scrolling back down to the resident bottom must fetch the
 * next-newer cache slice; at the live edge the trigger is inert (bottom-stick unchanged).
 */
import React from 'react'
import { render, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMessageListScroll } from './useMessageListScroll'
import { scrollStateManager } from '@/utils/scrollStateManager'

interface Handle {
  handleScroll: () => void
  setScrollTop: (v: number) => void
}

// scrollHeight 1000, clientHeight 500 → distFromBottom = 500 - scrollTop.
// scrollTop 500 ⇒ distFromBottom 0 (at the resident bottom); scrollTop 100 ⇒ 400 (scrolled up).
function Harness({
  onLoadNewer,
  windowAtLiveEdge,
  isLoadingNewer,
  initialScrollTop,
  onReady,
}: {
  onLoadNewer?: () => void
  windowAtLiveEdge?: boolean
  isLoadingNewer?: boolean
  initialScrollTop: number
  onReady: (h: Handle) => void
}) {
  const scrollTopRef = React.useRef(initialScrollTop)
  const scrollerRef = React.useRef<HTMLDivElement | null>(null)

  const api = useMessageListScroll({
    conversationId: 'room@conf.example.com',
    messageCount: 20,
    firstMessageId: 'm-0',
    reactionsSignature: '',
    lastMessageId: 'm-19',
    onLoadNewer,
    isLoadingNewer,
    windowAtLiveEdge,
  })

  const setRef = React.useCallback((node: HTMLDivElement | null) => {
    scrollerRef.current = node
    if (node) {
      Object.defineProperty(node, 'scrollHeight', { get: () => 1000, configurable: true })
      Object.defineProperty(node, 'clientHeight', { get: () => 500, configurable: true })
      Object.defineProperty(node, 'scrollTop', {
        get: () => scrollTopRef.current,
        set: (v: number) => { scrollTopRef.current = v },
        configurable: true,
      })
      Object.defineProperty(node, 'scrollTo', { value: () => {}, configurable: true })
    }
    api.setScrollContainerRef(node)
  }, [api])

  React.useLayoutEffect(() => {
    onReady({
      handleScroll: () =>
        api.handleScroll({ currentTarget: scrollerRef.current } as unknown as React.UIEvent<HTMLDivElement>),
      setScrollTop: (v) => { scrollTopRef.current = v },
    })
  })

  return <div ref={setRef} onScroll={api.handleScroll} data-message-list />
}

function mount(props: Omit<Parameters<typeof Harness>[0], 'onReady'>): Handle {
  let handle!: Handle
  act(() => {
    render(<Harness {...props} onReady={(h) => { handle = h }} />)
  })
  return handle
}

describe('useMessageListScroll load-newer trigger', () => {
  beforeEach(() => scrollStateManager.reset())

  // Set scrollTop explicitly right before handleScroll: the hook's mount auto-scroll-to-bottom
  // otherwise overrides the initial value, so the geometry must be pinned at trigger time.
  const scrollAt = (h: Handle, scrollTop: number) => act(() => { h.setScrollTop(scrollTop); h.handleScroll() })

  it('fires onLoadNewer when scrolled to the resident bottom of a slid-up window', () => {
    const onLoadNewer = vi.fn()
    const h = mount({ onLoadNewer, windowAtLiveEdge: false, initialScrollTop: 0 })
    scrollAt(h, 500) // distFromBottom 0
    expect(onLoadNewer).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire at the live edge (windowAtLiveEdge true) — bottom-stick territory', () => {
    const onLoadNewer = vi.fn()
    const h = mount({ onLoadNewer, windowAtLiveEdge: true, initialScrollTop: 0 })
    scrollAt(h, 500)
    expect(onLoadNewer).not.toHaveBeenCalled()
  })

  it('does NOT fire when windowAtLiveEdge is undefined (default = at edge)', () => {
    const onLoadNewer = vi.fn()
    const h = mount({ onLoadNewer, initialScrollTop: 0 })
    scrollAt(h, 500)
    expect(onLoadNewer).not.toHaveBeenCalled()
  })

  it('does NOT fire while a newer load is already in flight', () => {
    const onLoadNewer = vi.fn()
    const h = mount({ onLoadNewer, windowAtLiveEdge: false, isLoadingNewer: true, initialScrollTop: 0 })
    scrollAt(h, 500)
    expect(onLoadNewer).not.toHaveBeenCalled()
  })

  it('does NOT fire when the reader is not near the resident bottom', () => {
    const onLoadNewer = vi.fn()
    const h = mount({ onLoadNewer, windowAtLiveEdge: false, initialScrollTop: 0 })
    scrollAt(h, 100) // distFromBottom 400
    expect(onLoadNewer).not.toHaveBeenCalled()
  })
})
