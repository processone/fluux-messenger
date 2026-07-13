/**
 * @vitest-environment jsdom
 *
 * pinVirtualizedBottom cost-control behavior (the WebKitGTK freeze fixes):
 *
 * 1. CONVERGENCE EARLY-EXIT — the ~60-frame re-assert loop must stop once the
 *    geometry has been stable for a few consecutive frames instead of always
 *    burning its full budget of per-frame forced layouts.
 * 2. GATED REPAINT — the full-scroller repaint (overflowY toggle) is the most
 *    expensive step on WebKitGTK and exists only for WebKit's stale paint after
 *    a *programmatic scroll*; a pin that did not move scrollTop must skip it.
 * 3. TYPING DEFERRAL — a typing-indicator toggle while a pin-bottom loop is
 *    already running must not synchronously restart the pin (the active loop
 *    picks up the height change on its next frame).
 *
 * Same harness as MessageList.pinBottomRepaint.test.tsx: mocked virtualizer,
 * fake rAF queue, instrumented scroller geometry.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
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

describe('MessageList — pinVirtualizedBottom cost control', () => {
  let realRaf: typeof requestAnimationFrame
  let rafQueue: FrameRequestCallback[]
  const flush = (frames: number) => { for (let i = 0; i < frames; i++) rafQueue.splice(0).forEach((cb) => cb(0)) }

  const repaint = { overflowSets: [] as string[] }
  // Mutable geometry so a test can grow the content (a send) or keep it static (a no-op pin).
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
    Object.defineProperty(scroller, 'offsetHeight', { get: () => 0, configurable: true })
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
    repaint.overflowSets = []
    geo.scrollHeight = 2000
    geo.clientHeight = 500
  })
  afterEach(() => { globalThis.requestAnimationFrame = realRaf; localStorage.clear() })

  const props = { renderMessage: (m: BaseMessage) => <div>{m.body}</div>, onScrollToTop: vi.fn(), isHistoryComplete: false }
  const sent: BaseMessage = { id: 'sent-1', from: 'me@example.com', body: 'hi', timestamp: new Date(2024, 0, 1, 13, 0), isOutgoing: true, type: 'chat' }

  function renderPinned() {
    const isAtBottomRef = { current: true }
    const view = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-pin-behavior" isAtBottomRef={isAtBottomRef} {...props} />,
    )
    const scroller = view.container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)
    flush(70) // settle the entry pin completely
    scrollToEndCalls.count = 0
    repaint.overflowSets = []
    return { ...view, isAtBottomRef }
  }

  it('stops the re-assert loop early once geometry is stable (convergence exit)', () => {
    const { rerender, isAtBottomRef } = renderPinned()

    geo.scrollHeight = 2040 // the sent row grows the content
    rerender(<MessageList messages={[...makeMessages(50), sent]} conversationId="conv-pin-behavior" isAtBottomRef={isAtBottomRef} {...props} />)
    flush(2)
    // The pin loop is alive right after the send…
    expect(rafQueue.length).toBeGreaterThan(0)

    // …but with stable geometry it must settle and stop well before the 60-frame
    // budget (8 stable frames + margin), leaving nothing scheduled.
    flush(15)
    expect(rafQueue.length).toBe(0)
  })

  it('skips the forced repaint when the pin did not move scrollTop', () => {
    const { isAtBottomRef } = renderPinned()
    expect(isAtBottomRef.current).toBe(true)

    // A viewport resize at unchanged geometry re-pins, but the scroll position is
    // already exactly at the bottom: no programmatic scroll happened, so the
    // WebKit stale-paint overflow toggle must be skipped entirely.
    window.dispatchEvent(new Event('resize'))
    flush(20)

    expect(scrollToEndCalls.count).toBeGreaterThan(0) // the pin ran
    expect(repaint.overflowSets).not.toContain('hidden') // but never forced a repaint
  })

  // The complementary case — a pin that DOES move scrollTop still forces the repaint — is the
  // canonical send-stick test in MessageList.pinBottomRepaint.test.tsx.

  // Issue #918: the typing indicator floats OVER the list rather than living in the scroll content,
  // so toggling it changes no scroll height on its own — the inline height churn was what "fought"
  // an upward scroll while another participant was typing. The footer's reserved clearance for the
  // pill DOES grow while genuinely at the bottom (a gentle nudge, same mechanism as a reaction
  // growing the last row) — see the next test for the invariant that still matters: a reader
  // scrolled up must never be yanked back down.
  it('gently nudges to reveal the footer clearance when typing starts at the bottom, not when it stops', () => {
    const { rerender, isAtBottomRef } = renderPinned()
    flush(30) // quiesce any residual pin activity
    expect(rafQueue.length).toBe(0)
    const baseline = scrollToEndCalls.count

    // Typing starts while genuinely at the bottom → nudges once to reveal the grown footer.
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-pin-behavior" isAtBottomRef={isAtBottomRef} typingUsers={['alice']} {...props} />)
    flush(5)
    expect(scrollToEndCalls.count).toBe(baseline + 1)

    // Typing stops → the footer shrinks; the browser clamps scrollTop on its own, no extra nudge.
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-pin-behavior" isAtBottomRef={isAtBottomRef} typingUsers={[]} {...props} />)
    flush(5)
    expect(scrollToEndCalls.count).toBe(baseline + 1)
  })

  // The scroll-to-bottom FAB must stay hidden while the entry pin loop is settling at the bottom.
  // On WebKit a tall bottom row's post-paint growth fires a 'scroll' event at the pre-repin scrollTop,
  // so distFromBottom is transiently far past the 300px FAB threshold BEFORE the loop re-pins. Without
  // the pinBottomActiveRef guard in handleScroll that transient flipped the FAB visible — the reported
  // intermittent flash on opening a conversation at the bottom.
  it('keeps the scroll-to-bottom FAB hidden when a growth-driven scroll fires during the entry pin (open-at-bottom flash race)', () => {
    const isAtBottomRef = { current: true }
    const view = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-fab-race" isAtBottomRef={isAtBottomRef} {...props} />,
    )
    const scroller = view.container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)

    // Advance only a couple of frames: the entry pin-to-bottom loop is still running (pinBottomActive).
    flush(2)
    expect(rafQueue.length).toBeGreaterThan(0)

    // Simulate WebKit's late row measurement: content grows after paint, and a 'scroll' event fires at
    // the still-old scrollTop → distFromBottom ≈ 3200-1500-500 = 1200px, well past the FAB threshold.
    geo.scrollHeight = 3200
    act(() => { scroller.dispatchEvent(new Event('scroll')) })

    const wrapperOf = () =>
      (view.container.querySelector('[data-fab="scroll-to-bottom"]') as HTMLElement).closest('div.z-40') as HTMLElement

    // The loop is settling AT the bottom, so the FAB must not appear.
    expect(wrapperOf().className).not.toContain('fab-spring-in')
    expect(wrapperOf().hasAttribute('inert')).toBe(true)

    // Let the loop finish and re-pin to the new bottom — still hidden at the settled bottom.
    flush(70)
    expect(wrapperOf().hasAttribute('inert')).toBe(true)
  })

  it('does not yank a scrolled-up viewport back to the bottom when typing toggles (issue #918)', () => {
    const { rerender, isAtBottomRef } = renderPinned()
    flush(30) // quiesce any residual pin activity
    const scroller = document.querySelector('[data-message-list]') as HTMLElement

    // Reproduce the reported state faithfully: the user has scrolled UP into history, but the
    // follow flag is still latched `true`. That latch is the real bug — pinVirtualizedBottom's
    // user-intent bail calls finish() WITHOUT re-deriving isAtBottomRef from geometry, so after a
    // wheel-up mid-pin the flag stays true. With the old code (typing indicator inside the scroll
    // content, typingUsersCount driving the re-pin effect) each XEP-0085 composing/paused toggle
    // then re-pinned and hauled the viewport back to the bottom. The typing indicator now floats
    // over the list, so a toggle changes no scroll height and must not scroll at all.
    scroller.scrollTop = 400
    isAtBottomRef.current = true
    scrollToEndCalls.count = 0

    for (const users of [['alice'], [], ['alice'], []]) {
      rerender(<MessageList messages={makeMessages(50)} conversationId="conv-pin-behavior" isAtBottomRef={isAtBottomRef} typingUsers={users} {...props} />)
      flush(5)
    }

    // Never re-pinned; the scrolled-up position is exactly where the user left it.
    expect(scrollToEndCalls.count).toBe(0)
    expect(scroller.scrollTop).toBe(400)
  })
})
