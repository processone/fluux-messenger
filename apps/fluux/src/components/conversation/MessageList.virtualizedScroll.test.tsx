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
 * integration CONTRACT (ensureMessageMounted is invoked with the right id), which is the
 * piece that has no other automated guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { MessageList, type MessageListProps } from './MessageList'
import type { BaseMessage } from '@fluux/sdk'

const ensureMessageMounted = vi.fn((_id: string) => Promise.resolve())

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/hooks', () => ({ useMessageCopyFormatter: vi.fn() }))

// Inject a fake MessageVirtualizer (render-all window) with a spy ensureMessageMounted, so
// the MessageList -> useMessageListScroll -> virtualizer wiring is observable in jsdom.
vi.mock('./tanstackMessageVirtualizer', () => ({
  useTanstackMessageVirtualizer: (args: { items: { key: string }[] }) => ({
    getVirtualItems: () => args.items.map((it, index) => ({ index, start: index * 40, size: 40, key: it.key })),
    getTotalSize: () => args.items.length * 40,
    getOffsetForMessageId: () => 0,
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
})
