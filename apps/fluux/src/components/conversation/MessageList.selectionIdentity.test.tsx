/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { BaseMessage } from '@fluux/sdk'
import { MessageList } from './MessageList'
import { messageRowId } from './messageRowIdentity'

// Source: the accepted getMessageId stabilization. Observe the hook boundary
// while retaining the real selection hook, DOM events and row identifiers.
// Selection is shared by both rendering paths; avoid jsdom's zero-height virtual viewport.
vi.mock('@/utils/featureFlags', () => ({ isFeatureEnabled: () => false }))
const observeGetter = vi.fn()
vi.mock('@/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks')>()
  return {
    ...actual,
    useMessageRangeSelection: (options: Parameters<typeof actual.useMessageRangeSelection>[0]) => {
      observeGetter(options.getMessageId)
      return actual.useMessageRangeSelection(options)
    },
  }
})
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

afterEach(() => { vi.restoreAllMocks(); observeGetter.mockClear() })

describe('MessageList selection identity', () => {
  it('retains its row getter across renders and selects archive-distinct rows sharing a client ID', () => {
    const first: BaseMessage = {
      type: 'chat', id: 'reused', stanzaId: 'archive-one', originId: undefined,
      from: 'peer@example.com', body: 'First archived message',
      timestamp: new Date('2024-01-15T10:00:00Z'), isOutgoing: false,
    }
    const second = { ...first, stanzaId: 'archive-two', body: 'Second archived message', timestamp: new Date('2024-01-15T10:01:00Z') }
    const messages = [first, second]
    const renderMessage = (message: BaseMessage) => <span>{message.body}</span>
    const view = () => <div className="focus-zone" tabIndex={0} data-testid="focus-zone">
      <MessageList messages={messages} conversationId="peer@example.com" renderMessage={renderMessage} />
    </div>
    const { container, rerender } = render(view())
    const getter = observeGetter.mock.calls.at(-1)![0] as (message: BaseMessage) => string
    expect(messages.map(getter)).toEqual(messages.map(messageRowId))
    expect(new Set(messages.map(getter)).size).toBe(messages.length)
    for (let flip = 0; flip < 10; flip++) {
      rerender(view())
      expect(observeGetter.mock.calls.at(-1)![0]).toBe(getter)
    }
    screen.getByTestId('focus-zone').focus()
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true })
    expect([...container.querySelectorAll<HTMLElement>('.copy-selected')].map(row => row.dataset.messageRowId))
      .toEqual(messages.map(messageRowId))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelectorAll('.copy-selected')).toHaveLength(0)
  })
})
