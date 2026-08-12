/**
 * @vitest-environment jsdom
 *
 * Read-state PR B, Task 12 — acceptance scenarios 1-7 from
 * docs/superpowers/specs/2026-07-23-read-state-unread-count-single-source-acceptance.md,
 * implemented verbatim at the MessageList component boundary: every numeric surface
 * (sidebar excluded here — see ConversationList.badge.test.tsx / roomTooltip.test.ts)
 * renders the ONE canonical `unreadCount` prop through the shared `formatUnreadCount`, and
 * scrolling never changes it.
 *
 * Deliberately uses the REAL react-i18next (via the global test-setup.ts init), not the
 * `t: (k) => k` echo mock other MessageList test files use, so the divider's and pill's
 * rendered TEXT (not just structure) can be asserted — scenario 2 requires "2 new messages"
 * literally, not the bare translation key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { MessageList } from './MessageList'
import { createTestMessages } from './MessageList.test-utils'
import { scrollStateManager } from '@/utils/scrollStateManager'

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

class MockResizeObserver {
  callback: ResizeObserverCallback
  static instances: MockResizeObserver[] = []
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    MockResizeObserver.instances.push(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {
    const index = MockResizeObserver.instances.indexOf(this)
    if (index > -1) MockResizeObserver.instances.splice(index, 1)
  }
}

describe('MessageList — unread-count-single-source acceptance scenarios (Task 12)', () => {
  let originalRAF: typeof requestAnimationFrame

  beforeEach(() => {
    vi.useFakeTimers()
    MockResizeObserver.instances = []
    // Non-virtualized path: simpler, deterministic DOM geometry for these component tests.
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'false')
    scrollStateManager.reset()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    originalRAF = window.requestAnimationFrame
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    window.requestAnimationFrame = originalRAF
    localStorage.clear()
  })

  function setupScrollContainer(options: { scrollHeight?: number; clientHeight?: number; initialScrollTop?: number } = {}) {
    const { scrollHeight = 2000, clientHeight = 500, initialScrollTop = 0 } = options
    const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
    if (!container) return null
    let scrollTopValue = initialScrollTop
    Object.defineProperty(container, 'scrollHeight', { value: scrollHeight, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: clientHeight, configurable: true })
    Object.defineProperty(container, 'scrollTop', {
      get: () => scrollTopValue,
      set: (v) => { scrollTopValue = v },
      configurable: true,
    })
    Object.defineProperty(container, 'scrollTo', {
      value: vi.fn((opts: ScrollToOptions) => { scrollTopValue = opts.top ?? scrollTopValue }),
      configurable: true,
    })
    return { container, getScrollTop: () => scrollTopValue }
  }

  function scrollTo(container: HTMLDivElement, scrollTop: number) {
    Object.defineProperty(container, 'scrollTop', { get: () => scrollTop, set: () => {}, configurable: true })
    act(() => { container.dispatchEvent(new Event('scroll')) })
  }

  const fab = (container: HTMLElement) =>
    container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]') as HTMLElement | null
  const fabBadge = (container: HTMLElement) => fab(container)?.querySelector('span') ?? null
  const divider = () => document.querySelector('[data-new-message-marker]')
  const pill = () => document.querySelector('[data-jump-to-last-read]')

  const renderMessage = (m: { id: string; body?: string }) => <div key={m.id}>{m.body}</div>

  // -----------------------------------------------------------------------
  // Scenario 1: Everything read, user scrolls upward
  // -----------------------------------------------------------------------
  it('scenario 1 — everything read + scrolled up: FAB visible with NO badge, no divider, no pill', () => {
    const messages = createTestMessages(10)
    render(
      <MessageList
        messages={messages}
        conversationId="conv-1"
        clearFirstNewMessageId={vi.fn()}
        unreadCount={0}
        renderMessage={renderMessage}
      />
    )
    const scrollCtx = setupScrollContainer()
    if (!scrollCtx) throw new Error('scroll container not found')
    scrollTo(scrollCtx.container, 0) // away from the bottom

    expect(fab(scrollCtx.container)).toBeTruthy()
    // Break check: if the badge were a below-viewport/resident count it would show a non-zero
    // number here (10 resident messages sit below the fold) — assert the badge element is absent.
    expect(fabBadge(scrollCtx.container)).toBeNull()
    expect(divider()).toBeNull()
    expect(pill()).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Scenario 2: Scrolled up, two new eligible messages arrive
  // -----------------------------------------------------------------------
  it('scenario 2 — two new messages arrive: divider, FAB badge, and pill all show "2"', () => {
    const messages = createTestMessages(10) // msg-0 .. msg-9
    render(
      <MessageList
        messages={messages}
        conversationId="conv-1"
        clearFirstNewMessageId={vi.fn()}
        firstNewMessageId="msg-7"
        unreadCount={2}
        renderMessage={renderMessage}
      />
    )
    const scrollCtx = setupScrollContainer()
    if (!scrollCtx) throw new Error('scroll container not found')
    scrollTo(scrollCtx.container, 0)

    // Divider is its own numeric surface: assert its OWN rendered text, not just the pill's.
    expect(divider()?.textContent).toContain('2 new messages')
    // FAB badge shows the same canonical number.
    expect(fabBadge(scrollCtx.container)?.textContent).toBe('2')

    // FIX 7 (final whole-branch review): the title promises "(and pill)" but this test never
    // asserted it — scroll PAST the divider (its pixel offset now behind the current scrollTop,
    // the pill's own visibility condition) so it actually renders, and assert its OWN text. This
    // is a REAL break check (distinct from the FAB/divider assertions above): a stale or
    // resident-relative count on the pill specifically would fail here without failing them.
    const markerElement = scrollCtx.container.querySelector('[data-message-id="msg-7"]') as HTMLElement
    Object.defineProperty(markerElement, 'offsetTop', { value: 100, configurable: true })
    scrollTo(scrollCtx.container, 900)

    expect(pill()).toBeTruthy()
    expect(pill()?.textContent).toContain('2 new messages')
  })

  // -----------------------------------------------------------------------
  // Scenario 3: Scroll down and back up without advancing the read pointer
  // -----------------------------------------------------------------------
  it('scenario 3 — scrolling alone (no pointer advance) never changes the count on any surface', () => {
    const messages = createTestMessages(10)
    render(
      <MessageList
        messages={messages}
        conversationId="conv-1"
        clearFirstNewMessageId={vi.fn()}
        firstNewMessageId="msg-3"
        unreadCount={4}
        renderMessage={renderMessage}
      />
    )
    const scrollCtx = setupScrollContainer()
    if (!scrollCtx) throw new Error('scroll container not found')

    scrollTo(scrollCtx.container, 0)
    expect(fabBadge(scrollCtx.container)?.textContent).toBe('4')
    expect(divider()?.textContent).toContain('4 new messages')

    // Break check: drive scroll events only; assert the count is unchanged.
    scrollTo(scrollCtx.container, 900) // down, toward the bottom
    expect(fabBadge(scrollCtx.container)?.textContent).toBe('4')
    expect(divider()?.textContent).toContain('4 new messages')

    scrollTo(scrollCtx.container, 0) // back up
    expect(fabBadge(scrollCtx.container)?.textContent).toBe('4')
    expect(divider()?.textContent).toContain('4 new messages')
  })

  // -----------------------------------------------------------------------
  // Scenario 4: Activate the FAB — two-step is marker-geometry driven, not count-driven
  // -----------------------------------------------------------------------
  it('scenario 4 — divider on-screen/above viewport + count > 0 still goes straight to bottom', () => {
    const messages = createTestMessages(10)
    render(
      <MessageList
        messages={messages}
        conversationId="conv-1"
        clearFirstNewMessageId={vi.fn()}
        firstNewMessageId="msg-5"
        unreadCount={7} // nonzero — must NOT influence the destination
        renderMessage={renderMessage}
      />
    )
    // Marker already within/above the viewport (not further down) — the on-open state.
    const scrollCtx = setupScrollContainer({ scrollHeight: 2000, clientHeight: 500, initialScrollTop: 633 })
    if (!scrollCtx) throw new Error('scroll container not found')
    const markerElement = scrollCtx.container.querySelector('[data-message-id="msg-5"]') as HTMLElement
    Object.defineProperty(markerElement, 'offsetTop', { value: 800, configurable: true })

    act(() => { scrollCtx.container.dispatchEvent(new Event('scroll')) })

    const btn = fab(scrollCtx.container) as HTMLButtonElement
    expect(btn).toBeTruthy()
    const scrollToSpy = (scrollCtx.container as unknown as { scrollTo: ReturnType<typeof vi.fn> }).scrollTo

    act(() => { btn.click() })

    // Break check: with the divider above the viewport but count > 0, assert the target is the
    // bottom (not the marker) — a count-driven rule would wrongly scroll up to the marker.
    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 2000, behavior: 'smooth' }))
  })

  // -----------------------------------------------------------------------
  // Scenario 5: Reach the live edge while active and focused (component-level reduction)
  // -----------------------------------------------------------------------
  // The convergence itself (pointer advance without waiting on MDS publish) is store-level and
  // covered by chatStore.viewportGate.test.ts / roomStore.viewportGate.test.ts. At the
  // MessageList boundary, convergence means: unreadCount becomes 0, firstNewMessageId clears, and
  // the viewport is at the live edge (FAB hidden).
  it('scenario 5 — converged state (count 0, no divider, at the live edge): every surface is cleared', () => {
    const messages = createTestMessages(10)
    render(
      <MessageList
        messages={messages}
        conversationId="conv-1"
        clearFirstNewMessageId={vi.fn()}
        unreadCount={0}
        renderMessage={renderMessage}
      />
    )
    const scrollCtx = setupScrollContainer()
    if (!scrollCtx) throw new Error('scroll container not found')
    // At the bottom — FAB hidden (fresh mount defaults to "at bottom", no scroll dispatched).

    expect(divider()).toBeNull()
    expect(pill()).toBeNull()
    expect(fabBadge(scrollCtx.container)).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Scenario 6: Previously-read messages below the viewport
  // -----------------------------------------------------------------------
  it('scenario 6 — several read messages sit below the viewport: FAB may show, badge never does', () => {
    const messages = createTestMessages(30) // several messages below the fold once scrolled up
    render(
      <MessageList
        messages={messages}
        conversationId="conv-1"
        clearFirstNewMessageId={vi.fn()}
        unreadCount={0} // fully read
        renderMessage={renderMessage}
      />
    )
    const scrollCtx = setupScrollContainer()
    if (!scrollCtx) throw new Error('scroll container not found')
    scrollTo(scrollCtx.container, 0) // scrolled up — the 30 messages are all "below the viewport"

    expect(fab(scrollCtx.container)).toBeTruthy()
    // Break check: place several read messages below the viewport and assert the badge element
    // does not render.
    expect(fabBadge(scrollCtx.container)).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Scenario 7: Remote XEP-0490 marker advances the pointer while scrolled up
  // -----------------------------------------------------------------------
  it('scenario 7 — remote marker advance updates every surface and preserves the anchored offset', () => {
    const messages = createTestMessages(10) // msg-0 .. msg-9
    const allIds = messages.map((m) => m.id)
    const { rerender, container } = render(
      <MessageList
        messages={messages}
        conversationId="conv-1"
        clearFirstNewMessageId={vi.fn()}
        firstNewMessageId="msg-3"
        unreadCount={5} // N
        renderMessage={renderMessage}
      />
    )
    const scrollCtx = setupScrollContainer({ scrollHeight: 2000, clientHeight: 500 })
    if (!scrollCtx) throw new Error('scroll container not found')

    // Lay out rows so the divider's OWN row genuinely occupies space in the flow: every message
    // row at/after the divider's position is pushed down by markerHeight, exactly as a real
    // "New messages" row insertion would push the rows beneath it. getBoundingClientRect reads
    // the scroller's CURRENT (live) scrollTop at call time — not a snapshot — so it reflects
    // whatever controller-owned anchor preservation (or its absence) leaves scrollTop at.
    const rowHeight = 100
    const markerHeight = 100
    const layoutRowsForDivider = (dividerMessageId: string | undefined) => {
      const dividerIdx = dividerMessageId ? allIds.indexOf(dividerMessageId) : -1
      const rows = scrollCtx.container.querySelectorAll('.message-row[data-message-id]')
      rows.forEach((node, i) => {
        const el = node as HTMLElement
        const offsetTop = i * rowHeight + (dividerIdx !== -1 && i >= dividerIdx ? markerHeight : 0)
        Object.defineProperty(el, 'offsetHeight', { value: rowHeight, configurable: true })
        Object.defineProperty(el, 'offsetTop', { value: offsetTop, configurable: true })
        Object.defineProperty(el, 'getBoundingClientRect', {
          value: () => {
            const top = offsetTop - scrollCtx.getScrollTop()
            return { top, bottom: top + rowHeight, height: rowHeight, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} } as DOMRect
          },
          configurable: true,
        })
      })
    }

    // Divider before msg-3: msg-3..msg-9 are each pushed down by one marker height. Scroll so
    // msg-4 (BETWEEN the old and new divider positions, so its offsetTop genuinely shifts when
    // the divider moves past it) is the bottom-most-visible row: msg-4 offsetTop=500, msg-5=600 —
    // at scrollTop=50, msg-4's relative top (450) is inside the 500px viewport and msg-5's (550)
    // is not, so findBottomAnchor picks msg-4.
    layoutRowsForDivider('msg-3')
    scrollCtx.container.scrollTop = 50
    act(() => { scrollCtx.container.dispatchEvent(new Event('scroll')) })
    scrollCtx.container.scrollTop = 80
    act(() => { scrollCtx.container.dispatchEvent(new Event('scroll')) })

    expect(fabBadge(scrollCtx.container)?.textContent).toBe('5')
    expect(divider()?.textContent).toContain('5 new messages')
    expect(container.querySelector('[data-message-id="msg-3"] [data-new-message-marker]')).not.toBeNull()

    const msg4 = () => scrollCtx.container.querySelector('[data-message-id="msg-4"]') as HTMLElement
    const relativeTopBefore = msg4().getBoundingClientRect().top
    expect(relativeTopBefore).toBe(420) // sanity: confirms the capture actually saw this position

    // The remote marker advances the boundary: the divider moves to msg-6, the count drops to 2
    // (M). This pushes msg-6..msg-9 down instead of msg-3..msg-9 — msg-4's OWN offsetTop moves
    // from 500 to 400 (the marker no longer sits above it), a real 100px document-position shift.
    //
    // The geometry override is applied BEFORE `rerender`, not after: the row elements are the
    // SAME DOM nodes across this rerender (conversationId/key is unchanged, so React reconciles
    // in place rather than remounting), but the restore layout effect runs SYNCHRONOUSLY inside
    // `rerender()` itself — reapplying the new geometry afterward would be too late for that
    // effect to see it, exactly the post-mutation-is-too-late trap this whole mechanism exists
    // to avoid on the PRODUCTION side too.
    layoutRowsForDivider('msg-6')
    rerender(
      <MessageList
        messages={messages}
        conversationId="conv-1"
        clearFirstNewMessageId={vi.fn()}
        firstNewMessageId="msg-6"
        unreadCount={2} // M, 0 <= M < N
        renderMessage={renderMessage}
      />
    )

    // Break check (b): every surface must agree on the NEW count — leaving any surface on the
    // stale N=5 fails this.
    expect(fabBadge(scrollCtx.container)?.textContent).toBe('2')
    expect(divider()?.textContent).toContain('2 new messages')
    expect(container.querySelector('[data-message-id="msg-6"] [data-new-message-marker]')).not.toBeNull()
    expect(container.querySelector('[data-message-id="msg-3"] [data-new-message-marker]')).toBeNull()

    // Break check (a): msg-4's OWN offsetTop just shifted by -100 (500 -> 400) because the
    // divider moved past it — the leased preservation executor must move scrollTop by the SAME
    // -100 so msg-4's
    // VIEWPORT-RELATIVE position (top - scrollTop) stays byte-identical. Asserting the relative
    // position (not raw scrollTop) is what makes this bite: a naive "scrollTop unchanged"
    // assertion would pass even if preservation were a no-op AND the geometry never actually
    // moved — the documented failure mode this rewrite fixes.
    const relativeTopAfter = msg4().getBoundingClientRect().top
    expect(relativeTopAfter).toBe(relativeTopBefore)
  })
})
