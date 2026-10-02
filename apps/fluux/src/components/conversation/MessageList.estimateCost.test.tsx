/**
 * @vitest-environment jsdom
 *
 * Row-height estimation cost of the virtualized MessageList with the real adapter and the real
 * @tanstack virtualizer. Every unmeasured resident row is estimated whenever the virtualizer
 * re-derives its measurements; re-renders that change nothing must not re-derive them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { BaseMessage } from '@fluux/sdk'
import { MessageList } from './MessageList'
import { estimateRowHeight } from './rowHeightEstimator'

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
vi.mock('./rowHeightEstimator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rowHeightEstimator')>()
  return { ...actual, estimateRowHeight: vi.fn(actual.estimateRowHeight) }
})

const ROWS = 100
const LOG_LINE = '2026-10-02 10:31:45.123 [info] <0.1234.0>@mod_mam:process_iq/3:412 archive query done\n'
const LONG_BODY = LOG_LINE.repeat(Math.ceil(20_000 / LOG_LINE.length))

function makeMessages(): BaseMessage[] {
  return Array.from({ length: ROWS }, (_, i) => ({
    id: `msg-${i}`,
    stanzaId: undefined, originId: undefined,
    from: 'peer@example.com',
    body: `${i} ${LONG_BODY}`,
    timestamp: new Date(2024, 0, 1, 12, i),
    isOutgoing: false,
    type: 'chat' as const,
  }))
}

describe('MessageList row-height estimation cost', () => {
  beforeEach(() => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    vi.mocked(estimateRowHeight).mockClear()
  })
  afterEach(() => localStorage.clear())

  it('estimates each row at most twice on mount and not again on a re-render that changes nothing', () => {
    const messages = makeMessages()
    const renderMessage = (msg: BaseMessage) => <div>{msg.body.slice(0, 20)}</div>
    const { rerender } = render(
      <MessageList messages={messages} conversationId="peer@example.com" renderMessage={renderMessage} />,
    )
    const rows = ROWS + 1 // one date separator
    expect(vi.mocked(estimateRowHeight).mock.calls.length).toBeLessThanOrEqual(2 * rows)

    vi.mocked(estimateRowHeight).mockClear()
    for (let i = 0; i < 3; i++) {
      rerender(<MessageList messages={messages} conversationId="peer@example.com" renderMessage={renderMessage} />)
    }
    expect(vi.mocked(estimateRowHeight).mock.calls.length).toBeLessThanOrEqual(rows)
  })
})
