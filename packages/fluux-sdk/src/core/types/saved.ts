import type { XMLElementData } from './stanza'

/**
 * One saved message: a private copy of a message, kept on the account's own
 * PEP node so every client of the account lists it (docs/XEP-SAVED_MESSAGES.md).
 * The copy is what this account saved, never verified history: opening an entry
 * goes to the real message, which wins on any difference.
 *
 * @category Chat
 */
export interface SavedMessage {
  /** The PEP item id: a hash of the message identity, the same on every client. */
  id: string
  /** Bare JID of the room or of the other person. */
  conversationJid: string
  type: 'chat' | 'groupchat'
  /** Address the original came from: a room occupant JID, or a person's address. */
  from: string
  /** Address the original was sent to, when known. */
  to?: string
  /** Saved text (up to 4000 characters). Empty for encrypted, deleted and text-less originals. */
  text: string
  /** The original was end-to-end encrypted: no text is stored. */
  encrypted?: true
  /** The original was retracted or moderated: no text is kept. (A message with no text at all is not deleted.) */
  deleted?: true
  /** When the original was sent (ms since epoch). */
  sentAt?: number
  /** When it was saved (ms since epoch). */
  savedAt: number
  /** The original's client message id. */
  messageId?: string
  /** XEP-0359 archive id and the archive that assigned it. */
  stanzaId?: string
  stanzaIdBy?: string
  originId?: string
  /** XEP-0421 occupant id, in rooms. */
  occupantId?: string
  /** Child elements of `<saved/>` this client does not know, kept on rewrite. */
  extras?: XMLElementData[]
}

/** What a client holds for saved messages: entries plus operations not yet sent. */
export type SavedPendingOp = 'publish' | 'retract'
