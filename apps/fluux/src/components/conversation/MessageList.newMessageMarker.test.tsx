/**
 * MessageList → NewMessageMarker plumbing.
 *
 * Guards the divider contract end to end at the component level:
 * - the divider renders exactly once, inside the row of firstNewMessageRow;
 * - `firstNewMessageIsProvisional` reaches the marker (muted "tentative"
 *   rendering while a synced XEP-0490 read position is unresolved);
 * - omitted flag renders the definitive (accent) divider.
 *
 * Uses staticMode so every row mounts under jsdom (no virtualizer window).
 */
import type { BaseMessage, MessageRowRef } from '@fluux/sdk'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { MessageList } from './MessageList'
import { createTestMessages } from './MessageList.test-utils'
import { scrollStateManager } from '@/utils/scrollStateManager'

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

describe('MessageList — new-message divider plumbing', () => {
  beforeEach(() => scrollStateManager.reset())
  afterEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  const messages = createTestMessages(10)
  const renderMessage = (m: { id: string }) => <div>{m.id}</div>

  function renderList(props: { firstNewMessageRow?: MessageRowRef; firstNewMessageIsProvisional?: boolean; unreadCount?: number }) {
    return render(
      <MessageList
        messages={messages}
        conversationId="marker-conv"
        renderMessage={renderMessage}
        staticMode
        {...props}
      />,
    )
  }

  it('renders the divider exactly once, inside the firstNewMessageRow row', () => {
    const { container } = renderList({ firstNewMessageRow: { id: 'msg-5' }, unreadCount: 3 })
    const markers = container.querySelectorAll('[data-new-message-marker]')
    expect(markers).toHaveLength(1)
    expect(container.querySelector('[data-message-id="msg-5"] [data-new-message-marker]')).not.toBeNull()
  })

  it('renders no divider without firstNewMessageRow', () => {
    const { container } = renderList({ unreadCount: 3 })
    expect(container.querySelectorAll('[data-new-message-marker]')).toHaveLength(0)
  })

  // The divider's PRESENCE stays governed solely by firstNewMessageRow
  // (unchanged) — unreadCount only supplies its label. firstNewMessageMarkers and unreadCount can
  // be transiently out of step (reactivation's synchronous marker vs. an async archive recount),
  // so the divider must still render — with the generic label, not a misleading "0 new messages"
  // — while the count catches up, rather than flickering away. (This is a real, evidenced
  // constraint, not a hypothetical: gating existence on the count broke `npm run test:scroll`'s
  // marker-on-reentry invariants during development.)
  it('still renders the divider (generic label) when the canonical count is momentarily 0', () => {
    const { container } = renderList({ firstNewMessageRow: { id: 'msg-5' }, unreadCount: 0 })
    const marker = container.querySelector('[data-new-message-marker]')
    expect(marker).not.toBeNull()
  })

  it('passes the provisional flag through to the marker (muted rendering)', () => {
    const { container } = renderList({ firstNewMessageRow: { id: 'msg-5' }, firstNewMessageIsProvisional: true, unreadCount: 3 })
    const marker = container.querySelector('[data-new-message-marker]') as HTMLElement
    expect(marker.dataset.provisional).toBe('true')
    expect(marker.querySelector('span')?.style.color).toBe('var(--fluux-text-muted)')
  })

  it('renders the definitive (accent) divider when the flag is omitted', () => {
    const { container } = renderList({ firstNewMessageRow: { id: 'msg-5' }, unreadCount: 3 })
    const marker = container.querySelector('[data-new-message-marker]') as HTMLElement
    expect(marker.dataset.provisional).toBeUndefined()
    expect(marker.querySelector('span')?.style.color).toBe('var(--fluux-text-self)')
  })
  // ==========================================================================
  // Occupant collision
  // ==========================================================================

  // A reused MUC nick puts two rendered rows under one client id. The SDK names
  // the divider's ROW, so the line is drawn above the occupant it means — not
  // above whichever copy comes first in the resident array.
  it('draws the divider above the named OCCUPANT of two same-id rows', () => {
    const nick = 'room@conference.example.com/alice'
    const collided = [
      { id: 'shared', from: nick, occupantId: 'occupant-a', body: 'first alice',
        timestamp: new Date('2024-03-01T10:00:00Z'), isOutgoing: false, type: 'groupchat' as const },
      { id: 'shared', from: nick, occupantId: 'occupant-b', body: 'second alice',
        timestamp: new Date('2024-03-01T10:05:00Z'), isOutgoing: false, type: 'groupchat' as const },
    ] as unknown as BaseMessage[]

    const { container } = render(
      <MessageList
        messages={collided}
        conversationId="collision-conv"
        renderMessage={(m: { id: string; body?: string }) => <div>{m.body}</div>}
        staticMode
        firstNewMessageRow={{ id: 'shared', occupantId: 'occupant-b' }}
        unreadCount={1}
      />,
    )

    const markers = container.querySelectorAll('[data-new-message-marker]')
    expect(markers).toHaveLength(1)
    const markedRow = markers[0].closest('[data-message-row-id]') as HTMLElement
    expect(markedRow.dataset.messageRowId).toBe('occupant-row:["shared","occupant-b"]')
    expect(markedRow.textContent).toContain('second alice')
  })
})
