/**
 * @vitest-environment jsdom
 *
 * Virtualization-specific scroll-hook integration coverage.
 *
 * With virtualization, a row you jump to (unread marker on entry, reply/find-on-page
 * target, scroll-to-bottom marker) may be OUTSIDE the mounted window. The scroll hook
 * must first call `virtualizer.ensureMessageMounted(id)` to bring it in — otherwise the
 * `querySelector('[data-message-id]')` never finds it and the jump silently no-ops. jsdom
 * has no layout, so the pixel positioning is verified on a real engine; here we pin the
 * integration CONTRACTS that have no other automated guard:
 *  - unread-marker entry and the FAB marker-first leg route through the positioning controller,
 *    whose executor uses getIndexForMessageId + scrollToIndex directly for an off-window row;
 *  - the MAM prepend restore reads the anchor offset from the VIRTUALIZER
 *    (`getOffsetForMessageId`), not `querySelector(anchor).offsetTop` — the anchor is
 *    windowed out on prepend, so the DOM read returns null and the old code fell back to
 *    distance-from-bottom math that landed the viewport on the just-loaded older rows.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act, waitFor } from '@testing-library/react'
import { MessageList, type MessageListProps } from './MessageList'
import type { BaseMessage } from '@fluux/sdk'
import { scrollStateManager } from '@/utils/scrollStateManager'
import { scrollToMessage } from './messageGrouping'

const ensureMessageMounted = vi.fn((_id: string) => Promise.resolve())
const getOffsetForMessageId = vi.fn((_id: string): number | null => 0)
// Records every offset pushed through the virtualizer's scrollToOffset (the re-window
// path). A direct scrollTop write does NOT go through here, so this distinguishes a
// virtualizer-aware restore (re-windows before paint) from a raw scrollTop write (blank).
const scrollToOffsetCalls: number[] = []
// Records the align of every scrollToIndex. A bottom re-pin goes through
// scrollToIndex(last,'end') (re-windows the virtualizer); a raw scrollTop write does not.
// Lets a test prove the composer-resize correction routes through the virtualizer.
const scrollToIndexCalls: Array<string | undefined> = []
const scrollToIndexBehaviors: Array<ScrollBehavior | undefined> = []
const scrollToIndexStartOffsets: number[] = []
// Keys the fake virtualizer treats as OUTSIDE the mounted window: getVirtualItems() omits them (so
// the restore's fraction-refine finds no measured size and must mount the row first via
// scrollToIndex), and a scrollToIndex(...) "windows them in" by removing them here. Empty by
// default, so tests that don't opt in keep the render-all window unchanged.
const windowedOutKeys = new Set<string>()

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

// Inject a fake MessageVirtualizer (render-all window) with spies, so the
// MessageList -> useMessageListScroll -> virtualizer wiring is observable in jsdom.
vi.mock('./tanstackMessageVirtualizer', () => ({
  useTanstackMessageVirtualizer: (args: { items: { key: string }[]; scrollRef: React.RefObject<HTMLElement | null> }) => ({
    getVirtualItems: () =>
      args.items
        .map((it, index) => ({ index, start: index * 40, size: 40, key: it.key }))
        .filter((vi) => !windowedOutKeys.has(vi.key)),
    getTotalSize: () => args.items.length * 40,
    itemCount: args.items.length,
    getOffsetForMessageId,
    getIndexForMessageId: (id: string) => {
      const i = args.items.findIndex((it) => it.key === id)
      return i >= 0 ? i : null
    },
    ensureMessageMounted,
    measureElement: () => {},
    // Wire scrollToOffset/scrollToIndex to the actual scroller so tests can track scrollTop.
    // scrollToOffset sets scrollTop directly.
    // scrollToIndex with align='end' simulates "last item pinned to bottom" by setting
    // scrollTop = scrollHeight, matching the test expectations for bottom-stick behavior.
    scrollToOffset: (offset: number) => {
      scrollToOffsetCalls.push(offset)
      const el = args.scrollRef.current
      if (el) el.scrollTop = offset
    },
    scrollToIndex: (
      _index: number,
      opts?: { align?: string; behavior?: ScrollBehavior },
    ) => {
      scrollToIndexCalls.push(opts?.align)
      scrollToIndexBehaviors.push(opts?.behavior)
      // Mounting a windowed-out row: scrollToIndex windows it into the measured set.
      const mountedKey = args.items[_index]?.key
      if (mountedKey) windowedOutKeys.delete(mountedKey)
      const el = args.scrollRef.current
      if (!el) return
      if (opts?.align === 'end') {
        el.scrollTop = el.scrollHeight  // simulate scroll-to-bottom
      } else {
        el.scrollTop = scrollToIndexStartOffsets.length > 0
          ? scrollToIndexStartOffsets.shift()!
          : _index * 40
      }
    },
  }),
}))

function makeMessages(count: number): BaseMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    from: 'user@example.com',
    body: `Body ${i}`,
    timestamp: new Date(2024, 0, 1, 12, i % 60),
    isOutgoing: false,
    type: 'chat' as const,
  }))
}

/**
 * Seed a KNOWN content anchor for `conversationId`, overwriting whatever the component captured on
 * leave. jsdom has no layout (rows measure offsetHeight 0), so findBottomAnchor degenerates to
 * {last row, fraction 1} and a meaningful anchor can't arise organically — we inject one. A
 * fraction < 1 forces the virtualizer-index restore's fraction-refine branch, whose
 * `getOffsetForMessageId(anchorId)` call is the observable proof that the restore CONSULTED THE
 * ANCHOR (rather than a blind scroll-to-bottom or a saved-pixel fallback). Pixel-position
 * correctness is covered by the real-engine scroll-invariants e2e — jsdom can't exercise the
 * fraction math. dist = 5000 − 200 − 500 = 4300 > AT_BOTTOM_THRESHOLD → wasAtBottom false → the
 * scrolled-up state persists for restore.
 */
function seedSavedAnchor(conversationId: string, messageId: string, fraction = 0.5) {
  scrollStateManager.saveScrollPosition(conversationId, 200, 5000, 500, { messageId, fraction })
}

function renderList(props: Partial<MessageListProps<BaseMessage>> = {}) {
  return render(
    <MessageList
      messages={makeMessages(50)}
      conversationId="conv-1"
      renderMessage={(msg) => <div>{msg.body}</div>}
      {...props}
    />,
  )
}

