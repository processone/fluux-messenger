import { useMemo, useState, useEffect } from 'react'

interface WindowedListOptions {
  initial?: number
  step?: number
  /** Changing this (e.g. the search query or vhost) resets the window. */
  resetKey?: string
}

/**
 * Render a large in-memory list incrementally so the DOM stays bounded.
 * Returns a growing slice plus a loadMore() to advance it. The window resets
 * to `initial` whenever `resetKey` or the list length changes.
 */
export function useWindowedList<T>(items: T[], opts: WindowedListOptions = {}) {
  const initial = opts.initial ?? 50
  const step = opts.step ?? 50
  const [count, setCount] = useState(initial)

  // Reset when the filter key or the underlying list size changes.
  useEffect(() => {
    setCount(initial)
  }, [opts.resetKey, items.length, initial])

  const visible = useMemo(() => items.slice(0, count), [items, count])
  const hasMore = count < items.length
  const loadMore = () => setCount((c) => Math.min(c + step, items.length))

  return { visible, hasMore, loadMore }
}
