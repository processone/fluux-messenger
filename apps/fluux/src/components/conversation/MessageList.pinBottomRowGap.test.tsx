/**
 * @vitest-environment jsdom
 *
 * Send-stick: the bottom pin must key on the LAST MESSAGE ROW's real rendered position, not on
 * scrollHeight math.
 *
 * Field bug (Tauri/WebKit, 1:1, short window): you send a message and it lands BELOW the fold. An
 * on-device trace showed the pin settling at `distFromBottom: 0` while the just-sent row's real
 * `getBoundingClientRect().bottom` was well below the viewport — because the row measured taller than
 * its estimate only after paint, and on a short viewport that gap hides the whole message. #782 tried
 * to key the pin on `getTotalSize()`, but that value does not lead the DOM spacer (the adapter only
 * recomputes it on the next render), so it was a no-op.
 *
 * The fix keys the pin's settle/keep-alive on `lastRowBottomGap()` — the last row's rect bottom minus
 * the scroller's rect bottom (> 0 = below the fold). It stays alive while the row is below the fold
 * (bounded by the hard cap), idle-polls (read-only) to prompt WebKit's late measure, and re-pins when
 * the spacer grows. jsdom has no layout, so getBoundingClientRect is stubbed to model the divergence.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { MessageList } from './MessageList'
import type { BaseMessage } from '@fluux/sdk'

// Test-controlled geometry. `spacer` = the DOM scrollHeight / virtualizer getTotalSize (the reachable
// height). `realBottom` = the last message row's REAL content bottom (what its rect reports). When
// realBottom > spacer, the row sits below the reachable bottom = below the fold, even at max scrollTop.
const geo = { spacer: 2000, realBottom: 2100, clientHeight: 500 }
const endCalls = { count: 0 }

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
  useTanstackMessageVirtualizer: (args: { items: { key: string }[]; scrollRef: React.RefObject<HTMLElement | null> }) => {
    const clampTop = (v: number) => Math.max(0, Math.min(v, geo.spacer - geo.clientHeight))
    return {
      getVirtualItems: () => args.items.map((it, index) => ({ index, start: index * 40, size: 40, key: it.key })),
      getTotalSize: () => geo.spacer,
      itemCount: args.items.length,
      getOffsetForMessageId: () => 0,
      getIndexForMessageId: (id: string) => { const i = args.items.findIndex((it) => it.key === id); return i >= 0 ? i : null },
      ensureMessageMounted: vi.fn(() => Promise.resolve()),
      measureElement: () => {},
      scrollToOffset: (offset: number) => { const el = args.scrollRef.current; if (el) el.scrollTop = clampTop(offset) },
      scrollToIndex: (_index: number, opts?: { align?: string }) => {
        const el = args.scrollRef.current; if (!el) return
        if (opts?.align === 'end') { endCalls.count += 1; el.scrollTop = clampTop(geo.spacer - geo.clientHeight) }
        else el.scrollTop = clampTop(_index * 40)
      },
    }
  },
}))

function makeMessages(count: number, prefix = 'msg'): BaseMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`, from: 'user@example.com', body: `Body ${i}`,
    timestamp: new Date(2024, 0, 1, 12, i % 60), isOutgoing: false, type: 'chat' as const,
  }))
}

describe('MessageList — bottom pin keys on the last row rect, not scrollHeight', () => {
  let realRaf: typeof requestAnimationFrame
  let rafQueue: FrameRequestCallback[]
  let origGBCR: typeof Element.prototype.getBoundingClientRect
  const flush = (frames: number) => { for (let i = 0; i < frames; i++) rafQueue.splice(0).forEach((cb) => cb(0)) }

  function instrumentScroller(scroller: HTMLElement) {
    let top = 0
    Object.defineProperty(scroller, 'scrollHeight', { get: () => geo.spacer, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { get: () => geo.clientHeight, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, geo.spacer - geo.clientHeight)) }, configurable: true,
    })
  }

  beforeEach(() => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    HTMLElement.prototype.scrollTo = vi.fn()
    rafQueue = []
    realRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length }) as typeof requestAnimationFrame
    geo.spacer = 2000; geo.realBottom = 2100; geo.clientHeight = 500
    endCalls.count = 0
    // Stub layout: the scroller's rect bottom is its clientHeight (top 0); a message row's rect bottom
    // is its REAL content bottom minus the current scrollTop — so gap = realBottom - spacer at max scroll.
    origGBCR = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const asEl = this as HTMLElement
      if (asEl.matches?.('[data-message-list]')) return { top: 0, bottom: geo.clientHeight, height: geo.clientHeight, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} } as DOMRect
      if (asEl.matches?.('[data-message-id]')) {
        const s = asEl.closest('[data-message-list]') as HTMLElement | null
        const b = geo.realBottom - (s ? s.scrollTop : 0)
        return { top: b - 40, bottom: b, height: 40, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} } as DOMRect
      }
      return origGBCR.call(this)
    }
  })
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf
    Element.prototype.getBoundingClientRect = origGBCR
    localStorage.clear()
  })

  const props = { renderMessage: (m: BaseMessage) => <div>{m.body}</div>, onScrollToTop: vi.fn(), isHistoryComplete: false }

  const sent: BaseMessage = { id: 'sent-1', from: 'me@example.com', body: 'hi', timestamp: new Date(2024, 0, 1, 13, 0), isOutgoing: true, type: 'chat' }

  it('does not settle while the last row is below the fold, then lands when the spacer grows (even past the 60-frame budget)', () => {
    const isAtBottomRef = { current: true }
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-gap" isAtBottomRef={isAtBottomRef} {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)
    flush(70) // settle the entry pin (gap 100 initially, so it stays alive — that's fine)
    endCalls.count = 0

    // SEND: row is 100px below the fold (realBottom 2100 vs spacer 2000). scrollHeight-distFromBottom
    // reads 0 (scrollTop clamped to 1500), but the real row rect is below the viewport.
    rerender(<MessageList messages={[...makeMessages(50), sent]} conversationId="conv-gap" isAtBottomRef={isAtBottomRef} {...props} />)

    flush(100) // well past the old 60-frame budget; the row is still below the fold
    // The scroll is clamped to the short spacer — the real row can't be reached yet. The pin is still
    // ALIVE (the old loop would have exited at frame 60; the next phase proves it did not).
    expect(scroller.scrollTop).toBe(1500)

    // The late measurement lands: the virtualizer/DOM spacer grows to include the row's real height.
    geo.spacer = 2100
    flush(70)

    // The still-alive pin re-pins to the grown bottom, the real row reaches the viewport (gap 0), and
    // it settles at-bottom. If the loop had exited at frame 60 (old behavior), scrollTop would still be
    // 1500 here — so landing 1600 is the proof it stayed alive past the budget.
    expect(scroller.scrollTop).toBe(1600)
    expect(isAtBottomRef.current).toBe(true)
  })

  it('does not re-pin every frame while the row is below the fold but scrollTop is clamped (no re-render storm)', () => {
    const isAtBottomRef = { current: true }
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-nostorm" isAtBottomRef={isAtBottomRef} {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)
    flush(70)
    endCalls.count = 0

    rerender(<MessageList messages={[...makeMessages(50), sent]} conversationId="conv-nostorm" isAtBottomRef={isAtBottomRef} {...props} />)
    flush(100) // row below fold, scrollTop clamped, spacer unchanged → nothing to write

    // The loop stays alive on the real gap but must idle-poll, not scrollToIndex('end') every frame.
    expect(endCalls.count).toBeLessThan(10)
  })
})