describe('MessageList — virtualized scroll integration', () => {
  beforeEach(() => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    // jsdom doesn't implement Element.scrollTo; the scroll-to-bottom path calls it.
    HTMLElement.prototype.scrollTo = vi.fn()
    scrollStateManager.reset()
    ensureMessageMounted.mockClear()
    getOffsetForMessageId.mockClear()
    getOffsetForMessageId.mockImplementation(() => 0)
    scrollToIndexCalls.length = 0
    scrollToIndexBehaviors.length = 0
    scrollToOffsetCalls.length = 0
    scrollToIndexStartOffsets.length = 0
    windowedOutKeys.clear()
  })
  afterEach(() => localStorage.clear())

  it('positions the unread-marker row through the controller on conversation entry', async () => {
    getOffsetForMessageId.mockImplementation((id) => (id === 'msg-40' ? 1600 : null))
    renderList({ firstNewMessageId: 'msg-40' })
    await waitFor(() => expect(scrollToIndexCalls).toContain('start'))
    expect(ensureMessageMounted).not.toHaveBeenCalledWith('msg-40')
  })

  it('centers the target row via scrollToIndex when a targetMessageId is set (reply / search jump)', async () => {
    // targetMessageId (reply-to jump, search result open) resolves the row through the virtualizer
    // index (works for unmounted rows — no DOM query, no async waits) and centers it via
    // scrollToIndex('center'). Center — not align:'start' — so the row does NOT sit flush against
    // the top edge (under the sticky date header) where it reads as misaligned and the highlight
    // flash is easy to miss; scrollToIndex also windows + measures + clamps, so a near-bottom
    // target stays visible instead of being scrolled past the fold. ensureMessageMounted is not
    // used for this path.
    scrollToIndexCalls.length = 0
    renderList({ targetMessageId: 'msg-30' })
    await waitFor(() => expect(scrollToIndexCalls).toContain('center'))
    expect(scrollToIndexCalls).not.toContain('start') // not tucked flush against the top edge
    expect(ensureMessageMounted).not.toHaveBeenCalledWith('msg-30')
  })

  it('routes reply, poll, and find-on-page jumps through the active list controller', async () => {
    renderList()
    scrollToIndexCalls.length = 0

    act(() => scrollToMessage('msg-30'))

    await waitFor(() => expect(scrollToIndexCalls).toContain('center'))
  })

  it('scrolls to the marker row via scrollToIndex when FAB is clicked with an unread marker', async () => {
    // FAB previously used ensureMessageMounted + querySelector + offsetTop (which fails when the
    // marker is windowed out). New path: getIndexForMessageId + controller-owned
    // scrollToIndex('start'), with no DOM dependency. The measured convergence loop deliberately
    // uses immediate writes: repeatedly restarting native smooth scrolling would make immediate
    // scrollTop samples lie about convergence. align:'start' clamps to the bottom when the marker
    // is the last message, keeping a just-arrived new message fully visible. ensureMessageMounted
    // is no longer called for the FAB.
    getOffsetForMessageId.mockImplementation((id) => (id === 'msg-40' ? 1600 : null))
    const { container, getByLabelText } = renderList({ firstNewMessageId: 'msg-40' })
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true })

    scrollToIndexCalls.length = 0
    scrollToIndexBehaviors.length = 0
    ensureMessageMounted.mockClear()
    fireEvent.click(getByLabelText('chat.scrollToBottom'))
    await waitFor(() => expect(scrollToIndexCalls).toContain('start'))
    expect(scrollToIndexBehaviors).not.toContain('smooth')
    expect(ensureMessageMounted).not.toHaveBeenCalledWith('msg-40')
  })

  it('uses the virtualizer offset, not a fixed row estimate, when deciding whether FAB should stop at the unread marker', () => {
    // msg-40's index would make the old markerIdx * 40 estimate look far below the viewport.
    // The virtualizer's real/estimated offset says it is already visible, so the FAB should go
    // straight to bottom instead of wasting a click at the marker.
    getOffsetForMessageId.mockImplementation((id) => (id === 'msg-40' ? 200 : null))
    const { container, getByLabelText } = renderList({ firstNewMessageId: 'msg-40' })
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true })

    scrollToIndexCalls.length = 0
    fireEvent.click(getByLabelText('chat.scrollToBottom'))

    expect(scrollToIndexCalls).not.toContain('start')
    expect(scrollToIndexCalls).toContain('end')
  })

  it('recenters to latest via onJumpToLatest when the FAB is clicked while the window is slid up', () => {
    // Sliding window: windowAtLiveEdge false ⇒ the resident bottom is NOT the newest. The FAB
    // becomes "jump to latest" — it recenters the resident window before scrolling to the bottom.
    const onJumpToLatest = vi.fn(() => Promise.resolve([]))
    const { container, getByLabelText } = renderList({ windowAtLiveEdge: false, onJumpToLatest })
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true })

    fireEvent.click(getByLabelText('chat.scrollToBottom'))
    expect(onJumpToLatest).toHaveBeenCalledTimes(1)
  })

  it('does NOT recenter on FAB click at the live edge (plain scroll-to-bottom)', () => {
    const onJumpToLatest = vi.fn(() => Promise.resolve([]))
    const { container, getByLabelText } = renderList({ onJumpToLatest }) // windowAtLiveEdge omitted = at edge
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true })

    fireEvent.click(getByLabelText('chat.scrollToBottom'))
    expect(onJumpToLatest).not.toHaveBeenCalled()
  })

  it('routes media-load bottom correction through the virtualizer bottom reassert path', () => {
    vi.useFakeTimers()
    try {
      const { container, getAllByText } = render(
        <MessageList
          messages={makeMessages(8)}
          conversationId="conv-media-load"
          renderMessage={(msg, _idx, _group, _showNew, onMediaLoad) => (
            <button type="button" onClick={onMediaLoad}>media loaded {msg.id}</button>
          )}
        />,
      )
      const scroller = container.querySelector('[data-message-list]') as HTMLElement
      let scrollTopVal = 4500
      Object.defineProperty(scroller, 'scrollHeight', { value: 5000, configurable: true })
      Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
      Object.defineProperty(scroller, 'scrollTop', {
        get: () => scrollTopVal,
        set: (v: number) => { scrollTopVal = v },
        configurable: true,
      })

      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
      scrollToIndexCalls.length = 0

      fireEvent.click(getAllByText(/media loaded/)[0])
      act(() => {
        vi.advanceTimersByTime(151)
      })

      // Old code wrote raw scrollTop = scrollHeight, which does not re-window @tanstack.
      // The fixed path goes through reassertBottom -> scrollToIndex(last, 'end').
      expect(scrollToIndexCalls).toContain('end')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not call ensureMessageMounted when there is no marker or target', () => {
    renderList()
    expect(ensureMessageMounted).not.toHaveBeenCalled()
  })

  it('restores the MAM-prepend scroll from the virtualizer offset, not the windowed-out DOM anchor', () => {
    // After prepend the anchor (msg-0) is windowed out, so querySelector(anchor) returns
    // null and the old code fell back to distance-from-bottom math (landing the viewport on
    // the just-loaded older rows — the reported "position lost"). getOffsetForMessageId
    // returns the anchor's offset even when it is unmounted, so the restore tracks it.
    //
    // Sequence: at scrollTop=0 the anchor is msg-0 at absolutePos=0 (top of content).
    // anchorOffsetFromTop = virtOffset - scrollTop = 0 - 0 = 0.
    // After prepend msg-0 shifts to absolutePos=1000.
    // Restore: newScrollTop = 1000 - 0 = 1000. The anchor stays at the same visual offset.
    getOffsetForMessageId.mockImplementation((id) => (id === 'msg-0' ? 0 : null))
    const older: BaseMessage[] = Array.from({ length: 10 }, (_, i) => ({
      id: `older-${i}`, from: 'user@example.com', body: `Older ${i}`,
      timestamp: new Date(2024, 0, 1, 11, i), isOutgoing: false, type: 'chat' as const,
    }))
    const props = { conversationId: 'conv-1', onScrollToTop: vi.fn(), isHistoryComplete: false, renderMessage: (m: BaseMessage) => <div>{m.body}</div> }

    const { container, getByText, rerender } = render(<MessageList messages={makeMessages(50)} {...props} />)

    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    let scrollTopVal = 0
    const scrollTopSets: number[] = []
    Object.defineProperty(scroller, 'scrollHeight', { get: () => 5000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTopVal,
      set: (v: number) => { scrollTopVal = v; scrollTopSets.push(v) },
      configurable: true,
    })

    // Capture the anchor (msg-0, at absolutePos=0 → offsetFromTop=0 at scrollTop=0).
    fireEvent.click(getByText('chat.loadEarlierMessages'))
    getOffsetForMessageId.mockClear()
    scrollTopSets.length = 0

    // Simulate msg-0 shifting to absolutePos=1000 after the 10 prepended items.
    getOffsetForMessageId.mockImplementation((id) => (id === 'msg-0' ? 1000 : null))

    // Older messages arrive -> firstId + count change -> the prepend restore runs.
    rerender(<MessageList messages={[...older, ...makeMessages(50)]} {...props} />)

    // The restore called getOffsetForMessageId to find the new position of msg-0 and
    // set scrollTop = newOffset - savedOffset = 1000 - 0 = 1000.
    expect(getOffsetForMessageId).toHaveBeenCalledWith('msg-0')
    expect(scrollTopSets).toContain(1000)
  })

  it('restores the scroll on a count-constant slide (load-older at the cap evicts the newest)', () => {
    // Sliding window: at the RESIDENT_WINDOW_SIZE cap, load-older prepends a batch AND evicts the
    // same number of NEWEST messages, so messageCount stays CONSTANT. The old gate required the
    // count to GROW and left the view stranded (the reported jump); the restore must now fire on
    // the firstId change alone. The anchor (msg-0, top-visible) survives — only the newest tail is
    // evicted, far below the viewport.
    getOffsetForMessageId.mockImplementation((id) => (id === 'msg-0' ? 0 : null))
    const older: BaseMessage[] = Array.from({ length: 10 }, (_, i) => ({
      id: `older-${i}`, from: 'user@example.com', body: `Older ${i}`,
      timestamp: new Date(2024, 0, 1, 11, i), isOutgoing: false, type: 'chat' as const,
    }))
    const props = { conversationId: 'conv-slide', onScrollToTop: vi.fn(), isHistoryComplete: false, renderMessage: (m: BaseMessage) => <div>{m.body}</div> }

    const { container, getByText, rerender } = render(<MessageList messages={makeMessages(50)} {...props} />)

    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    let scrollTopVal = 0
    const scrollTopSets: number[] = []
    Object.defineProperty(scroller, 'scrollHeight', { get: () => 5000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTopVal,
      set: (v: number) => { scrollTopVal = v; scrollTopSets.push(v) },
      configurable: true,
    })

    // Capture the anchor (msg-0 at absolutePos=0 → offsetFromTop=0 at scrollTop=0).
    fireEvent.click(getByText('chat.loadEarlierMessages'))
    getOffsetForMessageId.mockClear()
    scrollTopSets.length = 0
    getOffsetForMessageId.mockImplementation((id) => (id === 'msg-0' ? 1000 : null))

    // SLIDE: prepend 10 older AND drop the newest 10 (msg-40..msg-49) → count stays 50,
    // firstId msg-0 → older-0. Under the OLD gate this would have been ignored (count unchanged).
    rerender(<MessageList messages={[...older, ...makeMessages(40)]} {...props} />)

    expect(getOffsetForMessageId).toHaveBeenCalledWith('msg-0')
    expect(scrollTopSets).toContain(1000)
  })

  it('restores (does not strand the view) when load-newer appends + evicts the oldest — count-constant slide DOWN', () => {
    // Sliding window, NEWER direction: the reader is near the resident bottom; load-newer APPENDS
    // newer AND EVICTS the oldest, so count stays constant and firstId becomes NEWER (the opposite
    // of load-older). triggerLoadNewer captures the top-visible anchor and the shared restore
    // repositions it. The exact anchor row depends on windowing, so we assert the OBSERVABLE Task-8
    // property: on the count-constant slide the restore FIRES (consults the virtualizer + repositions
    // via scrollToOffset) — the old countIncreased gate would have left scrollToOffsetCalls empty.
    const onLoadNewer = vi.fn()
    getOffsetForMessageId.mockImplementation(() => 600)
    const props = { conversationId: 'conv-newer', windowAtLiveEdge: false, onLoadNewer, isHistoryComplete: false, renderMessage: (m: BaseMessage) => <div>{m.body}</div> }

    const { container, rerender } = render(<MessageList messages={makeMessages(20)} {...props} />)
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    let scrollTopVal = 600
    Object.defineProperty(scroller, 'scrollHeight', { get: () => 800, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTopVal,
      set: (v: number) => { scrollTopVal = v },
      configurable: true,
    })
    // The authoritative live-edge entry first requests the global tail from this slid-up window.
    expect(onLoadNewer).toHaveBeenCalledTimes(1)

    // Near the bottom (distFromBottom = 800-600-200 = 0): a scroll fires triggerLoadNewer, which
    // captures the top-visible anchor and calls onLoadNewer.
    scrollTopVal = 600
    fireEvent.scroll(scroller)
    expect(onLoadNewer).toHaveBeenCalledTimes(2)

    scrollToOffsetCalls.length = 0
    getOffsetForMessageId.mockClear()
    getOffsetForMessageId.mockImplementation(() => 400) // the captured anchor now sits at 400

    // Append 5 newer (msg-20..24), evict the oldest 5 (msg-0..4) → msg-5..msg-24: count stays 20,
    // firstId msg-0 → msg-5. The restore fires on the firstId change (count unchanged) and repositions.
    rerender(<MessageList messages={makeMessages(25).slice(5)} {...props} />)

    expect(getOffsetForMessageId).toHaveBeenCalled()
    expect(scrollToOffsetCalls.length).toBeGreaterThan(0)
  })

  it('drops a stale anchor when the window returns to the live edge — no stale restore on a later live message', () => {
    // #3 fix: a load-newer that reaches the TAIL is a no-op (nothing appended, firstId unchanged) but
    // triggerLoadNewer already stashed an anchor. When the window returns to the live edge
    // (windowAtLiveEdge false→true) that anchor is stale; leaving it, a LATER live message evicting
    // the oldest at the cap (firstId change) would fire a stale restore. Assert the anchor is dropped:
    // the live-message rerender must NOT reposition (contrast the slide-DOWN test above, which keeps
    // windowAtLiveEdge false and DOES reposition).
    const onLoadNewer = vi.fn()
    getOffsetForMessageId.mockImplementation(() => 400)
    const base = { conversationId: 'conv-stale', onLoadNewer, isHistoryComplete: false, renderMessage: (m: BaseMessage) => <div>{m.body}</div> }

    const { container, rerender } = render(<MessageList messages={makeMessages(20)} windowAtLiveEdge={false} {...base} />)
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    let scrollTopVal = 600
    Object.defineProperty(scroller, 'scrollHeight', { get: () => 800, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', { get: () => scrollTopVal, set: (v: number) => { scrollTopVal = v }, configurable: true })
    // Entry owns global-live-edge reachability and asks for a newer slice before user scrolling.
    expect(onLoadNewer).toHaveBeenCalledTimes(1)

    // Load-newer fires near the bottom → stashes an anchor (no message change here = tail no-op).
    scrollTopVal = 600
    fireEvent.scroll(scroller)
    expect(onLoadNewer).toHaveBeenCalledTimes(2)

    // Tail reached: windowAtLiveEdge flips false→true → the stale anchor must be dropped.
    rerender(<MessageList messages={makeMessages(20)} windowAtLiveEdge={true} {...base} />)

    scrollToOffsetCalls.length = 0

    // Live message at the cap: append newer + evict oldest → firstId changes (count constant). With
    // the anchor dropped, the restore must NOT fire (no scrollToOffset reposition).
    rerender(<MessageList messages={makeMessages(25).slice(5)} windowAtLiveEdge={true} {...base} />)

    expect(scrollToOffsetCalls.length).toBe(0)
  })

  it('positions the unread marker via the virtualizer scrollToIndex on entry, not the windowed-out DOM row', async () => {
    // Entering an unread conversation, the marker row is typically windowed OUT and the
    // messages may still be rehydrating from cache, so querySelector(marker).offsetTop is
    // unreliable (null when unmounted; 0 with no layout). The old code positioned the marker
    // from a raw scrollTop=scrollHeight, which the virtualizer reverts to offset 0 — parking the
    // view at the TOP with the marker stranded below the fold. Resolving an ESTIMATED offset and
    // scrolling there also fails to converge (the scroll never windows the marker row in, so its
    // height never measures and the estimate never sharpens — it stops with the marker below the
    // fold). The fix drives the measurement-aware scrollToIndex(markerIndex,'start'), which windows
    // the marker row in so the entry scroll converges onto it.
    vi.useFakeTimers()
    try {
      // Marker (msg-40) sits 1600px down the content; viewport is 600px tall.
      getOffsetForMessageId.mockImplementation((id) => (id === 'msg-40' ? 1600 : null))

      const { container } = render(
        <MessageList
          messages={makeMessages(50)}
          conversationId={`conv-unread-${Math.random().toString(36).slice(2)}`}
          firstNewMessageId="msg-40"
          renderMessage={(m: BaseMessage) => <div>{m.body}</div>}
        />,
      )
      const scroller = container.querySelector('[data-message-list]') as HTMLElement
      Object.defineProperty(scroller, 'scrollHeight', { get: () => 2000, configurable: true })
      Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true })

      scrollToIndexCalls.length = 0
      // Flush the rAF / timeout re-assert window.
      await vi.advanceTimersByTimeAsync(600)

      // The marker (offset 1600, well past the 200px top-third) routes through scrollToIndex with
      // align 'start' (NOT scrollToOffset to an estimate), landing the view at the marker row
      // (msg-40 is flat index 41 → scrollTop 1640 in the mock), NOT at ~0 (the top).
      expect(getOffsetForMessageId).toHaveBeenCalledWith('msg-40')
      expect(scrollToIndexCalls).toContain('start')
      expect(scroller.scrollTop).toBeGreaterThan(1000)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * Bottom-stick under virtualization. Scroll-to-bottom sets `scrollTop = scrollHeight`, but the
 * bottom rows then mount and measure TALLER than the fixed estimate, so getTotalSize (=
 * scrollHeight) keeps growing AFTER the assignment. A one-shot assignment (or single rAF retry)
 * leaves the last message below the fold — the reported "not perfectly at the bottom, last
 * message hidden". The content ResizeObserver that re-pins on growth for the non-virtualized
 * path is disabled under virtualization, so the hook must re-assert across frames instead.
 *
 * The harness flushes ONE settle frame at the estimated height, THEN grows scrollHeight — so a
 * single deferred retry (which fires on that first frame) cannot reach the grown height; only a
 * multi-frame re-assert can. (jsdom has no layout, so pixel convergence is a real-engine check;
 * here we pin that growth after the initial scroll is followed.)
 */
describe('MessageList — virtualized bottom-stick re-asserts as rows measure', () => {
  let realRaf: typeof requestAnimationFrame
  let rafQueue: FrameRequestCallback[]
  const flush = (frames: number) => {
    for (let i = 0; i < frames; i++) rafQueue.splice(0).forEach((cb) => cb(0))
  }

  beforeEach(() => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    HTMLElement.prototype.scrollTo = vi.fn()
    scrollStateManager.reset()
    rafQueue = []
    scrollToOffsetCalls.length = 0
    scrollToIndexCalls.length = 0
    scrollToIndexStartOffsets.length = 0
    windowedOutKeys.clear()
    realRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    }) as typeof requestAnimationFrame
  })
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf
    localStorage.clear()
  })

  function instrumentScroller(scroller: HTMLElement, initialHeight: number) {
    let scrollHeightVal = initialHeight
    let scrollTopVal = 0
    const scrollTopSets: number[] = []
    Object.defineProperty(scroller, 'scrollHeight', { get: () => scrollHeightVal, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTopVal,
      set: (v: number) => {
        scrollTopVal = v
        scrollTopSets.push(v)
      },
      configurable: true,
    })
    return { scrollTopSets, grow: (h: number) => { scrollHeightVal = h } }
  }

  const props = { renderMessage: (m: BaseMessage) => <div>{m.body}</div> }

  it('does not highlight a target cancelled before its first position write', () => {
    const onConsumed = vi.fn()
    const { container } = render(
      <MessageList
        messages={makeMessages(50)}
        conversationId="conv-target-takeover"
        targetMessageId="msg-30"
        onTargetMessageConsumed={onConsumed}
        {...props}
      />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement

    fireEvent.wheel(scroller, { deltaY: -20 })

    expect(onConsumed).toHaveBeenCalledTimes(1)
    expect(
      container
        .querySelector('[data-message-id="msg-30"]')
        ?.classList.contains('message-highlight'),
    ).toBe(false)
    expect(scrollToIndexCalls).not.toContain('center')
  })

  it('reasserts target-message jumps while virtualized rows settle', () => {
    // Reply/search/activity jumps used to call scrollToIndex('center') once. If rows above the
    // target measured taller after that first landing, the target could drift. The target path now
    // reasserts for a short settle window, mirroring the unread-marker path.
    scrollToIndexStartOffsets.push(1200, 1400, 1400, 1400, 1400, 1400, 1400, 1400)
    const onConsumed = vi.fn()
    const { container } = render(
      <MessageList
        messages={makeMessages(50)}
        conversationId="conv-target-reassert"
        targetMessageId="msg-30"
        onTargetMessageConsumed={onConsumed}
        {...props}
      />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller, 5000)

    scrollToIndexCalls.length = 0
    flush(8)

    expect(scrollToIndexCalls.filter((align) => align === 'center').length).toBeGreaterThan(1)
    expect(onConsumed).toHaveBeenCalledTimes(1)
  })

  // The ResizeObserver bottom-stick correction is intentionally disabled when the virtualizer
  // is active (to prevent oscillation from spacer-height churn). Instead the scroll hook runs a
  // measurement-aware rAF re-assert loop: as rows mount and measure taller/shorter than the
  // fixed estimate, scrollHeight changes, and the loop re-calls scrollToIndex(last,'end') so the
  // last message isn't left clipped (taller) or floating above empty space (shorter).
  it('re-pins to the bottom as scrollHeight grows after a fresh-conversation scroll-to-bottom', () => {
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-A" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    const { scrollTopSets, grow } = instrumentScroller(scroller, 2000)
    rafQueue.length = 0 // drop the initial conv-A render's frames

    // Enter a fresh conversation -> scroll to the (estimated) bottom.
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-B" {...props} />)
    expect(scrollTopSets).toContain(2000)

    // One settle frame at the estimate, THEN the bottom rows measure taller -> height grows.
    scrollTopSets.length = 0
    flush(1)
    grow(3000)
    flush(14)
    expect(scrollTopSets).toContain(3000)
  })

  it('re-pins to the bottom as scrollHeight grows after the FAB scroll-to-bottom', () => {
    const { container } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-fab-pin" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    const { scrollTopSets, grow } = instrumentScroller(scroller, 2000)
    rafQueue.length = 0

    // User is reading history, then clicks the bottom FAB.
    scroller.scrollTop = 200
    // A genuine user scroll fires a wheel (the save gate only persists user-driven positions, not
    // media/measurement-induced shifts); a bare scroll event alone no longer counts.
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    scrollTopSets.length = 0
    fireEvent.click(container.querySelector('[data-fab="scroll-to-bottom"]') as HTMLButtonElement)
    expect(scrollTopSets).toContain(2000)

    // The bottom rows measure taller after the initial jump; the FAB path must use the
    // same re-assert loop as conversation entry/new-message bottom pinning.
    scrollTopSets.length = 0
    flush(1)
    grow(3000)
    flush(14)
    expect(scrollTopSets).toContain(3000)
  })

  it('re-pins to the bottom as a new message row measures taller than the estimate', () => {
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-1" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    const { scrollTopSets, grow } = instrumentScroller(scroller, 2000)
    rafQueue.length = 0

    // A new message arrives while at the bottom -> scroll to the (estimated) bottom.
    scrollTopSets.length = 0
    rerender(<MessageList messages={makeMessages(51)} conversationId="conv-1" {...props} />)
    expect(scrollTopSets).toContain(2000)

    scrollTopSets.length = 0
    flush(1)
    grow(3000)
    flush(14)
    expect(scrollTopSets).toContain(3000)
  })

  it('scrolls to the bottom on a SENT (outgoing) message even when the user had scrolled up', () => {
    // When you send a message you expect to see it, wherever you were reading. An incoming
    // message while scrolled up must NOT yank you down, but your own outgoing message must.
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-send" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    const { scrollTopSets } = instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    // User scrolls far up -> isAtBottom flips false (incoming would no longer auto-follow).
    scroller.scrollTop = 1000
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    scrollTopSets.length = 0

    // The user SENDS a message (last message is outgoing) -> must scroll to the bottom.
    const sent: BaseMessage = {
      id: 'sent-1', from: 'me@example.com', body: 'my reply',
      timestamp: new Date(2024, 0, 1, 13, 0), isOutgoing: true, type: 'chat',
    }
    rerender(<MessageList messages={[...makeMessages(50), sent]} conversationId="conv-send" {...props} />)
    expect(scrollTopSets).toContain(5000)
  })

  it('does NOT yank a scrolled-up reader to the bottom on an INCOMING message', () => {
    // The counterpart to scroll-on-send: widening the scroll trigger must not break the rule
    // that an incoming message leaves a reader who scrolled up where they are.
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-noyank" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    const { scrollTopSets } = instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    // Reading history, far from the bottom -> isAtBottom false.
    scroller.scrollTop = 1000
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    scrollTopSets.length = 0

    // An INCOMING message arrives (last message not outgoing) -> must NOT scroll to the bottom.
    rerender(<MessageList messages={makeMessages(51)} conversationId="conv-noyank" {...props} />)
    expect(scrollTopSets).not.toContain(5000)
  })

  it('keeps following incoming messages within the wider at-bottom tolerance (100px from bottom)', () => {
    // A tall last message that measured slightly short used to leave the view >50px from the
    // bottom, flipping "at bottom" false so the next incoming message stopped following. The
    // wider tolerance keeps a near-bottom view (100px) following.
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-tol" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    const { scrollTopSets } = instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    // Sit 100px above the real bottom (between the old 50px threshold and the new one).
    scroller.scrollTop = 5000 - 500 - 100
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    scrollTopSets.length = 0

    rerender(<MessageList messages={makeMessages(51)} conversationId="conv-tol" {...props} />)
    expect(scrollTopSets).toContain(5000)
  })

  it('restores a scrolled-up conversation from its content anchor on switch (virtualized)', () => {
    // Returning to a conversation you'd scrolled up in must restore via the saved CONTENT ANCHOR,
    // not scroll to the bottom. The anchor row is typically windowed out under virtualization, so
    // the restore resolves it through the virtualizer index (scrollToIndex) and refines to the
    // saved fraction (getOffsetForMessageId) — both keyed to the anchor message. (Real pixel
    // landing is covered by scroll-invariants.ts; jsdom has no layout.)
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-r1" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    // Scroll up and switch away (saves conv-r1; the captured anchor degenerates in jsdom).
    scroller.scrollTop = 200
    // A genuine user scroll fires a wheel (the save gate only persists user-driven positions, not
    // media/measurement-induced shifts); a bare scroll event alone no longer counts.
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-r2" {...props} />)

    // Inject a real anchor, then return. The anchor row is windowed OUT (as it typically is on a
    // real switch-back), so the restore mounts it via scrollToIndex('end'), then refines to the
    // saved fraction on the next frame.
    seedSavedAnchor('conv-r1', 'msg-20')
    windowedOutKeys.add('msg-20')
    getOffsetForMessageId.mockClear()
    rafQueue.length = 0
    scrollToIndexCalls.length = 0
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-r1" {...props} />)
    flush(1) // run the refine frame after the mount windows the anchor in

    // Restore consulted the saved anchor (windowed the row in by index + refined by fraction)
    // rather than scrolling to the bottom and clearing the saved position.
    expect(getOffsetForMessageId).toHaveBeenCalledWith('msg-20')
    expect(scrollToIndexCalls).toContain('end')
  })

  it('keeps restored scrolled-up intent across repeated virtualized room switches', () => {
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="room-repeat-1" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    scroller.scrollTop = 200
    // A genuine user scroll fires a wheel (the save gate only persists user-driven positions, not
    // media/measurement-induced shifts); a bare scroll event alone no longer counts.
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))

    // Round-trip #1: leave (saves room-repeat-1), inject a real anchor, return.
    rerender(<MessageList messages={makeMessages(50)} conversationId="room-repeat-2" {...props} />)
    seedSavedAnchor('room-repeat-1', 'msg-20')
    getOffsetForMessageId.mockClear()
    rerender(<MessageList messages={makeMessages(50)} conversationId="room-repeat-1" {...props} />)
    expect(getOffsetForMessageId).toHaveBeenCalledWith('msg-20')

    // Round-trip #2: the scrolled-up intent must survive a second switch (regression: a coalesced
    // second restore used to be dropped). Re-inject (the jsdom re-capture degenerates) and return.
    rerender(<MessageList messages={makeMessages(50)} conversationId="room-repeat-2" {...props} />)
    seedSavedAnchor('room-repeat-1', 'msg-20')
    getOffsetForMessageId.mockClear()
    rerender(<MessageList messages={makeMessages(50)} conversationId="room-repeat-1" {...props} />)
    expect(getOffsetForMessageId).toHaveBeenCalledWith('msg-20')
  })

  it('does not re-issue scrollToIndex(end) every frame once the restore anchor is resolved', () => {
    // [ScrollReassertLoop] restore-anchor non-convergence. applyAnchor used to issue BOTH
    // scrollToIndex(idx,'end') AND the fractional scrollToOffset on EVERY frame. For a tall anchor
    // at a mid fraction the two targets differ by (1-fraction)*height — a per-frame kick that (on a
    // real engine) knocks the row across the virtualization window boundary so the loop never
    // settles (the console probe showed scrollTop alternating between two states 253px apart, "41
    // scroll writes without settling"). Once the anchor is resolvable in the window, the loop must
    // issue ONLY the fractional scrollToOffset — a single write per frame. jsdom has no layout so we
    // can't reproduce the pixel oscillation; we pin the MECHANISM instead: the redundant per-frame
    // scrollToIndex('end') is gone.
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-converge-1" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    scroller.scrollTop = 200
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-converge-2" {...props} />)

    // Return with a saved anchor that IS in the mounted window (render-all mock) at a mid fraction.
    seedSavedAnchor('conv-converge-1', 'msg-20', 0.5)
    getOffsetForMessageId.mockImplementation((id) => (id === 'msg-20' ? 800 : null))
    // Drop the switch-away conversation's leftover pin-bottom frames: this harness mocks
    // requestAnimationFrame but not cancelAnimationFrame, so supersede can't cancel them, and they
    // would otherwise re-pin to the bottom (scrollToIndex('end')) during the flush below.
    rafQueue.length = 0
    scrollToIndexCalls.length = 0
    scrollToOffsetCalls.length = 0
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-converge-1" {...props} />)

    // Run the restore-anchor rAF loop across many frames.
    flush(20)

    // Refined to the fraction through the virtualizer (a re-window), ...
    expect(scrollToOffsetCalls.length).toBeGreaterThan(0)
    // ... and did NOT re-pin the anchor's bottom to the viewport bottom on every frame.
    expect(scrollToIndexCalls.filter((align) => align === 'end').length).toBeLessThanOrEqual(1)
  })

  it('does not restore an old scrolled-up position after the FAB returns the room to bottom', () => {
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-return-bottom" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    const { scrollTopSets } = instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    // First visit: user scrolled up, so the room should restore this once.
    scroller.scrollTop = 200
    // A genuine user scroll fires a wheel (the save gate only persists user-driven positions, not
    // media/measurement-induced shifts); a bare scroll event alone no longer counts.
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-other" {...props} />)
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-return-bottom" {...props} />)
    expect(scrollTopSets).toContain(200)

    // User explicitly goes back to bottom. Programmatic virtualizer scrolls do not dispatch a
    // synthetic scroll event, so the hook must update its saved switch-away data immediately.
    scrollTopSets.length = 0
    scrollToOffsetCalls.length = 0
    fireEvent.click(container.querySelector('[data-fab="scroll-to-bottom"]') as HTMLButtonElement)
    expect(scrollTopSets).toContain(5000)

    // Switch away and back again. The old 200px restore must not come back.
    scrollTopSets.length = 0
    scrollToOffsetCalls.length = 0
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-other" {...props} />)
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-return-bottom" {...props} />)

    expect(scrollToOffsetCalls).not.toContain(200)
    expect(scrollTopSets).toContain(5000)
  })

  it('re-windows the virtualizer through the anchor on switch-back restore, not a raw scrollTop write', () => {
    // The blank-screen-until-scroll bug: a direct `scroller.scrollTop = saved` leaves @tanstack's
    // offset stale, so on a fresh switch the mounted window keeps the top rows and the restored
    // region renders BLANK until the user scrolls. The restore must route through the virtualizer so
    // it re-windows before paint. With the anchor authoritative, that means resolving the anchor by
    // index (scrollToIndex, which re-windows) and refining to the saved fraction (getOffsetForMessageId
    // → scrollToOffset). jsdom has no layout, so this pins the re-window CONTRACT: the restore
    // consults the anchor through the virtualizer rather than writing a raw scrollTop.
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-rw1" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    scroller.scrollTop = 200
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))

    // Switch away (saves conv-rw1; the captured anchor degenerates in jsdom), inject a real anchor,
    // then return.
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-rw2" {...props} />)
    seedSavedAnchor('conv-rw1', 'msg-20')
    windowedOutKeys.add('msg-20') // the anchor row is windowed out on the fresh switch
    getOffsetForMessageId.mockClear()
    rafQueue.length = 0
    scrollToIndexCalls.length = 0
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-rw1" {...props} />)
    flush(1) // run the refine frame after the mount windows the anchor in

    expect(scrollToIndexCalls).toContain('end')                    // windowed the anchor row in
    expect(getOffsetForMessageId).toHaveBeenCalledWith('msg-20')   // refined to the saved fraction
  })

  it('resolves the anchor through the virtualizer index when the anchor row is windowed out of the DOM', () => {
    // Real-browser case: the virtualizer's initial window covers only the top rows; the saved anchor
    // row is NOT in the DOM, so the DOM anchor lookup (restoreToAnchor) fails. The restore must then
    // resolve the anchor through the virtualizer INDEX (getIndexForMessageId → scrollToIndex),
    // re-deriving its position from measurements — it must NOT go blank or fall back to
    // live-edge fallback (which would clear the saved state and stick the convo at the bottom).
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-vi1" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    scroller.scrollTop = 200
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-vi2" {...props} />)
    seedSavedAnchor('conv-vi1', 'msg-20')

    // Simulate windowed-out anchor: make querySelector return null for message rows so the DOM
    // anchor lookup (restoreToAnchor) fails, AND drop it from the virtualizer's window so the
    // fraction-refine must mount it via scrollToIndex first.
    windowedOutKeys.add('msg-20')
    const origQS = scroller.querySelector.bind(scroller) as (sel: string) => Element | null
    scroller.querySelector = ((sel: string) => {
      if (sel.includes('message-row')) return null
      return origQS(sel)
    }) as typeof scroller.querySelector

    getOffsetForMessageId.mockClear()
    rafQueue.length = 0
    scrollToIndexCalls.length = 0
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-vi1" {...props} />)
    scroller.querySelector = origQS as typeof scroller.querySelector
    flush(1) // run the refine frame after the mount windows the anchor in

    // Resolved the anchor by index (re-windowing the row in) + refined by fraction, rather than a
    // scroll-to-bottom.
    expect(scrollToIndexCalls).toContain('end')
    expect(getOffsetForMessageId).toHaveBeenCalledWith('msg-20')
  })

  it('restores (re-windowed) when a message arrived in the conversation while it was hidden', () => {
    // User report: receiving a message in a NON-focused conversation breaks THAT hidden
    // conversation's saved position (seen on return). Hidden conversations are unmounted
    // (only the active view mounts), so the message just appends to the store array; the
    // saved scroll state is untouched. Returning therefore hits the SAME restore-position
    // path — but with a changed messageCount, which is the natural way to land there. The
    // restore must still re-window the virtualizer to the saved offset, not go blank or
    // jump to the bottom on the newly-arrived message.
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-hidden" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    scroller.scrollTop = 200
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))

    // Switch away (conversation is now hidden / unmounted), inject a real anchor (windowed out).
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-other" {...props} />)
    seedSavedAnchor('conv-hidden', 'msg-20')
    windowedOutKeys.add('msg-20')
    getOffsetForMessageId.mockClear()
    rafQueue.length = 0
    scrollToIndexCalls.length = 0

    // Return AFTER a message arrived while hidden (51 messages now, appended at the bottom).
    rerender(<MessageList messages={makeMessages(51)} conversationId="conv-hidden" {...props} />)
    flush(1) // run the refine frame after the mount windows the anchor in

    // Restore resolved the saved anchor rather than yanking to the new message at the bottom.
    expect(getOffsetForMessageId).toHaveBeenCalledWith('msg-20')
    expect(scrollToIndexCalls).toContain('end')
  })

  it('re-windows the virtualizer when the composer grows (attachment / whisper / reply banner) while at bottom', () => {
    // A composer banner appearing (file attachment preview, whisper marker, reply/edit
    // preview) shrinks the message scroller. The composer-resize correction must re-pin to
    // the bottom THROUGH the virtualizer (scrollToIndex(last,'end')) so the mounted window
    // re-windows — a raw `scrollTop = scrollHeight` write leaves @tanstack's offset stale and
    // the newly-revealed region blank, the same class of bug fixed for conversation-switch and
    // MAM-prepend restores. jsdom has no layout, so this pins the re-window CONTRACT.
    const realRO = globalThis.ResizeObserver
    const observers: Array<{ targets: Element[]; fire: (height: number) => void }> = []
    globalThis.ResizeObserver = class {
      private cb: ResizeObserverCallback
      targets: Element[] = []
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb
        observers.push({ targets: this.targets, fire: (height: number) =>
          this.cb([{ contentRect: { height } } as ResizeObserverEntry], this as unknown as ResizeObserver) })
      }
      observe(t: Element) { this.targets.push(t) }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver

    try {
      const { container } = render(
        <MessageList messages={makeMessages(50)} conversationId="conv-grow" {...props} />,
      )
      const scroller = container.querySelector('[data-message-list]') as HTMLElement
      const { grow } = instrumentScroller(scroller, 5000)
      void grow

      // Sit at the bottom and let the scroll handler record isAtBottom = true.
      scroller.scrollTop = 4500 // scrollHeight 5000 - clientHeight 500
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
      flush(2)

      // The correction observer is the LAST one watching the scroller (MessageWidthProvider's
      // width observer is created first; the scroll-correction observer last).
      const correction = [...observers].reverse().find((o) => o.targets.includes(scroller))
      expect(correction).toBeTruthy()

      scrollToIndexCalls.length = 0

      // Establish the baseline height, then shrink it (composer banner appeared).
      correction!.fire(500)
      flush(1)
      correction!.fire(400)
      flush(1)

      // The correction re-pinned through the virtualizer (re-window), not a raw scrollTop write.
      expect(scrollToIndexCalls).toContain('end')
    } finally {
      globalThis.ResizeObserver = realRO
    }
  })

  it('does NOT jump to the bottom when loading older messages in a SHORT conversation', () => {
    // Reported on a short 1:1 ("Elisabeth"): scrolling up to the top snapped back to the bottom.
    // In a conversation whose content only just exceeds the viewport, the reader is still within
    // AT_BOTTOM_THRESHOLD (150px) of the bottom, so isAtBottom stays TRUE. Loading older messages
    // grows messageCount, and the prepend restore sets restored=true synchronously in its layout
    // effect. The trailing new-message effect then no longer skips (its guard is `!restored`) and,
    // comparing against the stale pre-prepend count, misreads the load-older as a NEW message —
    // pinning the (still "at bottom") view to the bottom. A load-older must preserve position.
    getOffsetForMessageId.mockImplementation((id) => (id === 'msg-0' ? 0 : null))
    const older: BaseMessage[] = Array.from({ length: 10 }, (_, i) => ({
      id: `older-${i}`, from: 'user@example.com', body: `Older ${i}`,
      timestamp: new Date(2024, 0, 1, 11, i), isOutgoing: false, type: 'chat' as const,
    }))
    const shortProps = { conversationId: 'conv-short', onScrollToTop: vi.fn(), isHistoryComplete: false, renderMessage: (m: BaseMessage) => <div>{m.body}</div> }

    const { container, getByText, rerender } = render(<MessageList messages={makeMessages(8)} {...shortProps} />)
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    // Short: content (600) only 100px past the 500px viewport -> the reader counts as "at bottom".
    let scrollTopVal = 0
    Object.defineProperty(scroller, 'scrollHeight', { get: () => 600, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', { get: () => scrollTopVal, set: (v: number) => { scrollTopVal = v }, configurable: true })

    // Capture the anchor (msg-0) the way load-older does.
    fireEvent.click(getByText('chat.loadEarlierMessages'))
    getOffsetForMessageId.mockClear()
    scrollToIndexCalls.length = 0
    scrollToOffsetCalls.length = 0
    // After prepend msg-0 shifts down to absolutePos=400 (10 older rows at 40px).
    getOffsetForMessageId.mockImplementation((id) => (id === 'msg-0' ? 400 : null))

    rerender(<MessageList messages={[...older, ...makeMessages(8)]} {...shortProps} />)

    // The restore re-windowed to the anchor (scrollToOffset). The load-older must NOT then be
    // treated as a new message and pinned to the bottom (scrollToIndex('end')).
    expect(scrollToOffsetCalls.length).toBeGreaterThan(0) // the prepend restore actually ran
    expect(scrollToIndexCalls).not.toContain('end')       // ...and did not jump to the bottom
  })

  it('suppresses the forced repaint on re-pins while a MAM catch-up is loading', () => {
    // Baseline: NOT loading -> the stale-paint fix forces a repaint (offsetHeight read) on a
    // write that actually moved scrollTop, same as every other re-pin test in this file.
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-mam-repaint" isLoadingOlder={false} {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    const { grow } = instrumentScroller(scroller, 2000)
    let offsetHeightReads = 0
    Object.defineProperty(scroller, 'offsetHeight', { get: () => { offsetHeightReads++; return 500 }, configurable: true })
    rafQueue.length = 0

    offsetHeightReads = 0
    rerender(<MessageList messages={makeMessages(51)} conversationId="conv-mam-repaint" isLoadingOlder={false} {...props} />)
    flush(1)
    grow(3000)
    flush(14)
    expect(offsetHeightReads).toBeGreaterThan(0)

    // A MAM page lands (message count grows again) while catch-up is in flight: the re-pin still
    // writes scrollTop, but the expensive forced repaint must be skipped.
    offsetHeightReads = 0
    rerender(<MessageList messages={makeMessages(51)} conversationId="conv-mam-repaint" isLoadingOlder={true} {...props} />)
    rerender(<MessageList messages={makeMessages(52)} conversationId="conv-mam-repaint" isLoadingOlder={true} {...props} />)
    flush(1)
    grow(4000)
    flush(14)
    expect(offsetHeightReads).toBe(0)
  })

  it('fires one clean settle pin when a MAM catch-up completes with no further message growth', () => {
    // The catch-up's last page can land (messageCount already reflects it) with NOTHING further
    // changing except isLoadingOlder flipping false — the "new message" effect sees no count/id
    // change and stays silent, so the completion must be its own trigger.
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-mam-done" isLoadingOlder={true} {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller, 2000)
    rafQueue.length = 0
    scrollToIndexCalls.length = 0

    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-mam-done" isLoadingOlder={false} {...props} />)

    expect(scrollToIndexCalls).toContain('end')
  })

  it('does NOT fire the settle pin on catch-up completion when the reader is scrolled away from the bottom', () => {
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-mam-scrolled" isLoadingOlder={true} {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    // Reader scrolls up, away from the bottom -> isAtBottom flips false.
    scroller.scrollTop = 1000
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    scrollToIndexCalls.length = 0

    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-mam-scrolled" isLoadingOlder={false} {...props} />)

    expect(scrollToIndexCalls).not.toContain('end')
  })
})

