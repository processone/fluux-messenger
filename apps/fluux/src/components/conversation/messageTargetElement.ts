import { findMessageRowElement, messageRowRefFromRowId } from './messageRowIdentity'

/**
 * Resolve a message reference inside one conversation list.
 *
 * Replies and corrections may carry the local id, the room-assigned stanza id, or the sender's
 * origin id. Keeping this lookup scoped to the active scroller prevents a mounted preview from
 * stealing a live-conversation jump.
 */
export function findMessageTargetElement(
  root: ParentNode,
  messageReference: string,
): HTMLElement | null {
  const row = findMessageRowElement(root, messageReference)
  if (row) return row
  const ref = messageRowRefFromRowId(messageReference)
  if (ref.occupantId || ref.stanzaId || ref.unconfirmed !== undefined) return null
  const escaped = CSS.escape(ref.id)
  return (
    root.querySelector<HTMLElement>(`[data-stanza-id="${escaped}"]`) ??
    root.querySelector<HTMLElement>(`[data-origin-id="${escaped}"]`)
  )
}
