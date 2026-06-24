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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { MessageList, type MessageListProps } from './MessageList'
import type { BaseMessage } from '@fluux/sdk'

const ensureMessageMounted = vi.fn((_id: string) => Promise.resolve())
const getOffsetForMessageId = vi.fn((_id: string): number | null => 0)

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/hooks', () => ({ useMessageCopyFormatter: vi.fn() }))

// Inject a fake MessageVirtualizer (render-all window) with spies, so the
// MessageList -> useMessageListScroll -> virtualizer wiring is observable in jsdom.
vi.mock('./tanstackMessageVirtualizer', () => ({
  useTanstackMessageVirtualizer: (args: { items: { key: string }[] }) => ({
    getVirtualItems: () => args.items.map((it, index) => ({ index, start: index * 40, size: 40, key: it.key })),
    getTotalSize: () => args.items.length * 40,
    getOffsetForMessageId,
    ensureMessageMounted,
    measureElement: () => {},
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
    getOffsetForMessageId.mockImplementation((id) => (id === 'msg-0' ? 1000 : null))
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

    // Capture the anchor (msg-0, offsetFromTop 0 in jsdom) via the "Load earlier" button.
    fireEvent.click(getByText('chat.loadEarlierMessages'))
    getOffsetForMessageId.mockClear()
    scrollTopSets.length = 0

    // Older messages arrive -> firstId + count change -> the prepend restore runs.
    rerender(<MessageList messages={[...older, ...makeMessages(50)]} {...props} />)

    // The restore consulted the VIRTUALIZER for the windowed-out anchor and positioned by
    // its offset (1000 - anchorOffsetFromTop 0). (A later, orthogonal scroll-to-bottom effect
    // may overwrite the final value in this harness; the prepend positioning is what matters,
    // and the exact pixel convergence is verified on a real engine.)
    expect(getOffsetForMessageId).toHaveBeenCalledWith('msg-0')
    expect(scrollTopSets).toContain(1000)
  })
})
