import type { RenderItem } from './messageListItems'
import type { VirtualWindowItem } from './messageVirtualizer'

/**
 * Derive the date label to show in the floating header, given the virtualizer's
 * current window (visual order, ascending index), the full flat item list, and the
 * scroll container's scrollTop.
 *
 * Returns the `yyyy-MM-dd` date of the topmost VISIBLE message, or null when:
 *  - the topmost visible row is itself a date separator (the inline separator already
 *    shows the date — no duplicate), or
 *  - there is no date item above the topmost visible row (e.g. the load-earlier header
 *    is at the top), or
 *  - the window is empty.
 *
 * Pure: no DOM access, so the geometry logic is fully unit-testable.
 */
export function getTopVisibleDate<T extends { id: string }>(
  windowItems: VirtualWindowItem[],
  allItems: RenderItem<T>[],
  scrollTop: number,
): string | null {
  // Topmost visible row = first (lowest index) row whose bottom edge is below the
  // viewport top. Overscan rows fully above the viewport are skipped.
  let topIndex: number | null = null
  for (const vi of windowItems) {
    if (vi.start + vi.size > scrollTop) {
      topIndex = vi.index
      break
    }
  }
  if (topIndex === null) return null

  const topItem = allItems[topIndex]
  // !topItem guards a transient window/list desync (a window index momentarily out of range); kind === 'date' suppresses the pill under an inline separator.
  if (!topItem || topItem.kind === 'date') return null // suppress under a separator

  // Walk backward to the nearest preceding date item.
  for (let i = topIndex - 1; i >= 0; i--) {
    const it = allItems[i]
    if (it.kind === 'date') return it.date
  }
  return null
}
