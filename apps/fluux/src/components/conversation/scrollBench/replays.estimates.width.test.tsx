/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import type { BaseMessage } from '@fluux/sdk'
import { mountBench, type Bench } from './mountBench'

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
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (text: string) => ({ width: text.length * 7 }) } as unknown as CanvasRenderingContext2D)
})
afterEach(() => { bench?.unmount(); bench?.scroller.uninstall() })

const sampled = () => act(async () => { await Promise.resolve() })

async function enterAt(px: number, conversationId: string): Promise<Bench> {
  columnPx = px
  const entered = mountBench({ messages: MESSAGES, renderMessage, conversationId })
  entered.scroller.setWidth(px)
  entered.scroller.settle()
  await sampled()
  entered.scroller.settle()
  return entered
}

it('E2 sizes the rows out of the window for the width the window has now (8ca81140)', async () => {
  // What a list that was opened at the narrow width sizes the hidden rows at.
  const narrow = await enterAt(400, 'estimates-e2-narrow')
  const narrowTotal = narrow.scroller.scrollHeight
  narrow.unmount(); narrow.scroller.uninstall()

  bench = await enterAt(800, 'estimates-e2')
  const wideTotal = bench.scroller.scrollHeight
  expect(wideTotal).toBeLessThan(narrowTotal)

  columnPx = 400
  bench.scroller.setWidth(400)
  bench.scroller.settle()
  await sampled()
  bench.scroller.settle()
  expect(bench.scroller.scrollHeight).toBe(narrowTotal)
})
