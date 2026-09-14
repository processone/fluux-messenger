/**
 * @vitest-environment jsdom
 *
 * Regression guard: MessageList must render with ZERO React
 * `Each child in a list should have a unique "key" prop` warnings — even when
 * a message arrives without an `id`.
 *
 * `BaseMessage.id` is typed `string`, but demo echoes and persisted state can
 * violate that invariant (a stanza with no id attribute). `key={undefined}` is
 * treated by React as a MISSING key, so the reconciler warned on every
 * re-render ("Check the render method of `div`. It was passed a child from
 * MessageList."). The row key must therefore fall back to another stable
 * identifier, and the id-based dedup must not swallow id-less messages
 * (two distinct messages with `id: undefined` are not duplicates).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Asserts the non-virtualized message list (still shipping until the old path is removed);
// the virtualized render is covered by MessageList.virtualized.test.tsx + unit tests.
vi.mock('@/utils/featureFlags', () => ({ isFeatureEnabled: () => false }))
import { render } from '@testing-library/react'
import { MessageList } from './MessageList'
import type { BaseMessage, RoomMessage } from '@fluux/sdk'
import { confirmedRoomMessage } from '@/test-utils/roomMessages'
import { findMessageRowElement, messageRowId } from './messageRowIdentity'
import { scrollStateManager } from '@/utils/scrollStateManager'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
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

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const KEY_WARNING = /unique "key" prop/

function message(overrides: Partial<BaseMessage>): BaseMessage {
  return {
    id: 'msg-default',
    from: 'user@example.com',
    body: 'hello',
    timestamp: new Date(2024, 0, 1, 12, 0),
    isOutgoing: false,
    type: 'chat' as const,
    ...overrides,
  }
}

describe('MessageList — row keys resilient to id-less messages', () => {
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
    vi.clearAllMocks()
    scrollStateManager.reset()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders messages with undefined id without key warnings and without dropping them', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const messages: BaseMessage[] = [
      message({ id: 'msg-1', body: 'first', timestamp: new Date(2024, 0, 1, 12, 0) }),
      // Two DISTINCT id-less messages: both must render, with stable keys.
      message({
        id: undefined as unknown as string,
        body: 'no id, has stanza id',
        stanzaId: 'stanza-abc',
        timestamp: new Date(2024, 0, 1, 12, 1),
      }),
      message({
        id: undefined as unknown as string,
        body: 'no id at all',
        timestamp: new Date(2024, 0, 1, 12, 2),
      }),
      message({ id: 'msg-2', body: 'last', timestamp: new Date(2024, 0, 1, 12, 3) }),
    ]

    const { container } = render(
      <MessageList
        messages={messages}
        conversationId="conv-keys"
        clearFirstNewMessageId={vi.fn()}
        renderMessage={(msg) => <div>{msg.body}</div>}
      />
    )

    const keyWarnings = errorSpy.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && KEY_WARNING.test(a)),
    )
    expect(keyWarnings).toEqual([])

    // Dedup must not treat distinct id-less messages as duplicates of each other.
    expect(container.querySelectorAll('.message-row')).toHaveLength(4)
    expect(container.textContent).toContain('no id, has stanza id')
    expect(container.textContent).toContain('no id at all')
  })

  it('still deduplicates messages sharing a real id', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const messages: BaseMessage[] = [
      message({ id: 'dup', body: 'kept' }),
      message({ id: 'dup', body: 'dropped', timestamp: new Date(2024, 0, 1, 12, 1) }),
    ]

    const { container } = render(
      <MessageList
        messages={messages}
        conversationId="conv-dedup"
        clearFirstNewMessageId={vi.fn()}
        renderMessage={(msg) => <div>{msg.body}</div>}
      />
    )

    expect(container.querySelectorAll('.message-row')).toHaveLength(1)
    const keyWarnings = errorSpy.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && KEY_WARNING.test(a)),
    )
    expect(keyWarnings).toEqual([])
  })

  it('keeps occupant-conflicting rows distinct when their client ids collide', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const messages = [
      { ...message({ id: 'shared', type: 'groupchat', body: 'departed' }), occupantId: 'occupant-a' },
      {
        ...message({
          id: 'shared',
          type: 'groupchat',
          body: 'newcomer',
          timestamp: new Date(2024, 0, 1, 12, 1),
        }),
        occupantId: 'occupant-b',
      },
    ]

    const { container } = render(
      <MessageList
        messages={messages}
        conversationId="room@conference.example.com"
        clearFirstNewMessageId={vi.fn()}
        renderMessage={(msg) => <div>{msg.body}</div>}
      />
    )

    const rows = [...container.querySelectorAll<HTMLElement>('.message-row')]
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.dataset.messageId)).toEqual(['shared', 'shared'])
    expect(new Set(rows.map((row) => row.dataset.messageRowId)).size).toBe(2)
    expect(container.textContent).toContain('departed')
    expect(container.textContent).toContain('newcomer')
    expect(errorSpy.mock.calls.some((args) => args.some((arg) =>
      typeof arg === 'string' && KEY_WARNING.test(arg)
    ))).toBe(false)
  })

  it.each([undefined, 'same-author'])('renders distinct archive rows with reused client IDs and occupant %s', occupantId => {
    const first = { ...message({ id: 'shared', type: 'groupchat', stanzaId: 'first', body: 'First row' }), occupantId }
    const second = { ...first, stanzaId: 'second', body: 'Second row', timestamp: new Date(2024, 0, 1, 12, 1) }
    const { container } = render(<MessageList messages={[first, { ...first }, second]}
      conversationId="room@example.com" renderMessage={msg => <div>{msg.body}</div>} />)
    const rows = [...container.querySelectorAll<HTMLElement>('.message-row')]
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.textContent)).toEqual(['First row', 'Second row'])
    expect(new Set(rows.map(row => row.dataset.messageRowId)).size).toBe(2)
  })
})
