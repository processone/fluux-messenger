/**
 * @vitest-environment jsdom
 *
 * Structural test for the VIRTUALIZED (flag ON) MessageList render path. Uses a
 * render-all @tanstack mock (jsdom has no layout, so the real virtualizer would
 * mount nothing) — this verifies the windowed render produces the right rows and
 * header/footer items, NOT that windowing actually happens (that is verified in the
 * demo / on a real engine).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageList } from './MessageList'
import type { BaseMessage } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/hooks', () => ({ useMessageCopyFormatter: vi.fn() }))

// Render-all @tanstack mock: every item mounts so the structure is assertable in jsdom.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey: (i: number) => string }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index, key: opts.getItemKey(index), start: index * 40, end: index * 40 + 40, size: 40, lane: 0,
      })),
    getTotalSize: () => opts.count * 40,
    getOffsetForIndex: (i: number) => [i * 40, 'start'] as const,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}))

function makeMessages(count: number): BaseMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    from: 'user@example.com',
    body: `Body ${i}`,
    timestamp: new Date(2024, 0, 1, 12, i),
    isOutgoing: false,
    type: 'chat' as const,
  }))
}

describe('MessageList — virtualized render path (flag ON)', () => {
  beforeEach(() => localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true'))
  afterEach(() => localStorage.clear())

  it('renders one windowed message-row per message, with data-message-id + body + a date separator', () => {
    const { container } = render(
      <MessageList messages={makeMessages(3)} conversationId="conv-1" renderMessage={(msg) => <div>{msg.body}</div>} />,
    )
    const rows = container.querySelectorAll('.message-row[data-message-id]')
    expect([...rows].map((r) => r.getAttribute('data-message-id'))).toEqual(['msg-0', 'msg-1', 'msg-2'])
    expect(screen.getByText('Body 0')).toBeInTheDocument()
    expect(screen.getByText('Body 2')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-date-separator]')).toHaveLength(1)
  })

  it('renders the load-earlier header item when history is incomplete', () => {
    render(
      <MessageList
        messages={makeMessages(2)}
        conversationId="conv-1"
        renderMessage={(msg) => <div>{msg.body}</div>}
        onScrollToTop={() => {}}
        isHistoryComplete={false}
      />,
    )
    expect(screen.getByText('chat.loadEarlierMessages')).toBeInTheDocument()
  })
})
