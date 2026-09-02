import { findMessageRowElement } from './messageRowIdentity'

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
  const escaped = CSS.escape(messageReference)
  return (
    findMessageRowElement(root, messageReference) ??
    root.querySelector<HTMLElement>(`[data-stanza-id="${escaped}"]`) ??
    root.querySelector<HTMLElement>(`[data-origin-id="${escaped}"]`)
  )
}
