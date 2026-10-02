/**
 * @vitest-environment jsdom
 *
 * Row-metrics calibration through the real MessageList and useRowMetrics. The adapter stub
 * reproduces the two facts the calibration loop depends on: a measured text row queues a metrics
 * sample, and a refresh re-windows the list, which changes the first mounted row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { BaseMessage } from '@fluux/sdk'
import { MessageList } from './MessageList'
import type { MessageVirtualizer } from './messageVirtualizer'

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

const adapter = vi.hoisted(() => ({
  refreshes: [] as boolean[],
  /** Refreshes after which the stub stops re-windowing, so an unbounded loop ends the test. */
  maxRewindows: 40,
}))

vi.mock('./tanstackMessageVirtualizer', async () => {
  const React = await import('react')
  const { flushSync } = await import('react-dom')
  return {
    useTanstackMessageVirtualizer: (args: {
      items: readonly { key: string; kind: string; message?: BaseMessage }[]
      sampleEstimateMetrics?: () => void
    }): MessageVirtualizer => {
      const [, rerender] = React.useReducer((x: number) => x + 1, 0)
      const samplePending = React.useRef(false)
      const items = args.items
      // Re-windowing alternates the first mounted message between a reply row and a plain row.
      const firstIndex = (id: string) => items.findIndex(item => item.message?.id === id)
      const rewindows = Math.min(adapter.refreshes.length, adapter.maxRewindows)
      const start = Math.max(0, firstIndex(rewindows % 2 === 0 ? 'msg-3' : 'msg-4'))
      const window = items.slice(start, start + 10).map((item, offset) => ({
        index: start + offset, start: (start + offset) * 80, size: 80, key: item.key,
      }))
      return {
        refreshEstimates: sync => {
          adapter.refreshes.push(sync)
          if (sync) flushSync(rerender)
          else rerender()
        },
        getVirtualItems: () => window,
        getTotalSize: () => items.length * 80,
        itemCount: items.length,
        getOffsetForMessageId: () => null,
        getIndexForMessageId: () => null,
        ensureMessageMounted: async () => {},
        measureElement: (node: Element | null) => {
          if (!node?.querySelector('[data-msg-text]') || samplePending.current) return
          samplePending.current = true
          queueMicrotask(() => {
            samplePending.current = false
            args.sampleEstimateMetrics?.()
          })
        },
        scrollToOffset: () => {},
        scrollToIndex: () => {},
        beginAnimatedScrollToOffset: () => {},
      }
    },
  }
})

type ReplyMessage = BaseMessage & { replyTo?: { id: string } }

function makeMessages(count: number): ReplyMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'chat' as const,
    id: `msg-${i}`,
    stanzaId: undefined, originId: undefined,
    from: 'peer@example.com',
    body: `Body ${i}`,
    timestamp: new Date(2024, 0, 1, 12, i * 10),
    isOutgoing: false,
    ...(i % 4 === 3 ? { replyTo: { id: `msg-${i - 1}` } } : {}),
  }))
}

/** MessageBubble's header-row shape: sender header, optional reply quote card, then the body. */
function renderRow(message: ReplyMessage) {
  return (
    <div data-msg-chrome="header">
      <div data-msg-sender>{message.from}</div>
      {message.replyTo && <button type="button" className="reply-quote-card">quoted</button>}
      <div><div data-msg-text>{message.body}</div></div>
    </div>
  )
}

beforeEach(() => {
  adapter.refreshes = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-msg-text') ? 600 : 0
  })
  // A plain header row has 30px of chrome around one 22px line; the reply quote card adds 54px.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-msg-text')) return new DOMRect(0, 0, 600, 22)
    if (this.hasAttribute('data-msg-chrome')) {
      return new DOMRect(0, 0, 600, this.querySelector('.reply-quote-card') ? 106 : 52)
    }
    return new DOMRect(0, 0, 0, 0)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MessageList row-metrics calibration', () => {
  it('calibrates a conversation with reply rows a bounded number of times', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = render(
      <MessageList messages={makeMessages(40)} conversationId="peer@example.com"
        renderMessage={message => renderRow(message)} />,
    )
    await act(async () => {
      for (let i = 0; i < 200; i += 1) await Promise.resolve()
    })

    expect(adapter.refreshes.length).toBeGreaterThan(0)
    expect(adapter.refreshes.length).toBeLessThanOrEqual(2)
    // Only the first calibration commits synchronously; a later one joins the next render.
    expect(adapter.refreshes).toEqual([true, ...adapter.refreshes.slice(1).map(() => false)])
    expect(errors.mock.calls.flat().join('\n')).not.toContain('Maximum update depth exceeded')
    view.unmount()
  })
})
