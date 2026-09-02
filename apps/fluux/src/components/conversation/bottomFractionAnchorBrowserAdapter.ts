import type { ScrollAnchor } from '@/utils/scrollStateManager'
import type { MessageVirtualizer } from './messageVirtualizer'
import { findMessageRowElement } from './messageRowIdentity'

export type BottomFractionAnchorFrameResult =
  | { kind: 'unavailable' }
  | {
      kind: 'positioned'
      scrollTop: number
      reassert: boolean
    }

export interface BottomFractionAnchorBrowserAdapterOptions {
  getScroller: () => HTMLElement | null
  getVirtualizer: () => MessageVirtualizer | undefined
}

export class BottomFractionAnchorBrowserAdapter {
  constructor(private readonly options: BottomFractionAnchorBrowserAdapterOptions) {}

  position(anchor: ScrollAnchor): BottomFractionAnchorFrameResult {
    const scroller = this.options.getScroller()
    if (!scroller) return { kind: 'unavailable' }
    const virtualizer = this.options.getVirtualizer()

    if (virtualizer) {
      const index = virtualizer.getIndexForMessageId(anchor.messageId)
      if (index === null) return { kind: 'unavailable' }

      // A bottom-edge anchor first mounts at `end`. Once the row has measured, later controller
      // frames can apply the exact fractional target without racing two virtualizer positions.
      const item = anchor.fraction < 1
        ? virtualizer.getVirtualItems().find((candidate) => candidate.index === index)
        : undefined
      const size = item?.size
      const start = size
        ? virtualizer.getOffsetForMessageId(anchor.messageId)
        : null
      if (size && start !== null) {
        const row = findMessageRowElement(scroller, anchor.messageId)
        const rect = row && row.offsetHeight > 0
          ? row.getBoundingClientRect()
          : null
        const target = rect
          ? rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop +
            anchor.fraction * rect.height - scroller.clientHeight
          : start + anchor.fraction * size - scroller.clientHeight
        virtualizer.scrollToOffset(Math.max(0, target))
      } else {
        virtualizer.scrollToIndex(index, { align: 'end' })
      }
      return {
        kind: 'positioned',
        scrollTop: scroller.scrollTop,
        reassert: true,
      }
    }

    const row = findMessageRowElement(scroller, anchor.messageId)
    if (!row || row.offsetHeight <= 0) return { kind: 'unavailable' }
    const rect = row.getBoundingClientRect()
    const contentTop =
      rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop
    scroller.scrollTop =
      contentTop + anchor.fraction * rect.height - scroller.clientHeight
    return {
      kind: 'positioned',
      scrollTop: scroller.scrollTop,
      reassert: false,
    }
  }
}
