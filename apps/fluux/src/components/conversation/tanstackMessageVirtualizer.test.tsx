import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'

// @tanstack's internal offset callback (the one it hands to `observeElementOffset` on mount). The
// adapter stashes it so a programmatic scrollToOffset can re-window through it directly.
const offsetNotifySpy = vi.fn<(offset: number, isScrolling: boolean) => void>()
const scrollToOffsetSpy = vi.fn()

// Mock the real @tanstack/react-virtual surface the adapter uses (jsdom has no layout):
// a fixed 40px row height exposes deterministic offsets for every index. The mock also invokes
// `observeElementOffset(instance, internalCb)` exactly as the real adapter does on mount, so the
// adapter's cb-stashing path runs and `offsetNotifySpy` becomes the captured callback.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: {
    count: number
    getItemKey: (i: number) => string
    getScrollElement: () => HTMLElement | null
    observeElementOffset?: (
      instance: { scrollElement: HTMLElement | null },
      cb: (offset: number, isScrolling: boolean) => void,
    ) => void | (() => void)
  }) => {
    opts.observeElementOffset?.({ scrollElement: opts.getScrollElement() }, offsetNotifySpy)
    return {
      getVirtualItems: () =>
        Array.from({ length: opts.count }, (_, index) => ({
          index, key: opts.getItemKey(index), start: index * 40, end: index * 40 + 40, size: 40, lane: 0,
        })),
      getTotalSize: () => opts.count * 40,
      getOffsetForIndex: (index: number) => [index * 40, 'start'] as const,
      measureElement: () => {},
      scrollToIndex: () => {},
      scrollToOffset: scrollToOffsetSpy,
    }
  },
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

  it('scrollToOffset re-windows via @tanstack\'s offset callback with isScrolling=false (no synthetic scroll)', () => {
    // @tanstack updates its reactive scrollOffset ONLY from the scroll element's 'scroll' DOM event
    // (observeElementOffset). scrollToOffset sets the DOM scrollTop but leaves scrollOffset stale
    // until that event fires. The MAM-prepend restore calls scrollToOffset from a useLayoutEffect
    // right after a count change; on engines that don't fire the native scroll event promptly (Tauri
    // WebKitGTK + the headless preview browser) the virtualizer keeps the old top rows mounted while
    // scrollTop sits at the restored offset → the viewport renders BLANK.
    //
    // The adapter MUST force a re-window — but NOT by dispatching a synthetic 'scroll' event. That
    // event routes through our observer's onScroll with isScrolling=true, and react-virtual's
    // onChange does flushSync(rerender) whenever sync===true. Inside the layout-effect commit that
    // throws "flushSync was called from inside a lifecycle method" and triggers a render-loop storm.
    // Instead it pushes the offset straight into @tanstack's offset callback with isScrolling=false,
    // a non-sync notify (plain rerender, legal mid-commit). This bug does NOT reproduce in Playwright
    // (chromium/webkit fire the native event), so this unit test is the deterministic guard.
    offsetNotifySpy.mockClear()
    scrollToOffsetSpy.mockClear()
    const el = document.createElement('div')
    const dispatchSpy = vi.spyOn(el, 'dispatchEvent')
    const { items, indexById } = makeItems(['a', 'b'])
    const { result } = renderHook(() => {
      const scrollRef = useRef<HTMLElement | null>(el)
      return useTanstackMessageVirtualizer({ items, indexById, scrollRef })
    })

    result.current.scrollToOffset(1000)

    // 1. @tanstack's own scrollToOffset still sets the DOM scrollTop.
    expect(scrollToOffsetSpy).toHaveBeenCalledWith(1000, undefined)
    // 2. The window is re-synced through the offset callback with isScrolling=false (non-sync).
    expect(
      offsetNotifySpy,
      'scrollToOffset must re-window via the offset callback with isScrolling=false',
    ).toHaveBeenCalledWith(1000, false)
    // 3. It must NOT dispatch a synthetic scroll event (that path → flushSync-in-commit → render loop).
    const scrollEvents = dispatchSpy.mock.calls.filter(([e]) => (e as Event).type === 'scroll')
    expect(
      scrollEvents.length,
      'scrollToOffset must NOT dispatch a synthetic scroll event (flushSync-in-commit risk)',
    ).toBe(0)
  })
})
