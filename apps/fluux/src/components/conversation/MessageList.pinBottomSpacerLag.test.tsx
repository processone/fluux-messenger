/**
 * @vitest-environment jsdom
 *
 * Cold-open send-stick: the bottom pin must not settle at a FALSE distFromBottom=0.
 *
 * The reported bug (Tauri/WebKit, 1:1 chat, first open of a conversation this session): you open a
 * conversation, it lands at the bottom, you send a message — and the just-sent message stays a row
 * below the fold. Leaving and re-opening the same conversation fixes it.
 *
 * Root cause (confirmed by an on-device [Scroll] trace): on a COLD first open the tail row measures
 * TALLER than its estimate only AFTER the pin scrolls. The virtualizer's getTotalSize() grows
 * immediately (measureElement's ResizeObserver, forced by flushTailLayout), but the DOM spacer that
 * backs `scroller.scrollHeight` only catches up on the next React commit — and scrollTop is clamped
 * to the still-short spacer. So `pinVirtualizedBottom` read `scrollHeight - scrollTop - clientHeight`
 * as 0 and settled ("PIN settled distFromBottom: 0"), while the real gap was ~121px ("saveScroll…
 * distanceFromBottom: 121") and nothing re-pinned once the spacer grew. On a WARM re-open the heights
 * are seeded, getTotalSize() never leads scrollHeight, and the same 0 is truthful.
 *
 * The fix keys the pin's settle on the AUTHORITATIVE height (max of the DOM spacer and the
 * virtualizer's getTotalSize()) and keeps the loop ALIVE while that gap exceeds tolerance — but it does
 * NOT re-pin every frame: each scrollToIndex re-windows @tanstack and forces a re-render (see the
 * adapter), so while merely waiting for the spacer to commit it idle-polls (read-only flushTailLayout)
 * and writes only when the reachable bottom moves. When the spacer finally commits it lands the true
 * bottom with a single write.
 *
 * jsdom has no layout, so this drives the divergence explicitly: getTotalSize() is held ABOVE the
 * instrumented scrollHeight, and scrollToIndex('end') clamps scrollTop to the DOM spacer.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { MessageList } from './MessageList'
import type { BaseMessage } from '@fluux/sdk'

// Live-mutable virtualizer state the test controls: `totalSize` is the virtualizer's authoritative
// content height (leads the DOM spacer on a cold measure). `endCalls` counts scrollToIndex('end')
// re-pins so a test can prove the pin does NOT re-pin (re-window + re-render) every frame while it
// merely waits for the spacer to commit.
const virt = { totalSize: 2000 }
const endCalls = { count: 0 }

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

vi.mock('./tanstackMessageVirtualizer', () => ({
  useTanstackMessageVirtualizer: (args: { items: { key: string }[]; scrollRef: React.RefObject<HTMLElement | null> }) => ({
    getVirtualItems: () => args.items.map((it, index) => ({ index, start: index * 40, size: 40, key: it.key })),
    // Authoritative height, driven by the test — held ABOVE scrollHeight to model the cold-open lag.
    getTotalSize: () => virt.totalSize,
    itemCount: args.items.length,
    getOffsetForMessageId: () => 0,
    getIndexForMessageId: (id: string) => {
      const i = args.items.findIndex((it) => it.key === id)
      return i >= 0 ? i : null
    },
    ensureMessageMounted: vi.fn(() => Promise.resolve()),
    measureElement: () => {},
    scrollToOffset: (offset: number) => { const el = args.scrollRef.current; if (el) el.scrollTop = offset },
    // Real browsers clamp scrollTop to the DOM element's scrollHeight (the spacer), NOT to the
    // virtualizer's getTotalSize. So 'end' can only reach the CURRENT (possibly stale-short) spacer.
    scrollToIndex: (_index: number, opts?: { align?: string }) => {
      const el = args.scrollRef.current
      if (!el) return
      if (opts?.align === 'end') {
        endCalls.count += 1
        el.scrollTop = el.scrollHeight // clamped by the scrollTop setter below
      } else {
        el.scrollTop = _index * 40
      }
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

describe('MessageList — bottom pin keys on the authoritative height, not the lagged DOM spacer', () => {
  let realRaf: typeof requestAnimationFrame
  let rafQueue: FrameRequestCallback[]
  const flush = (frames: number) => {
    for (let i = 0; i < frames; i++) rafQueue.splice(0).forEach((cb) => cb(0))
  }

  // A scroller whose scrollHeight is a mutable "DOM spacer" the test can grow to model the React
  // commit catching up. scrollTop is clamped to [0, scrollHeight - clientHeight] like a browser.
  function instrumentScroller(scroller: HTMLElement, initialHeight: number) {
    const state = { height: initialHeight, top: 0 }
    Object.defineProperty(scroller, 'scrollHeight', { get: () => state.height, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => state.top,
      set: (v: number) => { state.top = Math.max(0, Math.min(v, state.height - 500)) },
      configurable: true,
    })
    return {
      setSpacerHeight: (h: number) => { state.height = h },
      get distFromBottom() { return state.height - state.top - 500 },
    }
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
    virt.totalSize = 2000
    endCalls.count = 0
  })
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf
    localStorage.clear()
  })

  const baseProps = {
    renderMessage: (m: BaseMessage) => <div>{m.body}</div>,
    onScrollToTop: vi.fn(),
    isHistoryComplete: false,
  }

  it('stays alive past the normal budget and lands the true bottom when the spacer commits late', () => {
    // CORRECTNESS (the bug fix). RED on the old loop: it exited after 60 frames, so a spacer that
    // committed later left the just-sent row stranded. GREEN now: the loop stays alive on the
    // authoritative gap and re-pins the instant the spacer grows.
    const isAtBottomRef = { current: true }
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-late" isAtBottomRef={isAtBottomRef} {...baseProps} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    const probe = instrumentScroller(scroller, 2000)

    // Let the entry pin settle at a matched height (spacer == getTotalSize), then start clean.
    flush(70)
    endCalls.count = 0

    // COLD SEND: the just-sent row measures taller — the virtualizer knows (getTotalSize jumps to
    // 2300) but the DOM spacer is still the pre-commit 2000, and scrollTop clamps to it (dist 0).
    virt.totalSize = 2300
    const sent: BaseMessage = {
      id: 'sent-1', from: 'me@example.com', body: 'hello', isOutgoing: true, type: 'chat',
      timestamp: new Date(2024, 0, 1, 13, 0),
    }
    rerender(
      <MessageList messages={[...makeMessages(50), sent]} conversationId="conv-late" isAtBottomRef={isAtBottomRef} {...baseProps} />,
    )

    // The spacer commits LATE — well past the old 60-frame budget, as a cold open can.
    flush(100)
    probe.setSpacerHeight(2300)
    flush(40)

    // The still-running pin scrolls to the real bottom: scrollTop = 1800, dist 0 against the TRUE
    // height — the just-sent message is fully in view.
    expect(scroller.scrollTop).toBe(1800)
    expect(probe.distFromBottom).toBe(0)
    expect(isAtBottomRef.current).toBe(true)
  })

  it('does not re-pin every frame while the spacer lags (no per-frame re-window / re-render)', () => {
    // PERFORMANCE. Each scrollToIndex('end') re-windows @tanstack and forces a re-render (the adapter
    // pushes the offset back in), so re-pinning on every frame of the wait would be a re-render storm.
    // While the spacer is stale-short, scrollTop is already clamped to its bottom, so the pin has
    // nothing to write — it must idle-poll (read-only flushTailLayout) and leave scrollToIndex alone.
    const isAtBottomRef = { current: true }
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-nothrash" isAtBottomRef={isAtBottomRef} {...baseProps} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller, 2000)
    flush(70)
    endCalls.count = 0

    virt.totalSize = 2300 // getTotalSize leads; the DOM spacer never commits in this test
    const sent: BaseMessage = {
      id: 'sent-1', from: 'me@example.com', body: 'hello', isOutgoing: true, type: 'chat',
      timestamp: new Date(2024, 0, 1, 13, 0),
    }
    rerender(
      <MessageList messages={[...makeMessages(50), sent]} conversationId="conv-nothrash" isAtBottomRef={isAtBottomRef} {...baseProps} />,
    )

    // 100 frames of lag. The pin stays alive (see the previous test) but must NOT issue a
    // scrollToIndex('end') each frame — only the initial pin(s). A thrashing loop would be ~100 here.
    flush(100)
    expect(endCalls.count).toBeLessThan(10)
  })
})
