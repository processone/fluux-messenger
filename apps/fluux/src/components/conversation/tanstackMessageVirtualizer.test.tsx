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
})
