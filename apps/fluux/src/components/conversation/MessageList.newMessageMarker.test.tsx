/**
 * MessageList → NewMessageMarker plumbing.
 *
 * Guards the divider contract end to end at the component level:
 * - the divider renders exactly once, inside the row of firstNewMessageId;
 * - `firstNewMessageIsProvisional` reaches the marker (muted "tentative"
 *   rendering while a synced XEP-0490 read position is unresolved);
 * - omitted flag renders the definitive (accent) divider.
 *
 * Uses staticMode so every row mounts under jsdom (no virtualizer window).
 */
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

  function renderList(props: { firstNewMessageId?: string; firstNewMessageIsProvisional?: boolean }) {
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

  it('renders the divider exactly once, inside the firstNewMessageId row', () => {
    const { container } = renderList({ firstNewMessageId: 'msg-5' })
    const markers = container.querySelectorAll('[data-new-message-marker]')
    expect(markers).toHaveLength(1)
    expect(container.querySelector('[data-message-id="msg-5"] [data-new-message-marker]')).not.toBeNull()
  })

  it('renders no divider without firstNewMessageId', () => {
    const { container } = renderList({})
    expect(container.querySelectorAll('[data-new-message-marker]')).toHaveLength(0)
  })

  it('passes the provisional flag through to the marker (muted rendering)', () => {
    const { container } = renderList({ firstNewMessageId: 'msg-5', firstNewMessageIsProvisional: true })
    const marker = container.querySelector('[data-new-message-marker]') as HTMLElement
    expect(marker.dataset.provisional).toBe('true')
    expect(marker.querySelector('span')?.style.color).toBe('var(--fluux-text-muted)')
  })

  it('renders the definitive (accent) divider when the flag is omitted', () => {
    const { container } = renderList({ firstNewMessageId: 'msg-5' })
    const marker = container.querySelector('[data-new-message-marker]') as HTMLElement
    expect(marker.dataset.provisional).toBeUndefined()
    expect(marker.querySelector('span')?.style.color).toBe('var(--fluux-text-self)')
  })
})
