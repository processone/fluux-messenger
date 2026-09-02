/**
 * @vitest-environment jsdom
 *
 * AN UNREAD DIVIDER OUTSIDE THE RESIDENT WINDOW MUST NOT PARK THE LIST.
 *
 * Entry with unread messages positions the first-unread marker instead of the
 * live edge. The marker's row is resolved through the virtualizer, and a row
 * that is not there yet is a normal transient while the item set is still being
 * built — so the executor reports `waiting` and the frame loop retries.
 *
 * A divider can also name a message that is not in the window at all: rooms load
 * 100 messages on activation, and a read pointer synced from another device
 * (XEP-0490) can predate that slice. Then no retry can ever succeed. Treating
 * that as `waiting` leaves the view at scrollTop 0 — the TOP of the window, the
 * oldest loaded message — for the rest of the visit. Worse, entry marks the list
 * as not-at-bottom before positioning, so the read pointer stops advancing and
 * every later message is counted unread. That is the reported "conversation went
 * back in time" failure, and it does not self-heal.
 *
 * The unresolvable case must be terminal so the controller's live-edge fallback
 * takes over.
 *
 * Both entry orders are covered, because they fail differently. When the slice is
 * already resident, the executor answers `unavailable` on the first frame. When
 * the slice lands after entry, the fallback is promoted from inside a rAF frame,
 * so the live-edge executor it carries was built during the empty entry render —
 * and a reachability probe that still describes THAT window reports
 * `empty-window`, parking the promoted execution in `pending` with no frame loop.
 * Nothing revives it: the refresh effect that would re-drive a parked live edge
 * ran on the arriving-rows commit, before the fallback existed.
 *
 * Harness (mocked virtualizer, fake rAF queue, instrumented scroller geometry)
 * mirrors MessageList.pinBottomBehavior.test.tsx. `virt.ready` models the item
 * set being built after entry.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { MessageList } from './MessageList'
import type { BaseMessage } from '@fluux/sdk'

const virt = vi.hoisted(() => ({ ready: false }))

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
    getVirtualItems: () => virt.ready ? args.items.map((it, index) => ({ index, start: index * 40, size: 40, key: it.key })) : [],
    getTotalSize: () => virt.ready ? args.items.length * 40 : 0,
    itemCount: virt.ready ? args.items.length : 0,
    getOffsetForMessageId: () => 0,
    getIndexForMessageId: (id: string) => {
      const i = args.items.findIndex((it) => it.key === id)
      return virt.ready && i >= 0 ? i : null
    },
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
// Rooms load this many messages from cache on activation (roomStore.ts).
const CACHED = 100

function makeMessages(count: number): BaseMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`, from: 'user@example.com', body: `Body ${i}`,
    timestamp: new Date(2024, 0, 1, 12, i % 60), isOutgoing: false, type: 'chat' as const,
  }))
}

describe('MessageList — unread divider outside the resident window', () => {
  let realRaf: typeof requestAnimationFrame
  let rafQueue: FrameRequestCallback[]
  const flush = (frames: number) => { for (let i = 0; i < frames; i++) rafQueue.splice(0).forEach((cb) => cb(0)) }

  const geo = { scrollHeight: 500, clientHeight: 500 }
  const bottom = () => geo.scrollHeight - geo.clientHeight

  function instrumentScroller(scroller: HTMLElement) {
    let top = 0
    Object.defineProperty(scroller, 'scrollHeight', { get: () => geo.scrollHeight, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { get: () => geo.clientHeight, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => top,
      set: (v: number) => { top = Math.max(0, Math.min(v, Math.max(0, geo.scrollHeight - geo.clientHeight))) },
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
    virt.ready = false
    geo.scrollHeight = 500
    geo.clientHeight = 500
  })
  afterEach(() => { globalThis.requestAnimationFrame = realRaf; localStorage.clear() })

  const props = { renderMessage: (m: BaseMessage) => <div>{m.body}</div>, onScrollToTop: vi.fn(), isHistoryComplete: false }

  /** Entry with the cached slice already resident — what the reported trace shows
   *  (`enterConversation ... messageCount: 100`). */
  function enterWithSlice(conversationId: string, extra: Record<string, unknown>) {
    const isAtBottomRef = { current: true }
    virt.ready = true
    geo.scrollHeight = CACHED * ROW
    const view = render(
      <MessageList messages={makeMessages(CACHED)} conversationId={conversationId} isAtBottomRef={isAtBottomRef} {...extra} {...props} />,
    )
    const scroller = view.container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)
    flush(120)
    return { scroller, isAtBottomRef }
  }

  /** Entry before the cache read resolves, slice lands afterwards. */
  function enterThenLoadSlice(conversationId: string, extra: Record<string, unknown>) {
    const isAtBottomRef = { current: true }
    const view = render(
      <MessageList messages={[]} conversationId={conversationId} isAtBottomRef={isAtBottomRef} {...extra} {...props} />,
    )
    const scroller = view.container.querySelector('[data-message-list]') as HTMLElement
    instrumentScroller(scroller)
    flush(70)

    virt.ready = true
    geo.scrollHeight = CACHED * ROW
    view.rerender(
      <MessageList messages={makeMessages(CACHED)} conversationId={conversationId} isAtBottomRef={isAtBottomRef} {...extra} {...props} />,
    )
    flush(120)
    return { scroller, isAtBottomRef }
  }

  const offWindow = { firstNewMessageRow: { id: 'archive-id-not-in-slice' }, unreadCount: 13 }

  it('falls back to the live edge when the divider is outside an already-resident window', () => {
    const { scroller, isAtBottomRef } = enterWithSlice('room-off-window-resident', offWindow)

    expect(scroller.scrollTop).toBe(bottom())
    expect(isAtBottomRef.current).toBe(true)
  })

  it('falls back to the live edge when the divider is outside a slice that lands after entry', () => {
    const { scroller, isAtBottomRef } = enterThenLoadSlice('room-off-window-late-slice', offWindow)

    expect(scroller.scrollTop).toBe(bottom())
    expect(isAtBottomRef.current).toBe(true)
  })

  it('still reaches the live edge when entry carries no divider', () => {
    const { scroller, isAtBottomRef } = enterThenLoadSlice('room-no-divider', {})

    expect(scroller.scrollTop).toBe(bottom())
    expect(isAtBottomRef.current).toBe(true)
  })
})
