import type { RenderItem } from './messageListItems'
import { predictMessageTextHeight, type FontSpec } from '@/utils/messageHeight/predictMessageTextHeight'
import { classifyMessageBody } from '@/utils/messageHeight/classifyMessageBody'

export interface RowChrome {
  header: number          // sender header block (avatar row + nick + timestamp) above the text
  continuation: number    // vertical padding of a continuation row (no header)
  reactionsRow: number    // a single reactions strip under a message
  newMarker: number       // the "New messages" divider rendered above a first-new row
  date: number            // a date separator row
  loadEarlierHeader: number // the load-earlier / history-start header row
  footer: number          // the footer (typing indicator + bottom padding)
}

export interface RowEstimatorContext {
  fontSpec: FontSpec
  contentWidthPx: number
  lineBoxPx: number
  chrome: RowChrome
}

/** Reserved height for a media row (image/file/link-preview/poll) before its real DOM is measured. */
export const RESERVED_MEDIA_PX = 260
/** Per-line height used to reserve space for a fenced code block (monospace; pretext cannot model it). */
export const RESERVED_CODE_LINE_PX = 19

/** Reserve space for a code block by counting its physical newlines (a safe over-estimate;
 *  the real highlighted block is measured on mount). */
function reservedCodeHeight(body: string, lineBoxPx: number): number {
  const lines = body.split('\n').length
  return lines * Math.max(lineBoxPx, RESERVED_CODE_LINE_PX)
}

/**
 * Deterministic per-item height estimate for the virtualizer. Pure: same (item, ctx) -> same px.
 * Text rows use pretext line-count; code/media rows use reserved space; structural rows use the
 * sampled chrome constants. The virtualizer measures the real row on mount, so this only needs to
 * be close enough to stop the estimate-snap.
 */
export function estimateRowHeight<T extends {
  id: string; body: string; reactions?: Record<string, string[]>
  attachment?: unknown; linkPreview?: unknown; poll?: unknown; isRetracted?: boolean
}>(item: RenderItem<T>, ctx: RowEstimatorContext): number {
  if (item.kind === 'date') return ctx.chrome.date
  if (item.kind === 'header') return ctx.chrome.loadEarlierHeader
  if (item.kind === 'footer') return ctx.chrome.footer

  // message
  const m = item.message
  const chromeBase = item.showAvatar ? ctx.chrome.header : ctx.chrome.continuation
  const marker = item.isFirstNew ? ctx.chrome.newMarker : 0
  const reactions = m.reactions && Object.keys(m.reactions).length > 0 ? ctx.chrome.reactionsRow : 0

  const cls = classifyMessageBody(m)
  let contentPx: number
  if (cls === 'media') {
    contentPx = RESERVED_MEDIA_PX
  } else if (cls === 'code') {
    contentPx = reservedCodeHeight(m.body, ctx.lineBoxPx)
  } else if (cls === 'empty') {
    contentPx = ctx.lineBoxPx
  } else {
    contentPx = predictMessageTextHeight(m.body, ctx.contentWidthPx, ctx.fontSpec, ctx.lineBoxPx).heightPx
  }
  return contentPx + chromeBase + marker + reactions
}
