/**
 * Domain helpers over the anomaly value layer.
 *
 * Detectors call these rather than `tokenSync('jid', …)` or `localRef('m', …)`, so
 * the namespace is chosen in exactly one place and a full JID is narrowed to a bare
 * one before it reaches the tokenizer. Without that narrowing the same contact
 * seen from two devices would produce two tokens and read as two entities.
 *
 * Nothing here decides policy — it only picks the right namespace and normalises
 * the input. The privacy guarantee lives entirely in `values.ts`.
 *
 * @module Anomaly/Identity
 */
import { getBareJid } from '@fluux/sdk'
import { localRef, tokenSync, warmToken, type Opaque } from './values'

/** Stable cross-session identity for a 1:1 conversation. */
export function convToken(jid: string): Opaque {
  return tokenSync('jid', getBareJid(jid))
}

/** Warm a conversation's token ahead of any breadcrumb referencing it. */
export function warmConversation(jid: string): Promise<void> {
  return warmToken('jid', getBareJid(jid))
}

/**
 * Stable cross-session identity for a room.
 *
 * A separate namespace from `convToken`, not a stylistic split: the same bare JID
 * can name a contact on one server and a MUC on another, and sharing one token
 * space would assert an identity that does not exist.
 */
export function roomToken(jid: string): Opaque {
  return tokenSync('room', getBareJid(jid))
}

/** Warm a room's token ahead of any breadcrumb referencing it. */
export function warmRoom(jid: string): Promise<void> {
  return warmToken('room', getBareJid(jid))
}

/**
 * Session-local identity for a message.
 *
 * `null` under ref pressure — the caller must then omit the crumb rather than
 * substitute anything.
 */
export function messageRef(id: string): Opaque | null {
  return localRef('m', id)
}

/** Session-local identity for a MAM query. `null` under ref pressure. */
export function queryRef(id: string): Opaque | null {
  return localRef('q', id)
}
