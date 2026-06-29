// @vitest-environment jsdom
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

describe('MessageList floating date header wiring', () => {
  beforeEach(() => scrollStateManager.reset())
  afterEach(() => vi.clearAllMocks())

  const messages = createTestMessages(5)
  const renderMessage = (m: { id: string }) => <div>{m.id}</div>

  it('renders the floating date overlay on the virtualized path', () => {
    const { container } = render(
      <MessageList messages={messages} conversationId="c1" renderMessage={renderMessage} />,
    )
    expect(container.querySelector('[data-floating-date]')).not.toBeNull()
  })

  it('does not render the overlay in staticMode', () => {
    const { container } = render(
      <MessageList messages={messages} conversationId="c2" renderMessage={renderMessage} staticMode />,
    )
    expect(container.querySelector('[data-floating-date]')).toBeNull()
  })
})
