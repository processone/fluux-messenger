/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { mountBench, makeMessages, type Bench } from './mountBench'

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

// A mouse: the interaction hold only starts on a device that hovers.
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('hover: hover'), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
})

let bench: Bench
afterEach(() => { bench?.unmount(); bench?.scroller.uninstall() })

/** A row with the hover toolbar the interaction hold looks for. */
const renderMessage = (message: { body: string }) => (
  <div data-message-body="">{message.body}<span data-message-toolbar="" /></div>
)

function enterAtBottom(): Bench {
  bench = mountBench({ messages: makeMessages(60), renderMessage })
  bench.scroller.settle()
  bench.scroller.frames(10)
  return bench
}

function hover(id: string) {
  const row = bench.element().querySelector<HTMLElement>(`[data-message-row-id="${id}"]`)!
  fireEvent.mouseMove(row, { clientX: 20, clientY: 20, movementX: 1 })
  bench.scroller.frames(3)
}

it('H1 the last message keeps its bottom in view when its reactions grow it under the pointer (47861d04)', () => {
  enterAtBottom()
  const s = bench.scroller
  expect(bench.distanceFromEnd()).toBeLessThan(1)
  const last = bench.mountedIds().at(-1)!
  hover(last)
  s.setRowHeight(last, s.rowHeight(last) + 60)
  s.frames(10)
  expect(bench.distanceFromEnd()).toBeLessThan(2)
})

it('H2 resting on the jump-to-latest button keeps the hold of the row it appeared under (fd9af96b)', () => {
  enterAtBottom()
  const s = bench.scroller
  const last = bench.mountedIds().at(-1)!
  const row = bench.element().querySelector<HTMLElement>(`[data-message-row-id="${last}"]`)!
  hover(last)
  bench.update({ messages: makeMessages(61) })
  s.frames(10)
  expect(bench.distanceFromEnd(), 'held: the arrival does not pull the list').toBeGreaterThan(5)

  const fab = bench.element().parentElement!.querySelector<HTMLElement>('[data-interaction-bridge]')!
  fireEvent.mouseOut(row, { relatedTarget: fab })
  fireEvent.mouseMove(fab, { clientX: 400, clientY: 500, movementX: 1 })
  s.frames(20)
  bench.update({ messages: makeMessages(62) })
  s.frames(10)
  expect(bench.distanceFromEnd(), 'still held: the pointer is on the button the hold revealed').toBeGreaterThan(5)
})
