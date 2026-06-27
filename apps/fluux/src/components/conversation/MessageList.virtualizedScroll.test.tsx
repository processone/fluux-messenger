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
 *  - jump sites call `ensureMessageMounted(id)` to bring an off-window row in;
 *  - the MAM prepend restore reads the anchor offset from the VIRTUALIZER
 *    (`getOffsetForMessageId`), not `querySelector(anchor).offsetTop` — the anchor is
 *    windowed out on prepend, so the DOM read returns null and the old code fell back to
 *    distance-from-bottom math that landed the viewport on the just-loaded older rows.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { MessageList, type MessageListProps } from './MessageList'
import type { BaseMessage } from '@fluux/sdk'

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
    getVirtualItems: () => args.items.map((it, index) => ({ index, start: index * 40, size: 40, key: it.key })),
    getTotalSize: () => args.items.length * 40,
    itemCount: args.items.length,
    getOffsetForMessageId,
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
    scrollToIndex: (_index: number, opts?: { align?: string }) => {
      scrollToIndexCalls.push(opts?.align)
      const el = args.scrollRef.current
      if (!el) return
      if (opts?.align === 'end') {
        el.scrollTop = el.scrollHeight  // simulate scroll-to-bottom
      } else {
        el.scrollTop = _index * 40
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

describe('MessageList — virtualized scroll integration (ensureMessageMounted)', () => {
  beforeEach(() => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    // jsdom doesn't implement Element.scrollTo; the scroll-to-bottom path calls it.
    HTMLElement.prototype.scrollTo = vi.fn()
    ensureMessageMounted.mockClear()
    getOffsetForMessageId.mockClear()
    getOffsetForMessageId.mockImplementation(() => 0)
  })
  afterEach(() => localStorage.clear())

  it('brings the unread-marker row into the window on conversation entry', () => {
    renderList({ firstNewMessageId: 'msg-40' })
    expect(ensureMessageMounted).toHaveBeenCalledWith('msg-40')
  })

  it('brings the target row into the window when a targetMessageId is set (reply / find-on-page jump)', () => {
    renderList({ targetMessageId: 'msg-30' })
    expect(ensureMessageMounted).toHaveBeenCalledWith('msg-30')
  })

  it('brings the marker row into the window when scroll-to-bottom is clicked with an unread marker', () => {
    const { getByLabelText } = renderList({ firstNewMessageId: 'msg-40' })
    ensureMessageMounted.mockClear()
    fireEvent.click(getByLabelText('chat.scrollToBottom'))
    expect(ensureMessageMounted).toHaveBeenCalledWith('msg-40')
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

  it('positions the unread marker from the virtualizer offset on entry, not the windowed-out DOM row', async () => {
    // Entering an unread conversation, the marker row is typically windowed OUT and the
    // messages may still be rehydrating from cache, so querySelector(marker).offsetTop is
    // unreliable (null when unmounted; 0 with no layout). The old code positioned the marker
    // from that DOM read and fell back to a raw scrollTop=scrollHeight, which the virtualizer
    // reverts to offset 0 — parking the view at the TOP with the marker stranded below the fold.
    // The fix resolves the marker offset from the virtualizer (getOffsetForMessageId), which
    // works for unmounted rows, so the entry scroll lands at the marker.
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

      scrollToOffsetCalls.length = 0
      // Flush the rAF / timeout re-assert window.
      await vi.advanceTimersByTimeAsync(600)

      // Target = markerOffset - viewportHeight/3 = 1600 - 200 = 1400. The view must land at the
      // marker (offset well below the fold), NOT at ~0 (the top) as the windowed-out DOM read gave.
      expect(getOffsetForMessageId).toHaveBeenCalledWith('msg-40')
      expect(scrollToOffsetCalls.some((o) => o > 1000)).toBe(true)
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
    rafQueue = []
    scrollToOffsetCalls.length = 0
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

  it('restores a scrolled-up position on conversation switch instead of jumping to the bottom (virtualized)', () => {
    // Returning to a conversation you'd scrolled up in must restore that position, not
    // scroll-to-bottom. The flag-OFF suite covers this; this pins it with the virtualizer wired.
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-r1" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    const { scrollTopSets } = instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    // Scroll up to 200 and let the scroll handler record the position + anchor.
    scroller.scrollTop = 200
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))

    // Switch away (saves conv-r1's position) then back (should restore it).
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-r2" {...props} />)
    scrollTopSets.length = 0
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-r1" {...props} />)

    // Restored to the saved scroll position (200), not scrolled to the bottom (5000). Under
    // virtualization the anchor is typically windowed out, so the saved-pixel fallback is what
    // runs — pinning it guards against a refactor that regresses restore into a scroll-to-bottom.
    expect(scrollTopSets).toContain(200)
    expect(scrollTopSets).not.toContain(5000)
  })

  it('re-windows the virtualizer (scrollToOffset) on switch-back restore, not just a raw scrollTop write', () => {
    // The blank-screen-until-scroll bug: a direct `scroller.scrollTop = saved` leaves
    // @tanstack's scrollOffset stale (it syncs only from the scroll event / rAF poll),
    // so on a fresh switch the mounted window keeps the top rows and the restored region
    // renders BLANK until the user scrolls. The restore must route the offset through the
    // virtualizer (scrollToOffset) so it re-windows before paint — same as the MAM-prepend
    // restore and scroll-to-bottom. jsdom has no layout (the blank can't be observed), so
    // this pins the re-window CONTRACT: scrollToOffset is called with the restored offset.
    // (Both restore sub-paths — content-stable anchor and saved-pixel fallback — must
    // re-window; in production the anchor row is usually windowed out so the pixel path runs.)
    const { container, rerender } = render(
      <MessageList messages={makeMessages(50)} conversationId="conv-rw1" {...props} />,
    )
    const scroller = container.querySelector('[data-message-list]') as HTMLElement
    const { scrollTopSets } = instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    // Scroll up to 200 and let the scroll handler record the position + anchor.
    scroller.scrollTop = 200
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))

    // Switch away (saves conv-rw1's position) then back (should restore it).
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-rw2" {...props} />)
    scrollToOffsetCalls.length = 0
    scrollTopSets.length = 0
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-rw1" {...props} />)

    // The restore re-windowed the virtualizer at the saved offset rather than only writing
    // scrollTop. Without the fix scrollToOffset is never called and the viewport goes blank.
    expect(scrollToOffsetCalls).toContain(200)
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
    const { scrollTopSets } = instrumentScroller(scroller, 5000)
    rafQueue.length = 0

    // Scroll up to 200 in the conversation and record the position + anchor.
    scroller.scrollTop = 200
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))

    // Switch away (conversation is now hidden / unmounted from the user's view).
    rerender(<MessageList messages={makeMessages(50)} conversationId="conv-other" {...props} />)
    scrollToOffsetCalls.length = 0
    scrollTopSets.length = 0

    // Return to it AFTER a message arrived while it was hidden (51 messages now). The new
    // message is appended at the bottom, so the saved scrolled-up position is still valid.
    rerender(<MessageList messages={makeMessages(51)} conversationId="conv-hidden" {...props} />)

    // Restored (and re-windowed) to the saved offset, not yanked to the new message at bottom.
    expect(scrollToOffsetCalls).toContain(200)
    expect(scrollTopSets).not.toContain(5000)
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
})
