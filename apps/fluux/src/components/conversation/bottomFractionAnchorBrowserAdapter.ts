import type { ScrollAnchor } from '@/utils/scrollStateManager'
import type { MessageVirtualizer, ScrollWriteOwner } from './messageVirtualizer'
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

  position(anchor: ScrollAnchor, owner?: ScrollWriteOwner): BottomFractionAnchorFrameResult {
    const scroller = this.options.getScroller()
    if (!scroller) return { kind: 'unavailable' }
    const virtualizer = this.options.getVirtualizer()

    if (virtualizer) {
      const index = virtualizer.getIndexForMessageId(anchor.messageId)
      if (index === null) return { kind: 'unavailable' }

      // A measured, mounted row's rect is the exact inverse of anchor capture at every fraction,
      // so re-pinning an unchanged capture writes the position it already has. Virtualizer
      // offsets start at the spacer, below the list's top padding, so they only stand in until
      // the row mounts: a fractional anchor estimates from its measured start, and a bottom-edge
      // anchor first mounts at `end`, without racing two virtualizer positions.
      const item = virtualizer.getVirtualItems().find((candidate) => candidate.index === index)
      const size = item?.size
      const start = size
        ? virtualizer.getOffsetForMessageId(anchor.messageId)
        : null
      const row = size && start !== null
        ? findMessageRowElement(scroller, anchor.messageId)
        : null
      const rect = row && row.offsetHeight > 0
        ? row.getBoundingClientRect()
        : null
      if (rect) {
        const target = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop +
          anchor.fraction * rect.height - scroller.clientHeight
        virtualizer.scrollToOffset(Math.max(0, target), { owner })
      } else if (size && start !== null && anchor.fraction < 1) {
        virtualizer.scrollToOffset(
          Math.max(0, start + anchor.fraction * size - scroller.clientHeight),
          { owner },
        )
      } else {
        virtualizer.scrollToIndex(index, { align: 'end', owner })
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
