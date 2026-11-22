/**
 * @vitest-environment jsdom
 */
import { afterEach, expect, it, vi } from 'vitest'
import { makeMessages, mountBench, type Bench } from './mountBench'

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

it('L2 several rows above a reader near the end grow in one frame before the spacer does (84ec5d10)', () => {
  bench = mountBench()
  bench.scroller.settle()
  const s = bench.scroller
  s.readerScrollTo(s.maxScrollTop - 150)
  s.settle()
  const anchor = bench.firstVisible()
  const seen = bench.viewportTop(anchor)!
  for (const id of bench.rowsAbove(6)) s.setRowHeight(id, 180)
  s.settle()
  expect(bench.viewportTop(anchor)).toBeCloseTo(seen, 0)
})

it('C1 a message arriving under a finger waits for the finger before re-pinning to the end (fa2a5d26)', () => {
  bench = mountBench()
  bench.scroller.settle()
  const s = bench.scroller
  s.touch.start()
  s.frames(2)
  const written = s.writes.length
  bench.update({ messages: makeMessages(61) })
  s.frames(12)
  expect(s.writes.length, 'no re-pin while the finger is down').toBe(written)
  expect(bench.distanceFromEnd()).toBeGreaterThan(50)
  s.touch.end()
  s.frames(12)
  expect(bench.distanceFromEnd(), 'the held re-pin is replayed once the finger lifts').toBeLessThan(1)
})

it('C2 a viewport that shrinks under a reader at the end keeps them at the end, composer growth (5d2a5b1c)', () => {
  bench = mountBench()
  bench.scroller.settle()
  const s = bench.scroller
  s.setViewportHeight(450)
  s.frame()
  expect(bench.distanceFromEnd(), 'back at the end in the frame the viewport shrank, before paint').toBeLessThan(1)
  // The composer keeps growing: the next shrink arrives before the list has settled.
  s.setViewportHeight(426)
  s.frame()
  expect(bench.distanceFromEnd(), 'and again for the second shrink').toBeLessThan(1)
  s.setViewportHeight(402)
  s.frame()
  expect(bench.distanceFromEnd(), 'and for a third').toBeLessThan(1)
  s.settle()
  expect(bench.distanceFromEnd()).toBeLessThan(1)
})

it('L3 rows above a reader scrolling back up shrink in one frame and the reader stays where they are (b890b18b)', () => {
  bench = mountBench()
  bench.scroller.settle()
  const s = bench.scroller
  s.readerScrollTo(s.maxScrollTop - 1500)
  s.settle()
  s.readerScrollTo(s.scrollTop - 500)
  s.frame()
  const anchor = bench.firstVisible()
  const seen = bench.viewportTop(anchor)!
  for (const id of bench.rowsAbove(5)) s.setRowHeight(id, 40)
  s.settle()
  expect(bench.viewportTop(anchor)).toBeCloseTo(seen, 0)
})

it('C3 a finger lift that never arrives does not hold the end back for good (fa2a5d26)', () => {
  bench = mountBench()
  bench.scroller.settle()
  const s = bench.scroller
  s.touch.start()
  s.frames(2)
  bench.update({ messages: makeMessages(61) })
  s.frames(12)
  expect(bench.distanceFromEnd(), 'held while the finger is down').toBeGreaterThan(50)
  // iOS can drop touchend when the touched row is virtualised away: only time passes.
  s.frames(120)
  bench.update({ messages: makeMessages(62) })
  s.frames(12)
  expect(bench.distanceFromEnd(), 'the next message follows the end again').toBeLessThan(1)
})
