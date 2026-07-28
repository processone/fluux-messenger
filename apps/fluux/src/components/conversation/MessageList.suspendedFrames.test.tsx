/**
 * @vitest-environment jsdom
 *
 * BOTTOM-STICK MUST NOT DEPEND ON FRAME DELIVERY.
 *
 * A backgrounded window stops receiving `requestAnimationFrame` callbacks while
 * messages keep arriving and React keeps committing. The live-edge follow has to
 * survive that: it is applied synchronously when the list grows, and the rAF
 * re-assert loop only settles the measurement afterwards. If the follow ever
 * moves into the frame loop, a conversation read at the live edge would be found
 * stranded above it on return — with every intervening message counted unread.
 *
 * Suspending frames is simulated by not draining the fake rAF queue across the
 * appends, then draining it once frames resume. Both moments are asserted: the
 * one during suspension is what actually proves the follow is frame-independent.
 *
 * Harness (mocked virtualizer, fake rAF queue, instrumented scroller geometry)
 * mirrors MessageList.pinBottomBehavior.test.tsx.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { MessageList } from './MessageList'
import type { BaseMessage } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))
vi.mock('@/hooks', () => ({
  useMessageCopyFormatter: vi.fn(),
  useMessageRangeSelection: vi.fn(() => ({
    copySelectedIds: new Set<string>(), selectionCount: 0, isSelecting: false,
    selectAll: vi.fn(), extendTo: vi.fn(), clearSelection: vi.fn(), copySelected: vi.fn(),
  })),
}))
vi.mock('./tanstackMessageVirtualizer', () => ({
  useTanstackMessageVirtualizer: (args: { items: { key: string }[]; scrollRef: React.RefObject<HTMLElement | null> }) => ({
    getVirtualItems: () => args.items.map((it, index) => ({ index, start: index * 40, size: 40, key: it.key })),
    getTotalSize: () => args.items.length * 40,
    itemCount: args.items.length,
    getOffsetForMessageId: () => 0,
    getIndexForMessageId: (id: string) => { const i = args.items.findIndex((it) => it.key === id); return i >= 0 ? i : null },
    ensureMessageMounted: vi.fn(() => Promise.resolve()),
    measureElement: () => {},
    scrollToOffset: (offset: number) => { const el = args.scrollRef.current; if (el) el.scrollTop = offset },
    beginAnimatedScrollToOffset: (offset: number) => { const el = args.scrollRef.current; if (el) el.scrollTop = offset },
    scrollToIndex: (index: number, opts?: { align?: string }) => {
      const el = args.scrollRef.current; if (!el) return
      if (opts?.align === 'end') el.scrollTop = el.scrollHeight
      else el.scrollTop = index * 40
    },
  }),
}))

const ROW = 40
const RESIDENT = 50
// Matches the reported incident: a room read to the live edge, then thirteen
// messages while the window was in the background.
const ARRIVALS_WHILE_SUSPENDED = 13

function makeMessages(count: number): BaseMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`, from: 'user@example.com', body: `Body ${i}`,
    timestamp: new Date(2024, 0, 1, 12, i % 60), isOutgoing: false, type: 'chat' as const,
  }))
}

describe('MessageList — live-edge follow with frames suspended', () => {
  let realRaf: typeof requestAnimationFrame
  let rafQueue: FrameRequestCallback[]
  const flush = (frames: number) => { for (let i = 0; i < frames; i++) rafQueue.splice(0).forEach((cb) => cb(0)) }

  const geo = { scrollHeight: RESIDENT * ROW, clientHeight: 500 }
  const bottom = () => geo.scrollHeight - geo.clientHeight

  function instrumentScroller(scroller: HTMLElement) {
    let top = 0
    Object.defineProperty(scroller, 'scrollHeight', { get: () => geo.scrollHeight, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { get: () => geo.clientHeight, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => top,
      set: (v: number) => { top = Math.max(0, Math.min(v, geo.scrollHeight - geo.clientHeight)) },
      configurable: true,
    })
    Object.defineProperty(scroller, 'offsetHeight', { get: () => 0, configurable: true })
  }

  beforeEach(() => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    HTMLElement.prototype.scrollTo = vi.fn()
    rafQueue = []
    realRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length }) as typeof requestAnimationFrame
    geo.scrollHeight = RESIDENT * ROW
    geo.clientHeight = 500
  })
  afterEach(() => { globalThis.requestAnimationFrame = realRaf; localStorage.clear() })

  const props = { renderMessage: (m: BaseMessage) => <div>{m.body}</div>, onScrollToTop: vi.fn(), isHistoryComplete: false }

  it('keeps the live edge while messages arrive and no frame is delivered', () => {
    const isAtBottomRef = { current: true }
    let messages = makeMessages(RESIDENT)
    const view = render(
      <MessageList messages={messages} conversationId="conv-suspended-frames" isAtBottomRef={isAtBottomRef} {...props} />,
    )
    const scroller = view.container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)
    flush(70) // settle the entry pin
    expect(scroller.scrollTop).toBe(bottom())

    // Window goes to the background: React still commits, frames stop arriving.
    for (let i = 0; i < ARRIVALS_WHILE_SUSPENDED; i++) {
      messages = [...messages, {
        id: `late-${i}`, from: 'other@example.com', body: `Late ${i}`,
        timestamp: new Date(2024, 0, 1, 13, i), isOutgoing: false, type: 'chat' as const,
      }]
      geo.scrollHeight += ROW
      view.rerender(
        <MessageList messages={messages} conversationId="conv-suspended-frames" isAtBottomRef={isAtBottomRef} {...props} />,
      )
    }

    // The follow is synchronous, so the view tracks the growing content with a
    // frame backlog still pending. This is the assertion that fails first if the
    // follow is ever moved into the rAF loop.
    expect(rafQueue.length).toBeGreaterThan(0)
    expect(scroller.scrollTop).toBe(bottom())
    expect(isAtBottomRef.current).toBe(true)

    // Frames resume: the backlog settles without moving the view off the edge.
    flush(70)
    expect(scroller.scrollTop).toBe(bottom())
    expect(isAtBottomRef.current).toBe(true)
  })
})
