import type { ScrollAnchor } from '@/utils/scrollStateManager'
import { messageRowElements, readMessageRowId } from './messageRowIdentity'

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * Capture a CONTENT anchor: the bottom-most visible message and the FRACTION (0..1) of its
 * height at which the viewport bottom sits. fraction=1 → the message's bottom edge is at the
 * window bottom; 0.5 → the window bottom cuts its middle.
 *
 * Storing a fraction (not a pixel gap) makes the position INDEPENDENT OF RENDERING: on return we
 * re-derive pixels from the message's CURRENT measured height, so a re-measure, a width change, or
 * a virtualization re-window can't corrupt it. A pixel gap found via a BINARY SEARCH over
 * `offsetTop` would assume rows are in sorted document order — false under virtualization (the
 * DOM holds an unsorted/stale window), producing a wildly wrong gap that flings the view to the
 * bottom on return. This is a linear max-scan over the small rendered window using each row's
 * bounding rectangle relative to the scroller, so DOM order does not matter.
 */
export function findBottomAnchor(scroller: HTMLElement): ScrollAnchor | null {
  const rows = messageRowElements(scroller)
  if (rows.length === 0) return null
  // Measure with getBoundingClientRect (relative to the scroller), NOT offsetTop. Under
  // virtualization each `.message-row` sits inside its own `position:absolute` `[data-index]`
  // wrapper, which is the row's offsetParent — so `offsetTop` is ~0 for EVERY row and the old
  // "greatest offsetTop" pick always returned the top-most MOUNTED row instead of the bottom-most
  // visible one. That wrong anchor was saved/restored (masked by consistency-only tests) and is a
  // root cause of the conversation-switch "drifts back in time" report. Bounding rects reflect the
  // real on-screen position for both the virtualized and the normal-flow paths.
  const sTop = scroller.getBoundingClientRect().top
  const viewportH = scroller.clientHeight
  // Bottom-most row whose TOP is still within the viewport (greatest scroller-relative top < height).
  let best: HTMLElement | null = null
  let bestTop = -Infinity
  for (const node of rows) {
    const el = node as HTMLElement
    if (el.offsetHeight <= 0) continue
    const top = el.getBoundingClientRect().top - sTop
    if (top < viewportH && top > bestTop) {
      best = el
      bestTop = top
    }
  }
  if (best === null) best = rows[rows.length - 1] as HTMLElement
  const messageId = readMessageRowId(best)
  if (!messageId) return null
  const rect = best.getBoundingClientRect()
  const height = rect.height || 1
  const topRel = rect.top - sTop
  return { messageId, fraction: clamp01((viewportH - topRel) / height) }
}
