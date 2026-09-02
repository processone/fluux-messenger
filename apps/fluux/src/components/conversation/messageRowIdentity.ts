import type { MessageRowRef } from '@fluux/sdk'

const OCCUPANT_ROW_PREFIX = 'occupant-row:'
const CLIENT_ROW_PREFIX = 'client-row:'

/**
 * The row handle: unique per RENDERED ROW, where a client id is unique only per
 * logical message. Two occupant-conflicting copies legitimately share an id, so
 * the handle qualifies it with the occupant when there is one.
 *
 * THE OPTIONAL RETURN IS DELIBERATE, NOT AN OVERSIGHT TO BE TIDIED. Messages
 * without a client id are a supported case: a bodiless placeholder can reach the
 * list without one, the message types declare `id` required anyway, and
 * `MessageList.keys.test.tsx` is the contract that proves it — it asserts such a
 * message renders without React key warnings and without being dropped. So this
 * returns undefined for them and each caller states what an id-less row means to
 * it, rather than this function inventing a handle or throwing. Narrowing the
 * return to `string` reintroduces the crash that test catches.
 */
export function messageRowId(message: { id?: string; occupantId?: string }): string | undefined {
  const { id, occupantId } = message
  if (!id) return id
  if (occupantId) return `${OCCUPANT_ROW_PREFIX}${JSON.stringify([id, occupantId])}`
  // An ordinary id that LOOKS like a handle is escaped into the reserved
  // namespace, so encode/decode stays injective for every possible client id.
  return id.startsWith(OCCUPANT_ROW_PREFIX) || id.startsWith(CLIENT_ROW_PREFIX)
    ? `${CLIENT_ROW_PREFIX}${JSON.stringify(id)}`
    : id
}

/**
 * The inverse of {@link messageRowId}: the row a handle names, occupant included.
 *
 * The SDK callbacks that consume this — the viewport report, the load-around
 * anchor, the divider — take a `MessageRowRef`, so the occupant survives the
 * crossing. A handle that is not one of the reserved encodings is an ordinary
 * client id and yields a ref with no occupant, which is exactly what a 1:1 row, a
 * local echo or a pre-XEP-0421 room offers.
 */
export function messageRowRefFromRowId(rowId: string): MessageRowRef {
  if (rowId.startsWith(CLIENT_ROW_PREFIX)) {
    try {
      const parsed: unknown = JSON.parse(rowId.slice(CLIENT_ROW_PREFIX.length))
      if (typeof parsed === 'string') return { id: parsed }
    } catch {
      return { id: rowId }
    }
    return { id: rowId }
  }
  if (!rowId.startsWith(OCCUPANT_ROW_PREFIX)) return { id: rowId }
  try {
    const parsed: unknown = JSON.parse(rowId.slice(OCCUPANT_ROW_PREFIX.length))
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { id: parsed[0], occupantId: parsed[1] }
    }
  } catch {
    return { id: rowId }
  }
  return { id: rowId }
}

export function findMessageRowElement(root: ParentNode, rowId: string): HTMLElement | null {
  const escaped = CSS.escape(rowId)
  return (
    root.querySelector<HTMLElement>(`[data-message-row-id="${escaped}"]`) ??
    root.querySelector<HTMLElement>(`[data-message-id="${escaped}"]`)
  )
}

export function messageRowElements(root: ParentNode): HTMLElement[] {
  const identified = root.querySelectorAll<HTMLElement>('[data-message-row-id]')
  return identified.length > 0
    ? Array.from(identified)
    : Array.from(root.querySelectorAll<HTMLElement>('[data-message-id]'))
}

export function readMessageRowId(element: HTMLElement): string | undefined {
  return element.dataset.messageRowId || element.dataset.messageId
}
