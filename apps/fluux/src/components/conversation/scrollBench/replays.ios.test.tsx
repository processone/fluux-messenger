/**
 * @vitest-environment jsdom
 */
import { afterEach, expect, it, vi } from 'vitest'
import { mountBench, type Bench } from './mountBench'

vi.hoisted(() => {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  })
  Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { supports: () => true } })
})
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

function entered(): Bench {
  bench = mountBench()
  bench.scroller.settle()
  return bench
}

it('I1 growth held while a finger is down lands when the finger lifts (c9f83f79)', () => {
  entered()
  const s = bench.scroller
  s.touch.start()
  s.touch.drag(-1500)
  s.frames(12)
  const ids = bench.mountedIds()
  const anchor = ids[Math.floor(ids.length / 2)]
  const seen = bench.viewportTop(anchor)!
  const heldAt = s.scrollTop
  s.setRowHeight(ids[1], 300)
  s.frames(3)
  expect(s.scrollTop, 'the library holds the correction under the finger').toBe(heldAt)
  s.touch.end()
  s.frames(16)
  expect(s.scrollTop, 'the held growth is written once the gesture tail closes').toBeGreaterThan(heldAt)
  expect(bench.viewportTop(anchor)).toBeCloseTo(seen, 0)
})

it('I2 a reader pulling past the end is never written back to the edge (7013f13a)', () => {
  entered()
  const s = bench.scroller
  const written = s.writes.length
  s.touch.start()
  s.touch.drag(30)
  s.touch.drag(16)
  const stretched = s.scrollTop
  expect(stretched).toBe(s.maxScrollTop + 46)
  s.frames(12)
  expect(s.writes.length, 'no programmatic write while the pull is held').toBe(written)
  expect(s.scrollTop).toBe(stretched)
})

it('I3 a finger that takes over a list still entering does not strand the growth it held (c9f83f79)', () => {
  bench = mountBench()
  const s = bench.scroller
  s.frames(2)
  s.touch.start()
  s.touch.drag(-1200)
  s.frames(12)
  const ids = bench.mountedIds()
  const anchor = ids[Math.floor(ids.length / 2)]
  const seen = bench.viewportTop(anchor)!
  const heldAt = s.scrollTop
  s.setRowHeight(ids[1], 300)
  s.frames(3)
  s.touch.end()
  s.frames(16)
  expect(s.scrollTop, 'the held growth is written once the gesture tail closes').toBeGreaterThan(heldAt)
  expect(bench.viewportTop(anchor)).toBeCloseTo(seen, 0)
})
