/**
 * Helpers for choosing a safe MAM backward-pagination cursor.
 *
 * XEP-0313 RSM `<before>` must reference a server-assigned archive id
 * (XEP-0359 stanza-id) that exists in the *queried* archive. Sending any
 * other value — most commonly a client-generated message id — makes
 * ejabberd's mod_mam reject the query with `item-not-found`, which dead-ends
 * "load older history". Outgoing messages never receive a stanzaId, so the
 * oldest in-memory message frequently lacks one; these helpers ensure we
 * never use a non-archive id as the cursor.
 */

/** Minimal shape needed to pick a pagination cursor. */
interface ArchivableMessage {
  /** XEP-0359 server-assigned archive id. Absent on outgoing / unarchived messages. */
  stanzaId?: string
}

/**
 * Return the server archive id (stanza-id) of the oldest in-memory message
 * that has one, scanning from oldest to newest. Messages are stored
 * oldest-first, so the first message carrying a stanzaId is the oldest valid
 * cursor: querying `before` it re-includes any stanzaId-less neighbours
 * (harmless duplicates) while correctly advancing into older history.
 *
 * Returns undefined when no in-memory message carries a stanzaId. Callers MUST
 * NOT substitute a client-generated id — the server rejects it with
 * `item-not-found`.
 */
export function pickOldestArchiveId(messages: ArchivableMessage[]): string | undefined {
  for (const message of messages) {
    if (message.stanzaId) return message.stanzaId
  }
  return undefined
}

/**
 * True when an error represents a MAM `item-not-found` stanza error — the
 * server could not locate the RSM cursor in the archive. Detected via the
 * XMPP StanzaError `condition` (preferred) or the error message as a fallback.
 */
export function isItemNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ((error as { condition?: string }).condition === 'item-not-found') return true
  if (error instanceof Error && error.message.includes('item-not-found')) return true
  return false
}
