/**
 * @vitest-environment jsdom
 *
 * Single-flight invariant for the message-list rAF scroll re-assert loops.
 *
 * The list keeps the virtualized view pinned by re-asserting a scroll target across ~1s of
 * frames (the controller-owned live-edge executor → bottom; the controller-owned directional
 * executor → a history anchor). When two of these run at once they fight over scrollTop — the
 * `[ScrollReassertLoop]`
 * overlap the reassert monitor warns about, observed in the wild as `(pin-bottom, pin-bottom)`.
 * pin-bottom was made single-flight against itself; this suite pins the FULL invariant: across
 * any rapid multi-trigger sequence, at most ONE re-assert loop is ever active — including the
 * still-open cases (`prepend` vs `prepend`, and `pin-bottom` vs `prepend`, whose targets
 * contradict each other).
 *
 * Mechanism: the reassert monitor is mocked to track the peak number of concurrently-active
 * loops via begin()/end(). jsdom has no layout, so this is a structural (loop-lifecycle)
 * guard, not a pixel one.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { MessageList } from './MessageList'
import type { BaseMessage } from '@fluux/sdk'

// Peak-concurrency tracker injected via the mocked monitor. begin() bumps the active count and
// records the high-water mark; end() releases. The fix must keep the peak at 1.
const loopTracker = { active: 0, peak: 0, begins: [] as string[] }

vi.mock('./reassertLoopMonitor', () => ({
  createReassertLoopMonitor: () => ({
    begin: (label: string) => {
      loopTracker.begins.push(label)
      loopTracker.active += 1
      loopTracker.peak = Math.max(loopTracker.peak, loopTracker.active)
      let ended = false
      return {
        frame: () => null,
        end: () => {
          if (ended) return
          ended = true
          loopTracker.active -= 1
        },
      }
    },
    activeLabels: () => [],
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/hooks', () => ({
  useMessageCopyFormatter: vi.fn(),
  useMessageRangeSelection: vi.fn(() => ({
    copySelectedIds: new Set<string>(),
    selectionCount: 0,
    isSelecting: false,
    selectAll: vi.fn(),
    extendTo: vi.fn(),
    clearSelection: vi.fn(),
    copySelected: vi.fn(),
  })),
}))

const getOffsetForMessageId = vi.fn((_id: string): number | null => 0)
const scrollToOffsetCalls: number[] = []
vi.mock('./tanstackMessageVirtualizer', () => ({
  useTanstackMessageVirtualizer: (args: { items: { key: string }[]; scrollRef: React.RefObject<HTMLElement | null> }) => ({
    getVirtualItems: () => args.items.map((it, index) => ({ index, start: index * 40, size: 40, key: it.key })),
    getTotalSize: () => args.items.length * 40,
    itemCount: args.items.length,
    getOffsetForMessageId,
    ensureMessageMounted: vi.fn(() => Promise.resolve()),
    measureElement: () => {},
    scrollToOffset: (offset: number) => {
      scrollToOffsetCalls.push(offset)
      const el = args.scrollRef.current
      if (el) el.scrollTop = offset
    },
    scrollToIndex: (index: number, opts?: { align?: string }) => {
      const el = args.scrollRef.current
      if (!el) return
      el.scrollTop = opts?.align === 'end' ? el.scrollHeight : index * 40
    },
  }),
}))

function makeMessages(count: number, prefix = 'msg'): BaseMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    from: 'user@example.com',
    body: `Body ${i}`,
    timestamp: new Date(2024, 0, 1, 12, i % 60),
    isOutgoing: false,
    type: 'chat' as const,
  }))
}

describe('MessageList — re-assert loops are single-flight (at most one active)', () => {
  let realRaf: typeof requestAnimationFrame
  let rafQueue: FrameRequestCallback[]
  const flush = (frames: number) => {
    for (let i = 0; i < frames; i++) rafQueue.splice(0).forEach((cb) => cb(0))
  }

  beforeEach(() => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    HTMLElement.prototype.scrollTo = vi.fn()
    rafQueue = []
    realRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    }) as typeof requestAnimationFrame
    loopTracker.active = 0
    loopTracker.peak = 0
    loopTracker.begins = []
    scrollToOffsetCalls.length = 0
    getOffsetForMessageId.mockClear()
    getOffsetForMessageId.mockImplementation(() => 0)
  })
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf
    localStorage.clear()
  })

  function instrumentScroller(scroller: HTMLElement, height: number) {
    let scrollTopVal = 0
    Object.defineProperty(scroller, 'scrollHeight', { get: () => height, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTopVal,
      set: (v: number) => { scrollTopVal = v },
      configurable: true,
    })
    return {
      get: () => scrollTopVal,
      set: (value: number) => {
        scrollTopVal = value
      },
    }
  }

  const props = {
    renderMessage: (m: BaseMessage) => <div>{m.body}</div>,
    onScrollToTop: vi.fn(),
    isHistoryComplete: false,
  }

  it('does not start a second prepend re-assert loop while the first is still running', () => {
    const { container, getByText, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-pp" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    // First load-older -> older messages prepended -> the controller begins its directional loop.
    fireEvent.click(getByText('chat.loadEarlierMessages'))
    rerender(<MessageList messages={[...makeMessages(10, 'older1'), ...makeMessages(50)]} conversationId="conv-pp" {...props} />)
    flush(2) // a couple of frames pass; the first loop still has ~58 frames left

    // Second load-older BEFORE the first settles -> a second prepend restore. It must supersede
    // the first, not run alongside it. Each accepted generation has an exact cancellation lease.
    fireEvent.click(getByText('chat.loadEarlierMessages'))
    rerender(<MessageList messages={[...makeMessages(10, 'older2'), ...makeMessages(10, 'older1'), ...makeMessages(50)]} conversationId="conv-pp" {...props} />)

    expect(loopTracker.begins.filter((l) => l === 'prepend').length).toBeGreaterThanOrEqual(2)
    expect(loopTracker.peak).toBeLessThanOrEqual(1)
  })

  it('does not run a pin-bottom loop concurrently with an in-flight prepend loop', () => {
    const { container, getByText, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-mix" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    // Load older -> the directional controller begins the monitor's 'prepend' loop.
    fireEvent.click(getByText('chat.loadEarlierMessages'))
    rerender(<MessageList messages={[...makeMessages(10, 'older1'), ...makeMessages(50)]} conversationId="conv-mix" {...props} />)
    flush(2) // prepend loop in-flight

    // A SENT (outgoing) message arrives while the prepend loop is still running -> the outgoing
    // path forces a controller-owned scroll-to-bottom. pin-bottom and prepend target
    // opposite positions, so they must not coexist.
    const sent: BaseMessage = {
      id: 'sent-1', from: 'me@example.com', body: 'my reply',
      timestamp: new Date(2024, 0, 1, 13, 0), isOutgoing: true, type: 'chat',
    }
    rerender(<MessageList messages={[...makeMessages(10, 'older1'), ...makeMessages(50), sent]} conversationId="conv-mix" {...props} />)

    expect(loopTracker.begins).toContain('pin-bottom')
    expect(loopTracker.peak).toBeLessThanOrEqual(1)
  })

  it('re-pins the directional anchor after a content-shrink clamp without treating it as takeover', () => {
    getOffsetForMessageId.mockImplementation((id) =>
      id === 'msg-0' ? 0 : null,
    )
    const { container, getByText, rerender } = render(
      <MessageList
        messages={makeMessages(50)}
        conversationId="conv-clamp"
        {...props}
      />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    const geometry = instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    fireEvent.click(getByText('chat.loadEarlierMessages'))
    getOffsetForMessageId.mockImplementation((id) =>
      id === 'msg-0' ? 1000 : null,
    )
    rerender(
      <MessageList
        messages={[...makeMessages(10, 'older'), ...makeMessages(50)]}
        conversationId="conv-clamp"
        {...props}
      />,
    )
    expect(scrollToOffsetCalls).toContain(1000)

    scrollToOffsetCalls.length = 0
    geometry.set(4500) // browser clamp after content shrink; no genuine input event
    flush(1)

    expect(scrollToOffsetCalls).toContain(1000)
    expect(geometry.get()).toBe(1000)
  })
})
