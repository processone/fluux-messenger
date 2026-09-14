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
import type { BaseMessage, RoomMessage } from '@fluux/sdk'
import { confirmedRoomMessage } from '@/test-utils/roomMessages'
import { findMessageRowElement, messageRowId } from './messageRowIdentity'
import type { MessageVirtualizer } from './messageVirtualizer'

const rangeSelectionState = vi.hoisted(() => ({
  selectedIds: new Set<string>(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/hooks', () => ({
  useMessageCopyFormatter: vi.fn(),
  useMessageRangeSelection: vi.fn(() => ({
    copySelectedIds: rangeSelectionState.selectedIds,
    selectionCount: rangeSelectionState.selectedIds.size,
    isSelecting: false,
    selectAll: vi.fn(),
    extendTo: vi.fn(),
    clearSelection: vi.fn(),
    copySelected: vi.fn(),
  })),
}))

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

// Adapter mock: captures the args passed by MessageList so we can assert estimateSize.
// Returns a render-all stub so the structure tests still pass (same behaviour as the
// @tanstack/react-virtual mock, but at the adapter level).
interface CapturedItem { key: string; kind: string }
let _capturedAdapterArgs: {
  estimateSize?: (index: number) => number
  items?: readonly CapturedItem[]
} = {}
vi.mock('./tanstackMessageVirtualizer', () => ({
  useTanstackMessageVirtualizer: (args: {
    estimateSize?: (index: number) => number
    items?: readonly CapturedItem[]
  }) => {
    _capturedAdapterArgs = args
    const items = args.items ?? []
    const stub: MessageVirtualizer = {
      getVirtualItems: () =>
        items.map((_, index) => ({ index, start: index * 40, size: 40, key: items[index].key })),
      getTotalSize: () => items.length * 40,
      itemCount: items.length,
      getOffsetForMessageId: () => null,
      getIndexForMessageId: () => null,
      ensureMessageMounted: async () => {},
      measureElement: () => {},
      scrollToOffset: () => {},
      scrollToIndex: () => {},
      beginAnimatedScrollToOffset: () => {},
    }
    return stub
  },
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
  it('deduplicates direct-chat IDs and preserves mounted row state during archive backfill', () => {
    const first: BaseMessage = { type: 'chat', id: 'direct', from: 'peer@example.com',
      body: 'Direct message', timestamp: new Date(1000), isOutgoing: false }
    const renderMessage = (msg: BaseMessage) => <input aria-label={msg.body} defaultValue="Local row state" />
    const { container, rerender } = render(<MessageList messages={[first]} conversationId="peer@example.com" renderMessage={renderMessage} />)
    const row = container.querySelector('.message-row')!
    const input = container.querySelector('input')!
    input.value = 'State retained'
    const backfilled = { ...first, stanzaId: 'archive-one' }
    rerender(<MessageList messages={[backfilled, { ...backfilled, stanzaId: 'archive-two', body: 'Duplicate direct ID' }]}
      conversationId="peer@example.com" renderMessage={renderMessage} />)
    expect(container.querySelectorAll('.message-row')).toHaveLength(1)
    expect(container.querySelector('.message-row')).toBe(row)
    expect(container.querySelector('input')).toBe(input)
    expect(input.value).toBe('State retained')
    expect(row).toHaveAttribute('data-message-row-id', 'direct')
  })

  it.each(['body', 'timestamp'])('renders uncertain and confirmed rows with identical raw IDs when %s differs', difference => {
    const first: RoomMessage = { type: 'groupchat', roomJid: 'room@example.com', from: 'room@example.com/Peer', nick: 'Peer',
      id: 'shared', occupantId: 'peer', stanzaId: 'same', body: 'Uncertain row', timestamp: new Date(1000), isOutgoing: false }
    const second = confirmedRoomMessage({ ...first,
      ...(difference === 'body' ? { body: 'Confirmed row' } : { timestamp: new Date(2000) }) })
    const { container, rerender } = render(<MessageList messages={[first, second]}
      conversationId={first.roomJid} renderMessage={msg => <div>{msg.body}</div>} />)
    const rows = [...container.querySelectorAll<HTMLElement>('.message-row')]
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.textContent)).toEqual([first.body, second.body])
    expect(new Set(rows.map(row => row.dataset.messageRowId)).size).toBe(2)
    expect(findMessageRowElement(container, messageRowId(first)!)).toBe(rows[0])
    expect(findMessageRowElement(container, messageRowId(second)!)).toBe(rows[1])
    rerender(<MessageList messages={[second]} conversationId={first.roomJid} renderMessage={msg => <div>{msg.body}</div>} />)
    expect(container.querySelectorAll('.message-row')).toHaveLength(1)
    expect(findMessageRowElement(container, messageRowId(first)!)).toBeNull()
    expect(findMessageRowElement(container, messageRowId(second)!)).not.toBeNull()
  })

  beforeEach(() => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    _capturedAdapterArgs = {}
    rangeSelectionState.selectedIds = new Set<string>()
  })
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

  it('keeps colliding client and occupant IDs distinct in virtualized rows and keys', () => {
    const first = { ...makeMessages(1)[0], type: 'groupchat' as const, occupantId: 'peer', stanzaId: 'first' }
    const second = { ...first, stanzaId: 'second', body: 'Second archive row', timestamp: new Date(2024, 0, 1, 12, 1) }
    const { container } = render(<MessageList messages={[first, { ...first }, second]}
      conversationId="room@example.com" renderMessage={msg => <div>{msg.body}</div>} />)
    const rows = [...container.querySelectorAll<HTMLElement>('.message-row')]
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(row => row.dataset.messageRowId)).size).toBe(2)
    expect(container.textContent).toContain('Second archive row')
    const keys = _capturedAdapterArgs.items!.map(item => item.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('marks bulk-copy rows with the shared selected-message styling hook', () => {
    rangeSelectionState.selectedIds = new Set(['msg-1'])

    const { container } = render(
      <MessageList messages={makeMessages(3)} conversationId="conv-1" renderMessage={(msg) => <div>{msg.body}</div>} />,
    )

    expect(container.querySelector('[data-message-id="msg-1"]')).toHaveAttribute('data-msg-selected', '')
    expect(container.querySelector('[data-message-id="msg-0"]')).not.toHaveAttribute('data-msg-selected')
    expect(container.querySelector('[data-message-id="msg-2"]')).not.toHaveAttribute('data-msg-selected')
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

  it('passes a per-index estimateSize function to the adapter when virtualized, and it routes date items to the date chrome fallback', () => {
    render(
      <MessageList
        messages={makeMessages(3)}
        conversationId="conv-1"
        renderMessage={(msg) => <div>{msg.body}</div>}
      />,
    )
    const { estimateSize, items } = _capturedAdapterArgs
    expect(typeof estimateSize).toBe('function')

    // Calling the captured estimate for a DATE item returns the date chrome fallback (48). Date is
    // pure (no canvas) — unlike a message row whose text path needs canvas — and under jsdom
    // useRowMetrics returns ROW_METRICS_FALLBACK, whose chrome.date is 48.
    const dateIndex = (items ?? []).findIndex((it) => it.kind === 'date')
    expect(dateIndex).toBeGreaterThanOrEqual(0)
    expect(estimateSize!(dateIndex)).toBe(48)
  })
})
