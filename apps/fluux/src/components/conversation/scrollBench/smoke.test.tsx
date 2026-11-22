/**
 * @vitest-environment jsdom
 */
import { afterEach, expect, it, vi } from 'vitest'
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

let bench: Bench
afterEach(() => { bench?.unmount(); bench?.scroller.uninstall() })

it('smoke: enters at the live edge', () => {
  bench = mountBench()
  bench.scroller.settle()
  expect(bench.distanceFromEnd()).toBeLessThan(2)
})
