import type { MessageListItem } from './messageVirtualizer'

/** Structural input shape — `MessageGroup<Message>[]` from messageGrouping.ts is
 *  assignable to this, without inheriting its `GroupableMessage` constraint. */
interface FlattenGroup<T> {
  date: string
  messages: T[]
}

interface FlattenOpts<T> {
  firstNewMessageId?: string
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
  for (const group of groups) {
    items.push({ kind: 'date', key: `date:${group.date}`, date: group.date })
    group.messages.forEach((message, i) => {
      indexById.set(message.id, items.length)
      items.push({
        kind: 'message',
        key: message.id,
        message,
        showAvatar: opts.showAvatar(group.messages, i),
        isFirstNew: message.id === opts.firstNewMessageId,
        indexInGroup: i,
        groupMessages: group.messages,
      })
    })
  }
  return { items, indexById }
}
