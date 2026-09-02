import type { MessageListItem } from './messageVirtualizer'
import { messageRowId } from './messageRowIdentity'

/** Structural input shape — `MessageGroup<Message>[]` from messageGrouping.ts is
 *  assignable to this, without inheriting its `GroupableMessage` constraint. */
interface FlattenGroup<T> {
  date: string
  messages: T[]
}

interface FlattenOpts<T> {
  /** The divider's ROW handle, in the same currency as each item's `key`. */
  firstNewRowId?: string
  showAvatar: (groupMessages: T[], index: number) => boolean
}

/**
 * Flatten date-grouped messages into a single linear index the virtualizer can window:
 * one `date` item per group followed by its `message` items. Each item carries a stable
 * `key` (the message id, or `date:<date>`) so the virtualizer's measurement cache follows
 * the message across MAM prepend (which shifts every index). Also returns an id → flat-index
 * map for offset lookups.
 */
export function flattenMessageItems<T extends { id: string }>(
  groups: FlattenGroup<T>[],
  opts: FlattenOpts<T>,
): { items: MessageListItem<T>[]; indexById: Map<string, number> } {
  const items: MessageListItem<T>[] = []
  const indexById = new Map<string, number>()
  let firstNewAssigned = false
  for (const group of groups) {
    items.push({ kind: 'date', key: `date:${group.date}`, date: group.date })
    group.messages.forEach((message, i) => {
      // An id-less message still needs a stable, unique item key; mirror the
      // positional fallback the row rendering already uses.
      const rowId = messageRowId(message) ?? `pos:${group.date}:${i}`
      indexById.set(rowId, items.length)
      if (!indexById.has(message.id)) indexById.set(message.id, items.length)
      const isFirstNew = !firstNewAssigned && opts.firstNewRowId !== undefined && rowId === opts.firstNewRowId
      if (isFirstNew) firstNewAssigned = true
      items.push({
        kind: 'message',
        key: rowId,
        message,
        showAvatar: opts.showAvatar(group.messages, i),
        isFirstNew,
        indexInGroup: i,
        groupMessages: group.messages,
      })
    })
  }
  return { items, indexById }
}
