// @vitest-environment jsdom
/**
 * Regression guard for the NON-VIRTUALIZED render path.
 *
 * The search result preview (SearchContextView) and StrangerRequestPreviewView
 * mount one MessageList per result with `staticMode`, and depend on every message
 * rendering directly into the DOM — there is no virtualizer window and no
 * virtualizer cache to leak between results.
 *
 * That contract lives in a single line of MessageList:
 *   const virtualized = isFeatureEnabled('enableMessageVirtualization') && !staticMode
 *
 * If the non-virtualized path is ever removed (e.g. making virtualization
 * unconditional and dropping the `&& !staticMode` guard), these previews break
 * silently. To make that failure loud, this test enables the virtualization flag
 * and deliberately does NOT mock @tanstack/react-virtual: with the guard intact,
 * staticMode forces the static map and every row renders; if the guard is removed,
 * the real virtualizer runs with no layout under jsdom and windows down to ~nothing,
 * so the "all rows present" assertion fails.
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

describe('MessageList staticMode — non-virtualized render path (search/preview contract)', () => {
  beforeEach(() => scrollStateManager.reset())
  afterEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  const COUNT = 100
  const messages = createTestMessages(COUNT)
  const renderMessage = (m: { id: string }) => <div>{m.id}</div>

  it('renders every message even with the virtualization flag ON', () => {
    // Flag ON: without the `!staticMode` guard the real virtualizer would take over
    // and window the list down (to ~nothing under jsdom, which has no layout).
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')

    const { container } = render(
      <MessageList
        messages={messages}
        conversationId="static-conv"
        renderMessage={renderMessage}
        staticMode
      />,
    )

    const rows = container.querySelectorAll('[data-message-id]')
    expect(rows).toHaveLength(COUNT)
    // Spot-check first, middle, and last so a partial window can't pass by count alone.
    expect(container.querySelector('[data-message-id="msg-0"]')).not.toBeNull()
    expect(container.querySelector('[data-message-id="msg-50"]')).not.toBeNull()
    expect(container.querySelector(`[data-message-id="msg-${COUNT - 1}"]`)).not.toBeNull()
  })

  it('renders every message with the virtualization flag explicitly OFF', () => {
    // The flag defaults to ON in production, so the preview relies on staticMode to
    // force the static path. This covers the other branch: staticMode must also win
    // when virtualization is explicitly disabled.
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'false')

    const { container } = render(
      <MessageList
        messages={messages}
        conversationId="static-conv"
        renderMessage={renderMessage}
        staticMode
      />,
    )

    expect(container.querySelectorAll('[data-message-id]')).toHaveLength(COUNT)
  })
})
