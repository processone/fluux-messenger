import type { MessageRowRef } from '@fluux/sdk'
import type { MessageListItem } from './messageVirtualizer'
import { messageRowId, messageRowKey } from './messageRowIdentity'

/** Structural input shape — `MessageGroup<Message>[]` from messageGrouping.ts is
 *  assignable to this, without inheriting its `GroupableMessage` constraint. */
interface FlattenGroup<T> {
  date: string
  messages: T[]
}

interface FlattenOpts<T> {
  /** The divider's ROW handle — the row id recorded in `indexById`, not the item `key`. */
  firstNewRowId?: string
  showAvatar: (groupMessages: T[], index: number) => boolean
}

/**
 * Flatten date-grouped messages into a single linear index the virtualizer can window:
 * one `date` item per group followed by its `message` items. Each item carries a stable
 * `key` (the row's presentation key, or `date:<date>`) so the virtualizer's measurement
 * cache follows the message across MAM prepend (which shifts every index). Also returns a
 * presentation-key and row-handle → flat-index map for measurements and offsets;
 * two rows sharing a handle (two first deliveries with a reused client id, see
 * `messageRowKey`) resolve to the earliest, as every other handle lookup does.
 */
export function flattenMessageItems<T extends { type?: 'chat' | 'groupchat'; id: string; occupantId?: string; stanzaId?: string; localRowRef?: MessageRowRef; timestamp?: Date; receivedAt?: Date }>(
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
      const key = messageRowKey(message) ?? rowId
      if (!indexById.has(key)) indexById.set(key, items.length)
      if (!indexById.has(rowId)) indexById.set(rowId, items.length)
      const clientRowId = messageRowId({ id: message.id })
      if (clientRowId && !indexById.has(clientRowId)) indexById.set(clientRowId, items.length)
      if (message.type !== 'chat' && message.stanzaId) {
        for (const stanzaId of [undefined, message.stanzaId]) {
          const previousRowId = messageRowId({ id: message.id, occupantId: message.occupantId, stanzaId })
          if (previousRowId && !indexById.has(previousRowId)) indexById.set(previousRowId, items.length)
        }
      }
      const isFirstNew = !firstNewAssigned && opts.firstNewRowId !== undefined && rowId === opts.firstNewRowId
      if (isFirstNew) firstNewAssigned = true
      items.push({
        kind: 'message',
        key,
        message,
        showAvatar: opts.showAvatar(group.messages, i),
        isFirstNew,
        indexInGroup: i,
        groupMessages: group.messages,
      })
    })
  }
  items.forEach((item, index) => {
    if (item.kind !== 'message' || item.message.type === 'chat' || !item.message.localRowRef) return
    for (const ref of [item.message.localRowRef, { ...item.message.localRowRef, unconfirmed: undefined }]) {
      const alias = messageRowId(ref)
      if (alias && !indexById.has(alias)) indexById.set(alias, index)
    }
  })
  return { items, indexById }
}
