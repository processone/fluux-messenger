// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { FlatMessageList as MessageList } from './MessageList.flat-test-utils'
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

function Bubble({ id }: { id: string }) {
  if (id === 'msg-2') throw new Error('malformed message')
  return <p>{id}</p>
}

describe('MessageList row isolation', () => {
  beforeEach(() => {
    scrollStateManager.reset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('replaces a row that fails to render and keeps its neighbours', () => {
    const { container, getByText } = render(
      <MessageList
        messages={createTestMessages(5)}
        conversationId="row-error-conv"
        renderMessage={(m) => <Bubble id={m.id} />}
        staticMode
      />,
    )

    expect(getByText('msg-1')).toBeInTheDocument()
    expect(getByText('msg-3')).toBeInTheDocument()
    const broken = container.querySelector('[data-message-id="msg-2"]')
    expect(broken?.querySelector('[data-testid="message-render-error"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="message-render-error"]')).toHaveLength(1)
  })
})
