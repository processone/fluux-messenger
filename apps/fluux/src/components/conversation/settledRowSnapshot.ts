import { heightCacheKey } from './messageHeightCache'

/**
 * Read the SETTLED height of every mounted virtualizer row directly from the DOM.
 *
 * @tanstack measures rows via ResizeObserver, but WebKit delivers the settled measurement
 * late — often after the row is windowed out or the list unmounted — so the height cache can
 * hold transient (pre-settle) values. Reading offsetHeight while the rows are still attached
 * (unmount commit, or pagehide before a reload) yields the settled truth.
 *
 * Returns heightCacheKey(itemKey, scale) -> px for every row that maps to a known item and
 * has a positive height. Skipped rows:
 * - stale/malformed data-index (no matching item)
 * - zero height (detached / unsettled)
 * - isFirstNew rows: their height includes the "new messages" divider, which comes and goes
 *   with read-state between opens — caching it re-blinks the next open when the divider is gone.
 */
export function collectSettledRowHeights(
  scroller: HTMLElement,
  items: ReadonlyArray<{ key: string; isFirstNew?: boolean }>,
  scalePct: number,
): Map<string, number> {
  const result = new Map<string, number>()
  const rows = scroller.querySelectorAll<HTMLElement>('[data-virtualizer-spacer] > [data-index]')
  for (const el of rows) {
    const idx = Number(el.dataset.index)
    const item = Number.isNaN(idx) ? undefined : items[idx]
    const height = el.offsetHeight
    if (item?.key && !item.isFirstNew && height > 0) {
      result.set(heightCacheKey(item.key, scalePct), height)
    }
  }
  return result
}
