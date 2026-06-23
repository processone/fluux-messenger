import { flattenMessageItems } from './flattenMessageItems'
import type { MessageListItem } from './messageVirtualizer'

/**
 * The full set of rows the MessageList virtualizer windows: the generic date/message
 * items plus a MessageList-specific header (load-earlier / history-start) and footer
 * (extra content + typing indicator). Header and footer are flattened as items too —
 * rather than rendered outside the spacer — so every offset is in one coordinate space
 * consistent with the scroll container's scrollTop (no @tanstack scrollMargin needed).
 */
export type RenderItem<T extends { id: string }> =
  | { kind: 'header'; key: string }
  | { kind: 'footer'; key: string }
  | MessageListItem<T>

interface BuildOpts<T> {
  firstNewMessageId?: string
  showAvatar: (groupMessages: T[], index: number) => boolean
  showHeader: boolean
  showFooter: boolean
}

/**
 * Build the windowed item list for the MessageList. Reuses flattenMessageItems for the
 * date/message core, prepends the header and appends the footer when shown, and shifts
 * the id → index map by the header offset so getOffsetForMessageId stays correct.
 */
export function buildMessageListItems<T extends { id: string }>(
  groups: { date: string; messages: T[] }[],
  opts: BuildOpts<T>,
): { items: RenderItem<T>[]; indexById: Map<string, number> } {
  const core = flattenMessageItems(groups, { firstNewMessageId: opts.firstNewMessageId, showAvatar: opts.showAvatar })
  const items: RenderItem<T>[] = []
  const headerOffset = opts.showHeader ? 1 : 0
  if (opts.showHeader) items.push({ kind: 'header', key: '__header' })
  for (const it of core.items) items.push(it)
  if (opts.showFooter) items.push({ kind: 'footer', key: '__footer' })
  const indexById = new Map<string, number>()
  core.indexById.forEach((i, id) => indexById.set(id, i + headerOffset))
  return { items, indexById }
}
