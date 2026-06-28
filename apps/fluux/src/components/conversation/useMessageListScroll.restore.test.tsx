/**
 * @vitest-environment jsdom
 */
import React from 'react'
import { render, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useMessageListScroll,
  type UseMessageListScrollResult,
} from './useMessageListScroll'
import { scrollStateManager } from '@/utils/scrollStateManager'

class MockResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
  fire() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

interface HarnessHandle {
  api: UseMessageListScrollResult
  scroller: HTMLDivElement
  scrollTopSets: number[]
  getScrollTop: () => number
}

interface HookHarnessProps {
  conversationId: string
  ids: string[]
  firstNewMessageId?: string
  clearFirstNewMessageId?: () => void
  scrollHeight?: number
  clientHeight?: number
  initialScrollTop?: number
  onReady: (handle: HarnessHandle) => void
}

function seedSavedScrollPosition(conversationId: string, scrollTop = 200) {
  scrollStateManager.enterConversation(conversationId, 10)
  scrollStateManager.leaveConversation(conversationId, scrollTop, 1000, 500)
}

function HookHarness({
  conversationId,
  ids,
  firstNewMessageId,
  clearFirstNewMessageId,
  scrollHeight = 1000,
  clientHeight = 500,
  initialScrollTop = 0,
  onReady,
}: HookHarnessProps) {
  const geometryRef = React.useRef({ scrollHeight, clientHeight })
  geometryRef.current = { scrollHeight, clientHeight }
  const scrollTopRef = React.useRef(initialScrollTop)
  const scrollTopSetsRef = React.useRef<number[]>([])
  const scrollerRef = React.useRef<HTMLDivElement | null>(null)

  const api = useMessageListScroll({
    conversationId,
    messageCount: ids.length,
    firstMessageId: ids[0],
    firstNewMessageId,
    clearFirstNewMessageId,
    typingUsersCount: 0,
    lastMessageReactionsKey: '',
    lastMessageId: ids.at(-1),
  })

  const setScrollContainerRef = api.setScrollContainerRef
  const setScrollerRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef.current = node
      if (node) {
        Object.defineProperty(node, 'scrollHeight', {
          get: () => geometryRef.current.scrollHeight,
          configurable: true,
        })
        Object.defineProperty(node, 'clientHeight', {
          get: () => geometryRef.current.clientHeight,
          configurable: true,
        })
        Object.defineProperty(node, 'scrollTop', {
          get: () => scrollTopRef.current,
          set: (value: number) => {
            scrollTopRef.current = value
            scrollTopSetsRef.current.push(value)
          },
          configurable: true,
        })
        Object.defineProperty(node, 'scrollTo', {
          value: (options: ScrollToOptions | number) => {
            const top = typeof options === 'number' ? options : options.top
            if (typeof top === 'number') {
              node.scrollTop = top
            }
          },
          configurable: true,
        })
      }
      setScrollContainerRef(node)
    },
    [setScrollContainerRef],
  )

  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    onReady({
      api,
      scroller,
      scrollTopSets: scrollTopSetsRef.current,
      getScrollTop: () => scrollTopRef.current,
    })
  })

  return (
    <div ref={setScrollerRef} onScroll={api.handleScroll} data-message-list>
      {ids.length > 0 && (
        <div ref={api.contentWrapperRef}>
          {ids.map((id, index) => (
            <div
              key={id}
              ref={(node) => {
                if (!node) return
                Object.defineProperty(node, 'offsetTop', { value: index * 40, configurable: true })
                Object.defineProperty(node, 'offsetHeight', { value: 40, configurable: true })
              }}
              className="message-row"
              data-message-id={id}
            />
          ))}
        </div>
      )}
    </div>
  )
}

describe('useMessageListScroll saved-position restore', () => {
  let realRaf: typeof requestAnimationFrame

  beforeEach(() => {
    scrollStateManager.reset()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    realRaf = window.requestAnimationFrame
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    }
  })

  afterEach(() => {
    window.requestAnimationFrame = realRaf
    vi.unstubAllGlobals()
  })

  it('keeps a saved room restore pending until rows are mounted', () => {
    seedSavedScrollPosition('room-pending', 200)
    let handle: HarnessHandle | undefined

    const { rerender } = render(
      <HookHarness
        conversationId="room-pending"
        ids={[]}
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.scrollTopSets).not.toContain(1000)
    expect(scrollStateManager.getSavedScrollTop('room-pending')).toBe(200)

    handle?.scrollTopSets.splice(0)
    rerender(
      <HookHarness
        conversationId="room-pending"
        ids={['msg-0', 'msg-1', 'msg-2']}
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.scrollTopSets).toContain(200)
    expect(handle?.scrollTopSets).not.toContain(1000)
  })

  it('can restore the same scrolled-up room again without an intervening scroll event', () => {
    seedSavedScrollPosition('room-repeat-hook', 200)
    let handle: HarnessHandle | undefined

    const { rerender } = render(
      <HookHarness
        conversationId="room-repeat-hook"
        ids={['msg-0', 'msg-1', 'msg-2']}
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.scrollTopSets).toContain(200)
    expect(scrollStateManager.getSavedScrollTop('room-repeat-hook')).toBe(200)

    handle?.scrollTopSets.splice(0)
    rerender(
      <HookHarness
        conversationId="room-other-hook"
        ids={['other-0', 'other-1']}
        onReady={(next) => { handle = next }}
      />,
    )

    handle?.scrollTopSets.splice(0)
    rerender(
      <HookHarness
        conversationId="room-repeat-hook"
        ids={['msg-0', 'msg-1', 'msg-2']}
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.scrollTopSets).toContain(200)
    expect(handle?.scrollTopSets).not.toContain(1000)
  })

  it('clears restored scrolled-up state only after explicit bottom intent', () => {
    seedSavedScrollPosition('room-bottom-intent', 200)
    let handle: HarnessHandle | undefined

    render(
      <HookHarness
        conversationId="room-bottom-intent"
        ids={['msg-0', 'msg-1', 'msg-2']}
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.scrollTopSets).toContain(200)
    expect(scrollStateManager.getSavedScrollTop('room-bottom-intent')).toBe(200)

    act(() => {
      handle?.api.scrollToBottom()
    })

    expect(handle?.getScrollTop()).toBe(1000)
    expect(scrollStateManager.getSavedScrollTop('room-bottom-intent')).toBeNull()
  })
})
