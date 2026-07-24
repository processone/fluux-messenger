/**
 * @vitest-environment jsdom
 *
 * Send-stick root cause: WebKit stale paint after a programmatic scroll.
 *
 * On the Tauri WKWebView, setting scrollTop (via the virtualizer's scrollToIndex) updates the LAYOUT
 * correctly — scrollTop, the row rects and distFromBottom all land at the bottom — but the compositor
 * does not repaint, so the just-sent message stays visually below the fold until a real user scroll
 * forces a recomposite. Confirmed on-device: every geometry probe read "at bottom" while the message
 * looked stranded, and toggling `overflow` (a forced reflow) made the already-correctly-positioned
 * message appear without any scroll.
 *
 * The fix: the live-edge executor calls forceRepaint() after every programmatic scroll — it toggles
 * the scroller's overflow (`hidden` → reflow via offsetHeight → restore). This test asserts the pin
 * issues that repaint after a send. jsdom has no compositor, so we can't observe the paint itself;
 * instead we count the forced-reflow reads of `offsetHeight`, which only forceRepaint performs here.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { MessageList } from './MessageList'
import type { BaseMessage } from '@fluux/sdk'

const scrollToEndCalls = { count: 0 }

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
    scrollToIndex: (_index: number, opts?: { align?: string }) => {
      const el = args.scrollRef.current; if (!el) return
      if (opts?.align === 'end') { scrollToEndCalls.count += 1; el.scrollTop = el.scrollHeight }
      else el.scrollTop = _index * 40
    },
  }),
}))

function makeMessages(count: number, prefix = 'msg'): BaseMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`, from: 'user@example.com', body: `Body ${i}`,
    timestamp: new Date(2024, 0, 1, 12, i % 60), isOutgoing: false, type: 'chat' as const,
  }))
}

describe('MessageList — pin forces a repaint after a programmatic scroll (WebKit stale-paint fix)', () => {
  let realRaf: typeof requestAnimationFrame
  let rafQueue: FrameRequestCallback[]
  const flush = (frames: number) => { for (let i = 0; i < frames; i++) rafQueue.splice(0).forEach((cb) => cb(0)) }

  // Counts the forced-reflow reads of offsetHeight (only forceRepaint does this on the pin path) and
  // records the overflowY values set, so we can assert the toggle happened and was restored.
  const repaint = { offsetHeightReads: 0, overflowSets: [] as string[] }

  // Mutable so the send can GROW the content, as it does in reality: the repaint is gated on the
  // pin actually moving scrollTop, and a static scrollHeight would make the send pin a no-op.
  const geo = { scrollHeight: 2000, clientHeight: 500 }

  function instrumentScroller(scroller: HTMLElement) {
    let top = 0
    Object.defineProperty(scroller, 'scrollHeight', { get: () => geo.scrollHeight, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { get: () => geo.clientHeight, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => top,
      set: (v: number) => { top = Math.max(0, Math.min(v, geo.scrollHeight - geo.clientHeight)) },
      configurable: true,
    })
    Object.defineProperty(scroller, 'offsetHeight', { get: () => { repaint.offsetHeightReads += 1; return 0 }, configurable: true })
    // Track overflowY writes (forceRepaint sets 'hidden' then '').
    const realStyle = scroller.style
    let overflowY = ''
    Object.defineProperty(realStyle, 'overflowY', {
      get: () => overflowY,
      set: (v: string) => { overflowY = v; repaint.overflowSets.push(v) },
      configurable: true,
    })
  }

  beforeEach(() => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    HTMLElement.prototype.scrollTo = vi.fn()
    rafQueue = []
    realRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length }) as typeof requestAnimationFrame
    scrollToEndCalls.count = 0
    repaint.offsetHeightReads = 0
    repaint.overflowSets = []
    geo.scrollHeight = 2000
    geo.clientHeight = 500
  })
  afterEach(() => { globalThis.requestAnimationFrame = realRaf; localStorage.clear() })

  const props = { renderMessage: (m: BaseMessage) => <div>{m.body}</div>, onScrollToTop: vi.fn(), isHistoryComplete: false }
  const sent: BaseMessage = { id: 'sent-1', from: 'me@example.com', body: 'hi', timestamp: new Date(2024, 0, 1, 13, 0), isOutgoing: true, type: 'chat' }

  it('forces a repaint (overflow toggle) after the send pin scrolls to the bottom', () => {
    const isAtBottomRef = { current: true }
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-repaint" isAtBottomRef={isAtBottomRef} {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)
    flush(70) // settle the entry pin
    repaint.offsetHeightReads = 0
    repaint.overflowSets = []
    scrollToEndCalls.count = 0

    // SEND — an outgoing message grows the content and triggers the new-message pin.
    geo.scrollHeight = 2040
    rerender(<MessageList messages={[...makeMessages(50), sent]} conversationId="conv-repaint" isAtBottomRef={isAtBottomRef} {...props} />)
    flush(3)

    // The pin scrolled to the bottom AND forced a repaint after doing so.
    expect(scrollToEndCalls.count).toBeGreaterThan(0)
    expect(repaint.offsetHeightReads).toBeGreaterThan(0)
    // The overflow toggle set 'hidden' then restored it (last value is the restored '' from the CSS class).
    expect(repaint.overflowSets).toContain('hidden')
    expect(repaint.overflowSets[repaint.overflowSets.length - 1]).toBe('')
  })

  // Regression for the WebKitGTK "half-freeze": a BURST of new bottom rows (live chatter, a reconnect
  // flushing queued messages, a reaction/media storm) used to fire one forced overflow-toggle repaint
  // PER arrival. On WebKitGTK each is a ~50–150ms full scroller re-layout+repaint, so a burst
  // saturated the main thread. The burst coalescer suppresses the intermediate repaints (position is
  // still written) and forces ONE trailing repaint on settle — a burst of N collapses to ~1–2 toggles.
  it('coalesces a burst of new messages into far fewer forced repaints', () => {
    const isAtBottomRef = { current: true }
    const base = makeMessages(50)
    const { container, rerender } = render(
      <MessageList messages={base} conversationId="conv-burst" isAtBottomRef={isAtBottomRef} {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)
    flush(70) // settle the entry pin
    repaint.overflowSets = []
    scrollToEndCalls.count = 0

    // BURST — 8 incoming messages land in rapid succession, each growing the content and firing the
    // new-message pin, with only a couple of frames between them (the loop cannot fully settle).
    const burst: BaseMessage[] = []
    for (let i = 0; i < 8; i++) {
      burst.push({
        id: `burst-${i}`, from: `user${i}@example.com`, body: `burst ${i}`,
        timestamp: new Date(2024, 0, 1, 13, i), isOutgoing: false, type: 'chat',
      })
      geo.scrollHeight = 2000 + (i + 1) * 40
      rerender(
        <MessageList messages={[...base, ...burst]} conversationId="conv-burst" isAtBottomRef={isAtBottomRef} {...props} />,
      )
      flush(2)
    }
    // Arrival stops — let the loop converge and flush the single trailing repaint.
    flush(20)

    // Position was still written for every arrival (layout stays correct — nothing is stranded).
    expect(scrollToEndCalls.count).toBeGreaterThanOrEqual(8)

    // But the expensive forced repaints were coalesced: far fewer overflow 'hidden' toggles than the
    // 8 arrivals. Pre-fix this was ~8+ (one per arrival); post-fix it is the first arrival's immediate
    // paint plus the trailing settle paint.
    const hiddenToggles = repaint.overflowSets.filter((v) => v === 'hidden').length
    expect(hiddenToggles).toBeLessThan(8)
    expect(hiddenToggles).toBeGreaterThan(0) // the final position IS painted (not left stale)
    // Whatever the last toggle, overflow is restored so scrolling still works.
    expect(repaint.overflowSets[repaint.overflowSets.length - 1]).toBe('')
  })
})
