import { messageRowRef, matchesMessageRowAlias, type MessageRowRef } from '@fluux/sdk'

const OCCUPANT_ROW_PREFIX = 'occupant-row:'
const CLIENT_ROW_PREFIX = 'client-row:'
const ARCHIVE_ROW_PREFIX = 'archive-row:'

/**
 * The row handle: unique per RENDERED ROW, where a client id is unique only per
 * logical message. Two occupant-conflicting copies legitimately share an id, so
 * the handle qualifies it with the occupant and archive id when available.
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
  const { id, occupantId, stanzaId, unconfirmed } = messageRowRef(message.type === 'chat' ? { id: message.id } : { ...message, id: message.id })
  if (stanzaId) return `${ARCHIVE_ROW_PREFIX}${JSON.stringify([id, occupantId ?? null, stanzaId,
    ...(unconfirmed !== undefined ? [unconfirmed] : [])])}`
  if (occupantId) return `${OCCUPANT_ROW_PREFIX}${JSON.stringify([id, occupantId])}`
  // An ordinary id that LOOKS like a handle is escaped into the reserved
  // namespace, so encode/decode stays injective for every possible client id.
  return id.startsWith(OCCUPANT_ROW_PREFIX) || id.startsWith(CLIENT_ROW_PREFIX) || id.startsWith(ARCHIVE_ROW_PREFIX)
    ? `${CLIENT_ROW_PREFIX}${JSON.stringify(id)}`
    : id
}

/**
 * Decode a presentation handle, retaining every row discriminator.
 *
 * Inputs must come from {@link messageRowId} or {@link messageTargetRowId}:
 * an opaque client ID may itself look like an encoded handle. SDK callbacks
 * receive the decoded `MessageRowRef`, never the presentation string.
 */
export function messageRowRefFromRowId(rowId: string): MessageRowRef {
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

/** Accepts a presentation handle; normalize literal IDs with {@link messageTargetRowId} first. */
export function findMessageRowElement(root: ParentNode, rowId: string): HTMLElement | null {
  const escaped = CSS.escape(rowId)
  const exact = root.querySelector<HTMLElement>(`[data-message-row-id="${escaped}"]`)
  if (exact) return exact
  const confirmed = root.querySelector<HTMLElement>(`[data-message-row-alias="${escaped}"]`)
  if (confirmed) return confirmed
  const ref = messageRowRefFromRowId(rowId)
  if (!ref.occupantId && !ref.stanzaId) return root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(ref.id)}"]`)
  const legacyAlias = Array.from(root.querySelectorAll<HTMLElement>('[data-message-row-alias]')).find(element =>
    matchesMessageRowAlias(messageRowRefFromRowId(element.dataset.messageRowAlias!), ref))
  if (legacyAlias) return legacyAlias
  // Saved handles without an archive id still resolve after normal backfill.
  return Array.from(root.querySelectorAll<HTMLElement>('[data-message-row-id]')).find(element => {
    const candidate = messageRowRefFromRowId(element.dataset.messageRowId!)
    return candidate.id === ref.id && candidate.occupantId === ref.occupantId &&
      (!ref.stanzaId || candidate.stanzaId === ref.stanzaId)
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