/**
 * Target-message HIGHLIGHT (the "go to message" flash) must land on the row even though consuming
 * the target synchronously clears targetMessageId in the same tick. Regression: search "go to
 * message" stopped flashing the arrived row. In the virtualized path the highlight was scheduled in
 * a requestAnimationFrame, but consuming the target (onTargetMessageConsumed -> clearTargetMessageId)
 * nulls targetMessageId, which re-runs the scroll effect and fires its cleanup BEFORE that rAF —
 * cancelling the pending highlight so it never painted.
 *
 * This harness mocks requestAnimationFrame/cancelAnimationFrame with an id->cb map (the shared
 * bottom-stick mock above does not model cancellation, which is exactly the mechanism under test)
 * and drives the target clear through real component state, flushing ONE frame per act() so the
 * clear's re-render + effect cleanup interleave between frames the way the production microtask does.
 */
describe('MessageList — target-message highlight survives the target clear (virtualized)', () => {
  let realRaf: typeof requestAnimationFrame
  let realCaf: typeof cancelAnimationFrame
  let rafCbs: Map<number, FrameRequestCallback>
  let nextRafId: number
  const flush = () => {
    const entries = [...rafCbs.entries()]
    rafCbs.clear()
    entries.forEach(([, cb]) => cb(0))
  }

  beforeEach(() => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    HTMLElement.prototype.scrollTo = vi.fn()
    scrollStateManager.reset()
    scrollToIndexCalls.length = 0
    scrollToOffsetCalls.length = 0
    scrollToIndexStartOffsets.length = 0
    windowedOutKeys.clear()
    rafCbs = new Map()
    nextRafId = 0
    realRaf = globalThis.requestAnimationFrame
    realCaf = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = ++nextRafId
      rafCbs.set(id, cb)
      return id
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((id: number) => { rafCbs.delete(id) }) as typeof cancelAnimationFrame
  })
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf
    globalThis.cancelAnimationFrame = realCaf
    localStorage.clear()
  })

  function Harness() {
    // Mirrors the real wiring: onTargetMessageConsumed = clearTargetMessageId, which nulls the
    // store's targetMessageId, so the prop transitions to undefined the instant the jump is consumed.
    const [target, setTarget] = React.useState<string | undefined>('msg-30')
    const onConsumed = React.useCallback(() => setTarget(undefined), [])
    return (
      <MessageList
        messages={makeMessages(50)}
        conversationId="conv-highlight"
        targetMessageId={target}
        onTargetMessageConsumed={onConsumed}
        renderMessage={(m: BaseMessage) => <div>{m.body}</div>}
      />
    )
  }

  it('applies .message-highlight to the target row even though consuming it clears the target', () => {
    // Hold scrollTop steady so the controller reaches its stable-frame threshold and consumes.
    scrollToIndexStartOffsets.push(1200, 1400, 1400, 1400, 1400, 1400, 1400, 1400, 1400, 1400)
    const { container } = render(<Harness />)
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    let top = 5000
    Object.defineProperty(scroller, 'scrollHeight', { get: () => 8000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => top,
      set: (v: number) => { top = v },
      configurable: true,
    })

    // One frame per act() so the target-clear re-render + effect cleanup land between frames — the
    // window in which the buggy cleanup cancels the not-yet-fired highlight rAF.
    for (let i = 0; i < 10; i++) act(() => flush())

    const targetRow = container.querySelector('[data-message-id="msg-30"]')
    expect(targetRow).not.toBeNull()
    expect(targetRow?.classList.contains('message-highlight')).toBe(true)
  })
})
