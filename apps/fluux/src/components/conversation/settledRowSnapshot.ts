import { heightCacheKey } from './messageHeightCache'

/**
 * Read the SETTLED height of every mounted virtualizer row directly from the DOM.
 *
 * @tanstack measures rows via ResizeObserver, but WebKit delivers the settled measurement
 * late — often after the row is windowed out or the list unmounted — so the height cache can
 * hold transient (pre-settle) values. Reading offsetHeight while the rows are still attached
 * (unmount commit, or pagehide before a reload) yields the settled truth.
 *
 * Returns heightCacheKey(itemKey, bucket, scale) -> px for every row that maps to a known
 * item and has a positive height. Rows with a stale/malformed data-index are skipped.
 */
export function collectSettledRowHeights(
  scroller: HTMLElement,
  items: ReadonlyArray<{ key: string }>,
  widthBucketPx: number,
  scalePct: number,
): Map<string, number> {
  const result = new Map<string, number>()
  const rows = scroller.querySelectorAll<HTMLElement>('[data-virtualizer-spacer] > [data-index]')
  for (const el of rows) {
    const idx = Number(el.dataset.index)
    const key = Number.isNaN(idx) ? undefined : items[idx]?.key
    const height = el.offsetHeight
    if (key && height > 0) {
      result.set(heightCacheKey(key, widthBucketPx, scalePct), height)
    }
  }
  return result
}
