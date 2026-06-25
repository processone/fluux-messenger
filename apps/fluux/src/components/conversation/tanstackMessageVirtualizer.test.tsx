import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'

// Mock the real @tanstack/react-virtual surface the adapter uses (jsdom has no layout):
// a fixed 40px row height exposes deterministic offsets for every index.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey: (i: number) => string }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index, key: opts.getItemKey(index), start: index * 40, end: index * 40 + 40, size: 40, lane: 0,
      })),
    getTotalSize: () => opts.count * 40,
    getOffsetForIndex: (index: number) => [index * 40, 'start'] as const,
    measureElement: () => {},
    scrollToIndex: () => {},
    scrollToOffset: () => {},
  }),
}))

function makeItems(ids: string[]): { items: { key: string }[]; indexById: Map<string, number> } {
  return { items: ids.map((id) => ({ key: id })), indexById: new Map(ids.map((id, i) => [id, i])) }
}

describe('useTanstackMessageVirtualizer', () => {
  it('exposes the window, total size, and per-id offsets (mounted or not)', () => {
    const { items, indexById } = makeItems(['a', 'b', 'c'])
    const { result } = renderHook(() => {
      const scrollRef = useRef<HTMLElement | null>(null)
      return useTanstackMessageVirtualizer({ items, indexById, scrollRef })
    })
    expect(result.current.getTotalSize()).toBe(120)
    expect(result.current.getVirtualItems().map((v) => v.key)).toEqual(['a', 'b', 'c'])
    expect(result.current.getOffsetForMessageId('c')).toBe(80)
    expect(result.current.getOffsetForMessageId('missing')).toBeNull()
  })

  it('scrollToOffset dispatches a scroll event so @tanstack re-syncs its window to scrollTop', () => {
    // @tanstack updates its reactive scrollOffset ONLY from the scroll element's 'scroll'
    // DOM event (observeElementOffset). scrollToOffset sets the DOM scrollTop but leaves
    // scrollOffset stale until that event fires. The MAM-prepend restore calls scrollToOffset
    // from a useLayoutEffect right after a count change; on engines that don't fire the native
    // scroll event promptly (Tauri WebKitGTK + the headless preview browser) the virtualizer
    // keeps the old top rows mounted while scrollTop sits at the restored offset → the viewport
    // renders BLANK. The adapter dispatches the event itself to force a re-window. This bug does
    // NOT reproduce in Playwright (chromium/webkit fire the native event), so this unit test is
    // the deterministic guard for the fix.
    const el = document.createElement('div')
    const dispatchSpy = vi.spyOn(el, 'dispatchEvent')
    const { items, indexById } = makeItems(['a', 'b'])
    const { result } = renderHook(() => {
      const scrollRef = useRef<HTMLElement | null>(el)
      return useTanstackMessageVirtualizer({ items, indexById, scrollRef })
    })

    result.current.scrollToOffset(1000)

    const scrollEvents = dispatchSpy.mock.calls.filter(([e]) => (e as Event).type === 'scroll')
    expect(
      scrollEvents.length,
      'scrollToOffset must dispatch a scroll event to keep the virtualizer window synced to scrollTop',
    ).toBeGreaterThan(0)
  })
})
