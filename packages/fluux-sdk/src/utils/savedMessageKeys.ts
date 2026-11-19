import type { SavedMessage } from '../core/types/saved'
import {
  CHAT_SCOPE, roomScope, identityKeys, occupantConflict, archiveIdentityConflict, sameChatMessage, sameLogicalMessage,
  type IdentityFields, type IdentityScope,
} from './messageIdentity'

/** cyrb53: a small deterministic string hash; two seeds give an id wide enough to name one message. */
function cyrb53(text: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/** What names a message; a whole entry satisfies it too. */
export type SavedIdentity = Pick<SavedMessage, 'conversationJid'> &
  Partial<Pick<SavedMessage, 'type' | 'from' | 'occupantId' | 'stanzaId' | 'stanzaIdBy' | 'originId' | 'messageId'>>

/**
 * The author an origin or client id belongs to. Those ids are chosen by the
 * sender, so two senders may use the same one: the occupant-id names a room
 * author when there is one, else the sender address.
 */
function author(entry: SavedIdentity): string {
  return entry.occupantId ?? entry.from ?? ''
}

/**
 * The key naming one logical message: conversation, then archive id with its
 * `by`, else the author's origin id, else the author's client id. Only the
 * item id is derived from it; {@link sameSavedMessage} decides what is one message.
 */
export function savedMessageKey(entry: SavedIdentity): string {
  if (entry.stanzaId && entry.stanzaIdBy) return `${entry.conversationJid}\u0000sid\u0000${entry.stanzaIdBy}\u0000${entry.stanzaId}`
  if (entry.originId) return `${entry.conversationJid}\u0000origin\u0000${author(entry)}\u0000${entry.originId}`
  return `${entry.conversationJid}\u0000id\u0000${author(entry)}\u0000${entry.messageId ?? ''}`
}

/** The item id: a hash of {@link savedMessageKey}, so two devices saving one message publish one item. */
export function savedItemId(entry: SavedIdentity): string {
  const key = savedMessageKey(entry)
  return `${cyrb53(key, 0)}${cyrb53(key, 1)}`
}

function scopeOf(entry: SavedIdentity): IdentityScope {
  return entry.type === 'groupchat' ? roomScope(entry.conversationJid) : CHAT_SCOPE
}

/** The saved entry seen through the one message-identity ladder (utils/messageIdentity). */
function identityOf(entry: SavedIdentity, missingId: string): IdentityFields {
  return {
    from: entry.from ?? '',
    // An entry without a client id must not match every other one by the empty id.
    id: entry.messageId ?? missingId,
    stanzaId: entry.stanzaId,
    originId: entry.originId,
    occupantId: entry.occupantId,
    ...(entry.type === 'groupchat' && { roomJid: entry.conversationJid }),
  }
}

/**
 * Whether two entries name one message: the shared identity ladder, with the
 * archive authority (`by`) and the author kept in view. A shared origin id of
 * two different archive entries or occupants stays two messages; an entry
 * saved before its archive id was learned and one saved after stay one.
 */
export function sameSavedMessage(a: SavedIdentity, b: SavedIdentity): boolean {
  if (a.conversationJid !== b.conversationJid) return false
  if (a.stanzaId && b.stanzaId && a.stanzaId === b.stanzaId && a.stanzaIdBy && b.stanzaIdBy && a.stanzaIdBy !== b.stanzaIdBy) return false
  const left = identityOf(a, '\u0000a')
  const right = identityOf(b, '\u0000b')
  if ((a.type === 'groupchat') !== (b.type === 'groupchat')) return false
  return a.type === 'groupchat'
    ? !occupantConflict(left, right) && !archiveIdentityConflict(left, right) && sameLogicalMessage(scopeOf(a), left, right)
    : sameChatMessage(left, right)
}

/** Keys a candidate match can share, for indexing entries without comparing every pair. */
export function savedCandidateKeys(entry: SavedIdentity): string[] {
  return identityKeys(scopeOf(entry), identityOf(entry, `\u0000${savedItemId(entry)}`))
}
