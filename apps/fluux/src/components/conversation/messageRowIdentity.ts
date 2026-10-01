import { messageRowRef, matchesMessageRowAlias, type MessageRowRef } from '@fluux/sdk'

const OCCUPANT_ROW_PREFIX = 'occupant-row:'
const CLIENT_ROW_PREFIX = 'client-row:'
const ARCHIVE_ROW_PREFIX = 'archive-row:'
const ORIGIN_ROW_PREFIX = 'origin-row:'

/**
 * A row handle qualifies a reusable client id with the available identity
 * discriminators. Two occupant-conflicting room copies legitimately share an
 * id, and so do two archive-distinct messages from a sender that re-issued a
 * client id, so the handle qualifies it with the occupant and archive id when
 * available. A direct-chat row without an archive id qualifies by origin id.
 * These display discriminators do not establish authority for moderation.
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
export function messageRowId(message: Omit<Parameters<typeof messageRowRef>[0], 'id'> & { id?: string; type?: 'chat' | 'groupchat' }): string | undefined {
  if (!message.id) return message.id
  const { id, occupantId, stanzaId, originId, unconfirmed } = messageRowRef(message.type === 'chat' ? { id: message.id, stanzaId: message.stanzaId, originId: message.originId } : { ...message, id: message.id })
  if (stanzaId) return `${ARCHIVE_ROW_PREFIX}${JSON.stringify([id, occupantId ?? null, stanzaId,
    ...(unconfirmed !== undefined ? [unconfirmed] : [])])}`
  if (occupantId) return `${OCCUPANT_ROW_PREFIX}${JSON.stringify([id, occupantId])}`
  if (originId) return `${ORIGIN_ROW_PREFIX}${JSON.stringify([id, originId])}`
  // An ordinary id that LOOKS like a handle is escaped into the reserved
  // namespace, so encode/decode stays injective for every possible client id.
  return id.startsWith(OCCUPANT_ROW_PREFIX) || id.startsWith(CLIENT_ROW_PREFIX) || id.startsWith(ARCHIVE_ROW_PREFIX) || id.startsWith(ORIGIN_ROW_PREFIX)
    ? `${CLIENT_ROW_PREFIX}${JSON.stringify(id)}`
    : id
}

/**
 * The per-message deduplication key; {@link messageRowKeys} owns list mount keys.
 *
 * Two first deliveries of a room can share a client id and a nick with no
 * archive id to tell them apart — a reassigned nick, or one occupant's client
 * re-issuing an id (the delivery-channel clause in `docs/MESSAGE_IDENTIFIERS.md`);
 * the SDK holds them as two rows, but they share one handle. The handle stays
 * the addressable name a row is found by; this key adds the receipt instant so
 * React, the virtualizer and the list's dedup keep both. The receipt instant is
 * stable across an archive-stamp merge, which `timestamp` is not.
 */
export function messageRowKey(message: Parameters<typeof messageRowId>[0] & { timestamp?: Date; receivedAt?: Date }): string | undefined {
  const rowId = messageRowId(message)
  if (!rowId || message.type !== 'groupchat' || message.stanzaId) return rowId
  const instant = message.receivedAt ?? message.timestamp
  return instant ? `${rowId}@${instant.getTime()}` : rowId
}

/**
 * The keys one rendered list mounts its rows under, by message.
 *
 * A direct-chat row keys on its client id while no other row in the list shares
 * it, so an archive backfill that qualifies its handle keeps the mounted row and
 * its measured height. Rows that do share one — archive-distinct messages from a
 * sender that re-issued a client id — key on their handles. Every other row
 * keys on {@link messageRowKey}; an id-less row has no entry.
 */
