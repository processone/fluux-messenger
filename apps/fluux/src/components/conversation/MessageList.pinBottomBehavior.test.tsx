/**
 * @vitest-environment jsdom
 *
 * Live-edge executor cost-control behavior (the WebKitGTK freeze fixes):
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
import React, { createRef, type RefObject } from 'react'
import type { MessageListHandle } from './messageListBoundary'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { FlatMessageList as MessageList } from './MessageList.flat-test-utils'
import type { BaseMessage } from '@fluux/sdk'
import { appliedWrite } from './scrollWriteTestDoubles'

const scrollToEndCalls = { count: 0 }
let reportMeasuredRow: ((key: string, size: number) => void) | undefined

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
  useTanstackMessageVirtualizer: (args: {
    items: { key: string }[]
    scrollRef: React.RefObject<HTMLElement | null>
    onMeasured?: (key: string, size: number) => void
  }) => {
    reportMeasuredRow = args.onMeasured
    return {
      getVirtualItems: () => args.items.map((it, index) => ({ index, start: index * 40, size: 40, key: it.key })),
      getTotalSize: () => args.items.length * 40,
      itemCount: args.items.length,
      getOffsetForMessageId: () => 0,
      getIndexForMessageId: (id: string) => { const i = args.items.findIndex((it) => it.key === id); return i >= 0 ? i : null },
      ensureMessageMounted: vi.fn(() => Promise.resolve()),
      measureElement: () => {},
      scrollToOffset: (offset: number) => {
        const el = args.scrollRef.current; if (el) el.scrollTop = offset
        return appliedWrite(el?.scrollTop)
      },
      // jsdom has no smooth-scroll animation, so an animated scroll lands immediately.
      beginAnimatedScrollToOffset: (offset: number) => { const el = args.scrollRef.current; if (el) el.scrollTop = offset },
      scrollToIndex: (_index: number, opts?: { align?: string }) => {
        const el = args.scrollRef.current; if (!el) return appliedWrite()
        if (opts?.align === 'end') { scrollToEndCalls.count += 1; el.scrollTop = el.scrollHeight }
        else el.scrollTop = _index * 40
        return appliedWrite(el.scrollTop)
      },
    }
  },
}))

function makeMessages(count: number, prefix = 'msg'): BaseMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`, stanzaId: undefined, originId: undefined, from: 'user@example.com', body: `Body ${i}`,
    timestamp: new Date(2024, 0, 1, 12, i % 60), isOutgoing: false, type: 'chat' as const,
  }))
}

describe('MessageList — live-edge executor cost control', () => {
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
  const sent: BaseMessage = { id: 'sent-1', stanzaId: undefined, originId: undefined, from: 'me@example.com', body: 'hi', timestamp: new Date(2024, 0, 1, 13, 0), isOutgoing: true, type: 'chat' }

  function renderPinned() {
    const handleRef = createRef<MessageListHandle>()
    const view = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-pin-behavior" handleRef={handleRef} {...props} />,
    )
    const scroller = view.container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)
    flush(70) // settle the entry pin completely
    scrollToEndCalls.count = 0
    repaint.overflowSets = []
    return { ...view, handleRef }
  }

  // A link-preview (OGP) fastening lands SECONDS after its message, as an in-place update: same
  // message id, same message count, no reactions change, and LinkPreviewCard deliberately never
  // calls onMediaLoad. Under virtualization the content ResizeObserver is disabled too, so nothing
  // else can notice the growth — the card used to render below the fold and stay there.
  const linked: BaseMessage = {
    id: 'linked-1', stanzaId: undefined, originId: undefined, from: 'me@example.com', body: 'look at https://example.com',
    timestamp: new Date(2024, 0, 1, 13, 0), isOutgoing: true, type: 'chat',
  }
  const preview = { url: 'https://example.com', title: 'Example', description: 'An example page' }

  function renderWithLinkMessage(handleRef: RefObject<MessageListHandle | null>) {
    const view = render(
      <MessageList messages={[...makeMessages(50), linked]} conversationId="conv-fastening" handleRef={handleRef} {...props} />,
    )
    const scroller = view.container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)
    flush(70) // settle the entry pin completely
    // Put the list in the state these tests are about: pinned at the bottom, with the geometry
    // baseline seeded the way a real browser seeds it (scroll events fire constantly, and the
    // growth correction reads the last one). The entry pin runs before instrumentScroller replaces
    // the scrollTop accessor, so without this the harness starts at scrollTop=0 with a baseline the
    // real app never has — and every gate downstream reads nonsense.
    scroller.scrollTop = geo.scrollHeight
    act(() => { scroller.dispatchEvent(new Event('scroll')) })
    scrollToEndCalls.count = 0
    return { view, scroller }
  }

  const fastenPreview = (view: { rerender: (ui: React.ReactElement) => void }, handleRef: RefObject<MessageListHandle | null>) =>
    view.rerender(
      <MessageList messages={[...makeMessages(50), { ...linked, linkPreview: preview }]} conversationId="conv-fastening" handleRef={handleRef} {...props} />,
    )

  // The card's height is in the scroller AS SOON AS the commit that mounts it lands: the row is
  // absolutely positioned inside the @tanstack spacer and @tanstack re-measures it in the same
  // frame, so scrollHeight already includes the growth when the layout effect runs. Verified in
  // both engines — see the fastening tests in e2e/scroll-live-edge.ts. Modelling this as a
  // delayed growth is what let an earlier version of the geometry gate look correct here while
  // failing in a real browser, so the growth is applied together with the rerender below.
  // Deliberately larger than AT_BOTTOM_THRESHOLD (150): a gate reading POST-growth geometry must
  // fail this test rather than squeak under the threshold.
  const PREVIEW_CARD_PX = 260

  it('re-pins the bottom when a late link-preview fastening grows a resident row', () => {
    const handleRef = createRef<MessageListHandle>()
    const { view, scroller } = renderWithLinkMessage(handleRef)

    geo.scrollHeight += PREVIEW_CARD_PX // the card is in the layout the moment it commits
    fastenPreview(view, handleRef)
    flush(10)

    expect(scrollToEndCalls.count).toBeGreaterThan(0)
    expect(scroller.scrollTop).toBe(geo.scrollHeight - geo.clientHeight)
  })

  it('re-pins late row growth after input pauses follow-live at the bottom', () => {
    const handleRef = createRef<MessageListHandle>()
    const { view, scroller } = renderWithLinkMessage(handleRef)

    act(() => { scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true })) })
    geo.scrollHeight += PREVIEW_CARD_PX
    fastenPreview(view, handleRef)
    flush(10)

    expect(scrollToEndCalls.count).toBeGreaterThan(0)
    expect(scroller.scrollTop).toBe(geo.scrollHeight - geo.clientHeight)
  })

  it('re-pins when a virtual row reports growth after the original reaction pin has settled', () => {
    const handleRef = createRef<MessageListHandle>()
    const messages = makeMessages(50)
    const view = render(
      <MessageList messages={messages} conversationId="conv-late-reaction-measure" handleRef={handleRef} {...props} />,
    )
    const scroller = view.container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)
    flush(70)
    scroller.scrollTop = geo.scrollHeight
    act(() => { scroller.dispatchEvent(new Event('scroll')) })
    act(() => { reportMeasuredRow?.('msg-49', 40) })

    view.rerender(
      <MessageList
        messages={messages.map((message, index) =>
          index === messages.length - 1
            ? { ...message, reactions: { '👍': ['someone@example.com'] } }
            : message,
        )}
        conversationId="conv-late-reaction-measure"
        handleRef={handleRef}
        {...props}
      />,
    )
    flush(20)
    expect(rafQueue.length).toBe(0)

    scrollToEndCalls.count = 0
    geo.scrollHeight += 28
    act(() => {
      reportMeasuredRow?.('msg-49', 68)
      flush(10)
    })

    expect(scrollToEndCalls.count).toBeGreaterThan(0)
    expect(scroller.scrollTop).toBe(geo.scrollHeight - geo.clientHeight)
  })

  it('does not re-pin late measured reaction growth for a reader in history', () => {
    const handleRef = createRef<MessageListHandle>()
    const messages = makeMessages(50)
    const view = render(
      <MessageList messages={messages} conversationId="conv-late-reaction-history" handleRef={handleRef} {...props} />,
    )
    const scroller = view.container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)
    flush(70)
    scroller.scrollTop = 400
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
      reportMeasuredRow?.('msg-49', 40)
    })

    view.rerender(
      <MessageList
        messages={messages.map((message, index) =>
          index === messages.length - 1
            ? { ...message, reactions: { '👍': ['someone@example.com'] } }
            : message,
        )}
        conversationId="conv-late-reaction-history"
        handleRef={handleRef}
        {...props}
      />,
    )
    flush(20)

    scrollToEndCalls.count = 0
    geo.scrollHeight += 28
    act(() => { reportMeasuredRow?.('msg-49', 68) })
    flush(10)

    expect(scrollToEndCalls.count).toBe(0)
    expect(scroller.scrollTop).toBe(400)
  })

  it('waits for post-measurement geometry before deciding whether to re-pin', () => {
    const handleRef = createRef<MessageListHandle>()
    const messages = makeMessages(50)
    const view = render(
      <MessageList messages={messages} conversationId="conv-reaction-threshold" handleRef={handleRef} {...props} />,
    )
    const scroller = view.container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)
    flush(70)
    scroller.scrollTop = geo.scrollHeight - geo.clientHeight - 160
    act(() => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
      reportMeasuredRow?.('msg-49', 40)
    })

    view.rerender(
      <MessageList
        messages={messages.map((message, index) =>
          index === messages.length - 1
            ? { ...message, reactions: { '👍': ['someone@example.com'] } }
            : message,
        )}
        conversationId="conv-reaction-threshold"
        handleRef={handleRef}
        {...props}
      />,
    )
    flush(20)
    scrollToEndCalls.count = 0

    act(() => { reportMeasuredRow?.('msg-49', 68) })
    expect(scrollToEndCalls.count).toBe(0)

    geo.scrollHeight += 28
    act(() => { flush(10) })
    expect(scrollToEndCalls.count).toBe(0)
    expect(scroller.scrollTop).toBe(geo.scrollHeight - geo.clientHeight - 188)
  })

  it('does not yank a scrolled-up reader down when a link-preview fastening lands', () => {
    const handleRef = createRef<MessageListHandle>()
    const { view, scroller } = renderWithLinkMessage(handleRef)

    scroller.scrollTop = 400 // the reader scrolled up into history
    geo.scrollHeight += PREVIEW_CARD_PX
    fastenPreview(view, handleRef)
    flush(10)

    expect(scrollToEndCalls.count).toBe(0)
    expect(scroller.scrollTop).toBe(400)
  })

  it('stops the re-assert loop early once geometry is stable (convergence exit)', () => {
    const { rerender, handleRef } = renderPinned()

    geo.scrollHeight = 2040 // the sent row grows the content
    rerender(<MessageList messages={[...makeMessages(50), sent]} conversationId="conv-pin-behavior" handleRef={handleRef} {...props} />)
    flush(2)
    // The pin loop is alive right after the send…
    expect(rafQueue.length).toBeGreaterThan(0)

    // …but with stable geometry it must settle and stop well before the 60-frame
    // budget (8 stable frames + margin), leaving nothing scheduled.
    flush(15)
    expect(rafQueue.length).toBe(0)
  })

  it('skips the forced repaint when the pin did not move scrollTop', () => {
    const { handleRef } = renderPinned()
    expect(handleRef.current?.isAtBottom()).toBe(true)

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
    const { rerender, handleRef } = renderPinned()
    flush(30) // quiesce any residual pin activity
    expect(rafQueue.length).toBe(0)
    const baseline = scrollToEndCalls.count

    // Typing starts while genuinely at the bottom → nudges once to reveal the grown footer.
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-pin-behavior" handleRef={handleRef} typingUsers={['alice']} {...props} />)
    flush(5)
    expect(scrollToEndCalls.count).toBe(baseline + 1)

    // Typing stops → the footer shrinks; the browser clamps scrollTop on its own, no extra nudge.
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-pin-behavior" handleRef={handleRef} typingUsers={[]} {...props} />)
    flush(5)
    expect(scrollToEndCalls.count).toBe(baseline + 1)
  })

  // The scroll-to-bottom FAB must stay hidden while the entry pin loop is settling at the bottom.
  // On WebKit a tall bottom row's post-paint growth fires a 'scroll' event at the pre-repin scrollTop,
  // so distFromBottom is transiently far past the 300px FAB threshold BEFORE the loop re-pins. Without
  // the pinBottomActiveRef guard in handleScroll that transient flipped the FAB visible — the reported
  // intermittent flash on opening a conversation at the bottom.
  it('keeps the scroll-to-bottom FAB hidden when a growth-driven scroll fires during the entry pin (open-at-bottom flash race)', () => {
    const handleRef = createRef<MessageListHandle>()
    const view = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-fab-race" handleRef={handleRef} {...props} />,
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
    const { rerender, handleRef } = renderPinned()
    flush(30) // quiesce any residual pin activity
    const scroller = document.querySelector('[data-message-list]') as HTMLElement

    // Reproduce the reported state faithfully: the user has scrolled UP into history, but the
    // follow flag is still latched `true`. That latch was the real bug — the former pin loop's
    // user-intent bail called finish() WITHOUT re-deriving handleRef from geometry, so after a
    // wheel-up mid-pin the flag stays true. With the old code (typing indicator inside the scroll
    // content, typingUsersCount driving the re-pin effect) each XEP-0085 composing/paused toggle
    // then re-pinned and hauled the viewport back to the bottom. The typing indicator now floats
    // over the list, so a toggle changes no scroll height and must not scroll at all.
    scroller.scrollTop = 400
    scrollToEndCalls.count = 0

    for (const users of [['alice'], [], ['alice'], []]) {
      rerender(<MessageList messages={makeMessages(50)} conversationId="conv-pin-behavior" handleRef={handleRef} typingUsers={users} {...props} />)
      flush(5)
    }

    // Never re-pinned; the scrolled-up position is exactly where the user left it.
    expect(scrollToEndCalls.count).toBe(0)
    expect(scroller.scrollTop).toBe(400)
  })
})
