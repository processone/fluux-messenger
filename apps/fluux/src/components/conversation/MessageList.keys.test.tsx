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
import type { BaseMessage } from '@fluux/sdk'
import { scrollStateManager } from '@/utils/scrollStateManager'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@/hooks', () => ({
  useMessageCopyFormatter: vi.fn(),
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
})