export function messageRowKeys<T extends Parameters<typeof messageRowKey>[0] & { id?: string }>(messages: readonly T[]): Map<T, string> {
  const clientIdCounts = new Map<string, number>()
  for (const message of messages) {
    if (message.type === 'chat' && message.id) clientIdCounts.set(message.id, (clientIdCounts.get(message.id) ?? 0) + 1)
  }
  const keys = new Map<T, string>()
  for (const message of messages) {
    const shared = message.type === 'chat' && !!message.id && clientIdCounts.get(message.id)! > 1
    const key = message.type === 'chat' && !shared ? messageRowId({ id: message.id }) : messageRowKey(message)
    if (key) keys.set(message, key)
  }
  return keys
}

/**
 * Decode a presentation handle, retaining every row discriminator.
 *
 * Inputs must come from {@link messageRowId} or {@link messageTargetRowId}:
 * an opaque client ID may itself look like an encoded handle. SDK callbacks
 * receive the decoded `MessageRowRef`, never the presentation string.
 */
export function messageRowRefFromRowId(rowId: string): MessageRowRef {
  if (rowId.startsWith(ORIGIN_ROW_PREFIX)) {
    try {
      const parsed: unknown = JSON.parse(rowId.slice(ORIGIN_ROW_PREFIX.length))
      if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
        return { id: parsed[0], originId: parsed[1] }
      }
    } catch {
      return { id: rowId }
    }
    return { id: rowId }
  }
  if (rowId.startsWith(ARCHIVE_ROW_PREFIX)) {
    try {
      const parsed: unknown = JSON.parse(rowId.slice(ARCHIVE_ROW_PREFIX.length))
      if (Array.isArray(parsed) && (parsed.length === 3 || parsed.length === 4 && typeof parsed[3] === 'boolean') && typeof parsed[0] === 'string' &&
        (parsed[1] === null || typeof parsed[1] === 'string') && typeof parsed[2] === 'string') {
        return { id: parsed[0], ...(parsed[1] ? { occupantId: parsed[1] } : {}), stanzaId: parsed[2],
          ...(parsed.length === 4 ? { unconfirmed: parsed[3] } : {}) }
      }
    } catch {
      return { id: rowId }
    }
    return { id: rowId }
  }
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

export function messageTargetRowId(target: string | MessageRowRef): string {
  return messageRowId(typeof target === 'string' ? { id: target } : target)!
}

/**
 * A CSS string literal holding `value`. Quotes, backslashes and line breaks use
 * hex escapes rather than `\"`: both are valid CSS, but jsdom's selector engine
 * rejects a `\"` inside a quoted attribute value, and every archive row handle
 * contains one.
 */
function cssString(value: string): string {
  return `"${value.replace(/["\\\n\r\f]/g, char => `\\${char.charCodeAt(0).toString(16)} `)}"`
}

/** Accepts a presentation handle; normalize literal IDs with {@link messageTargetRowId} first. */
export function findMessageRowElement(root: ParentNode, rowId: string): HTMLElement | null {
  const quoted = cssString(rowId)
  const exact = root.querySelector<HTMLElement>(`[data-message-row-id=${quoted}]`)
  if (exact) return exact
  const confirmed = root.querySelector<HTMLElement>(`[data-message-row-alias=${quoted}]`)
  if (confirmed) return confirmed
  const ref = messageRowRefFromRowId(rowId)
  if (!ref.occupantId && !ref.stanzaId && !ref.originId) return root.querySelector<HTMLElement>(`[data-message-id=${cssString(ref.id)}]`)
  const legacyAlias = Array.from(root.querySelectorAll<HTMLElement>('[data-message-row-alias]')).find(element =>
    matchesMessageRowAlias(messageRowRefFromRowId(element.dataset.messageRowAlias!), ref))
  if (legacyAlias) return legacyAlias
  // Saved handles without an archive id still resolve after normal backfill.
  return Array.from(root.querySelectorAll<HTMLElement>('[data-message-row-id]')).find(element => {
    const candidate = messageRowRefFromRowId(element.dataset.messageRowId!)
    return candidate.id === ref.id && candidate.occupantId === ref.occupantId &&
      (!ref.stanzaId || candidate.stanzaId === ref.stanzaId) &&
      (!ref.originId || (candidate.originId ?? element.dataset.originId) === ref.originId)
  }) ?? null
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
