/**
 * @vitest-environment jsdom
 *
 * The width tag of the persistent row-height cache in the virtualized MessageList, with the real
 * row-metrics sampler and the real cache module. Intent: a conversation's cached heights are kept
 * when the mounted window moves between only own (hug-width) bubbles and full-width rows, and are
 * cleared only when the real content width changes.
 *
 * jsdom has no layout, so the rows mirror MessageBubble's markup (content column, chrome box, text)
 * and carry widths and heights read from the demo app in Chromium: at 1280px wide the content
 * column is 888px, the widest short own reply 142px, a four-line incoming row 70px and an own
 * continuation row 24px; at 1000px wide the column is 608px.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { BaseMessage } from '@fluux/sdk'
import { MessageList } from './MessageList'
import type { MessageVirtualizer } from './messageVirtualizer'
import { appliedWrite } from './scrollWriteTestDoubles'
import {
  __clearHeightCache,
  getCachedHeight,
  getConversationWidthBucket,
  HEIGHT_CACHE_STORAGE_KEY,
} from './messageHeightCache'
import { useSettingsStore } from '@/stores/settingsStore'

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

interface AdapterArgs {
  items: readonly { key: string }[]
  onMeasured?: (key: string, size: number) => void
  sampleEstimateMetrics?: () => void
}
let adapter: AdapterArgs
/** The mounted window: which item indices the virtualizer double renders. */
let isMounted: (index: number) => boolean = () => true

// Windowing double: the real adapter mounts nothing in jsdom. It hands MessageList's own
// measurement and sampling callbacks to the test, which plays the adapter's part.
vi.mock('./tanstackMessageVirtualizer', () => ({
  useTanstackMessageVirtualizer: (args: AdapterArgs) => {
    adapter = args
    const stub: MessageVirtualizer = {
      getVirtualItems: () => args.items.flatMap((item, index) =>
        isMounted(index) ? [{ index, start: index * 40, size: 40, key: item.key }] : []),
      getTotalSize: () => args.items.length * 40,
      itemCount: args.items.length,
      getOffsetForMessageId: () => null,
      getIndexForMessageId: () => null,
      ensureMessageMounted: async () => {},
      measureElement: () => {},
      scrollToOffset: () => appliedWrite(),
      scrollToIndex: () => appliedWrite(),
      beginAnimatedScrollToOffset: () => {},
    }
    return stub
  },
}))

const CONVERSATION = 'ava@fluux.chat'
const COLUMN_AT_1280_PX = 888
const COLUMN_AT_1000_PX = 608
const WIDEST_OWN_TEXT_PX = 142
const INCOMING_ROW_PX = 70
const OWN_ROW_PX = 24
const LONG_BODY = 'A comfortable reading column keeps a long conversation easy to follow. '.repeat(4)

/** 40 incoming long messages, then 60 short own replies: the newest window holds only own rows. */
const MESSAGES: BaseMessage[] = Array.from({ length: 100 }, (_, i) => ({
  id: `own-case-${i}`,
  stanzaId: undefined, originId: undefined,
  from: i >= 40 ? 'me@fluux.chat' : CONVERSATION,
  body: i >= 40 ? `short own reply ${i}` : LONG_BODY,
  timestamp: new Date(2026, 10, 13, 9, 0, i),
  isOutgoing: i >= 40,
  type: 'chat' as const,
}))

let columnPx = COLUMN_AT_1280_PX

function setClientWidth(node: HTMLElement | null, read: () => number): void {
  if (node) Object.defineProperty(node, 'clientWidth', { configurable: true, get: read })
}

/** MessageBubble's width-bearing structure: an own bubble hugs its text inside the full column. */
function renderMessage(message: BaseMessage) {
  return (
    <div data-msg-column="" ref={node => setClientWidth(node, () => columnPx)}>
      <div data-msg-chrome="cont" data-msg-own={message.isOutgoing ? '' : undefined}>
        <div data-msg-text="" ref={node => setClientWidth(node, () => message.isOutgoing ? WIDEST_OWN_TEXT_PX : columnPx)}>
          {message.body}
        </div>
      </div>
    </div>
  )
}

const list = () => <MessageList messages={MESSAGES} conversationId={CONVERSATION} renderMessage={renderMessage} />

function itemIndices(own: boolean): number[] {
  return adapter.items.flatMap((item, index) => {
    const message = MESSAGES.find(m => m.id === item.key)
    return message && message.isOutgoing === own ? [index] : []
  })
}

/** Mount a window the way the adapter does: the sampler reads the new rows, then their sizes arrive. */
function showWindow(view: ReturnType<typeof render>, indices: number[], heightPx: number): void {
  const visible = new Set(indices)
  isMounted = index => visible.has(index)
  view.rerender(list())
  adapter.sampleEstimateMetrics!()
  for (const index of indices) adapter.onMeasured!(adapter.items[index].key, heightPx)
}

describe('MessageList height cache width tag', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    __clearHeightCache()
    columnPx = COLUMN_AT_1280_PX
    isMounted = () => true
  })
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('keeps heights while the window moves between own-only and full-width rows, and clears them when the column narrows', () => {
    const view = render(list())
    const scale = useSettingsStore.getState().fontSize
    const incoming = itemIndices(false).slice(0, 19)
    const own = itemIndices(true).slice(-37)
    const firstIncomingKey = adapter.items[incoming[0]].key
    const lastOwnKey = adapter.items[own.at(-1)!].key

    showWindow(view, incoming, INCOMING_ROW_PX)
    expect(getConversationWidthBucket(CONVERSATION)).toBe(880)

    showWindow(view, own, OWN_ROW_PX)
    expect(getConversationWidthBucket(CONVERSATION)).toBe(880)
    expect(getCachedHeight(CONVERSATION, firstIncomingKey, scale)).toBe(INCOMING_ROW_PX)

    showWindow(view, incoming, INCOMING_ROW_PX)
    expect(getConversationWidthBucket(CONVERSATION)).toBe(880)
    expect(getCachedHeight(CONVERSATION, lastOwnKey, scale)).toBe(OWN_ROW_PX)

    // Narrowing the window: the own replies still hug the same 142px, but the column moved.
    showWindow(view, own, OWN_ROW_PX)
    columnPx = COLUMN_AT_1000_PX
    showWindow(view, own, OWN_ROW_PX)
    expect(getConversationWidthBucket(CONVERSATION)).toBe(600)
    expect(getCachedHeight(CONVERSATION, firstIncomingKey, scale)).toBeUndefined()
    expect(getCachedHeight(CONVERSATION, lastOwnKey, scale)).toBe(OWN_ROW_PX)
  })

  it('persists an own-only window under the real width bucket when the list unmounts', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(OWN_ROW_PX)
    const view = render(list())
    const scale = useSettingsStore.getState().fontSize
    const incoming = itemIndices(false).slice(0, 19)
    const own = itemIndices(true).slice(-37)
    const firstIncomingKey = adapter.items[incoming[0]].key

    showWindow(view, incoming, INCOMING_ROW_PX)
    // An own-only window that is sampled but not yet measured: only the unmount snapshot tags it.
    isMounted = index => own.includes(index)
    view.rerender(list())
    adapter.sampleEstimateMetrics!()
    view.unmount()

    const persisted = JSON.parse(localStorage.getItem(HEIGHT_CACHE_STORAGE_KEY)!)
    expect(persisted.conversations[CONVERSATION].bucket).toBe(880)
    expect(getConversationWidthBucket(CONVERSATION)).toBe(880)
    expect(getCachedHeight(CONVERSATION, firstIncomingKey, scale)).toBe(INCOMING_ROW_PX)
  })
})
