/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import type { BaseMessage } from '@fluux/sdk'
import { mountBench, type Bench } from './mountBench'
import { __clearHeightCache, getCachedHeight, getConversationWidthBucket } from '../messageHeightCache'
import { useSettingsStore } from '@/stores/settingsStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/hooks', () => ({
  useMessageCopyFormatter: vi.fn(),
  useMessageRangeSelection: vi.fn(() => ({
    copySelectedIds: new Set<string>(), selectionCount: 0, isSelecting: false,
    selectAll: vi.fn(), extendTo: vi.fn(), clearSelection: vi.fn(), copySelected: vi.fn(),
  })),
}))

let columnPx = 800
const BODY = 'A comfortable reading column keeps a long conversation easy to follow. '

const MESSAGES: BaseMessage[] = Array.from({ length: 100 }, (_, i) => ({
  id: `m-${i}`, stanzaId: undefined, originId: undefined,
  from: 'ava@fluux.chat', body: BODY, timestamp: new Date(2026, 10, 13, 9, 0, i),
  isOutgoing: false, type: 'chat' as const,
}))

function widthOf(node: HTMLElement | null) {
  if (node) Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => columnPx })
}
/** MessageBubble's width-bearing structure: the content column holds the text box, both as wide as the layout. */
function renderMessage(message: BaseMessage) {
  return (
    <div data-msg-column="" ref={widthOf}>
      <div data-msg-chrome="cont">
        <div data-msg-text="" ref={widthOf}>{message.body}</div>
      </div>
    </div>
  )
}

let bench: Bench
beforeEach(() => { localStorage.clear(); localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true'); __clearHeightCache() })
afterEach(() => { bench?.unmount(); bench?.scroller.uninstall() })

/** The adapter samples the row metrics in a microtask after a measurement batch. */
const sampled = () => act(async () => { await Promise.resolve() })

it('E1 narrowing the window clears the heights measured at the old width and keeps the rows measured at the new one (bf88a67c)', async () => {
  const conversationId = 'estimates-e1'
  bench = mountBench({ messages: MESSAGES, renderMessage, conversationId })
  bench.scroller.settle()
  await sampled()
  const scale = useSettingsStore.getState().fontSize
  const atLiveEdge = bench.mountedIds()
  expect(getConversationWidthBucket(conversationId)).toBe(800)
  expect(getCachedHeight(conversationId, atLiveEdge[0], scale)).toBeDefined()

  // Read further up: the rows at the live edge leave the window.
  bench.scroller.readerScrollTo(1000)
  bench.scroller.settle()
  await sampled()
  const unmounted = atLiveEdge.filter(id => !bench.mountedIds().includes(id))
  expect(unmounted.length).toBeGreaterThan(0)

  columnPx = 600
  bench.scroller.setWidth(600)
  const resized = bench.mountedIds()
  for (const id of resized) bench.scroller.setRowHeight(id, 140)
  bench.scroller.settle()
  await sampled()

  expect(getConversationWidthBucket(conversationId)).toBe(600)
  expect(getCachedHeight(conversationId, unmounted[0], scale)).toBeUndefined()
  const kept = resized.filter(id => bench.mountedIds().includes(id))
  expect(kept.length).toBeGreaterThan(0)
  for (const id of kept) expect(getCachedHeight(conversationId, id, scale)).toBe(140)
})
