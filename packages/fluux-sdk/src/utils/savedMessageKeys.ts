import type { SavedMessage } from '../core/types/saved'

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
export type SavedIdentity = Pick<SavedMessage, 'conversationJid'> & Partial<Pick<SavedMessage, 'stanzaId' | 'stanzaIdBy' | 'originId' | 'messageId'>>

/**
 * The key naming one logical message: conversation, then archive id with its
 * `by`, else origin id, else the client id. Equal keys are one message.
 */
export function savedMessageKey(entry: SavedIdentity): string {
  if (entry.stanzaId && entry.stanzaIdBy) return `${entry.conversationJid}\u0000sid\u0000${entry.stanzaIdBy}\u0000${entry.stanzaId}`
  if (entry.originId) return `${entry.conversationJid}\u0000origin\u0000${entry.originId}`
  return `${entry.conversationJid}\u0000id\u0000${entry.messageId ?? ''}`
}

/** The item id: a hash of {@link savedMessageKey}, so two devices saving one message publish one item. */
export function savedItemId(entry: SavedIdentity): string {
  const key = savedMessageKey(entry)
  return `${cyrb53(key, 0)}${cyrb53(key, 1)}`
}

/**
 * Every key an entry can be recognised by, strongest first. Two entries sharing
 * any key name the same message (one saved before the archive id was learned,
 * one after).
 */
export function savedMessageKeys(entry: SavedIdentity): string[] {
  const keys: string[] = []
  if (entry.stanzaId && entry.stanzaIdBy) keys.push(savedMessageKey({ conversationJid: entry.conversationJid, stanzaId: entry.stanzaId, stanzaIdBy: entry.stanzaIdBy }))
  if (entry.originId) keys.push(savedMessageKey({ conversationJid: entry.conversationJid, originId: entry.originId }))
  if (keys.length === 0 && entry.messageId) keys.push(savedMessageKey({ conversationJid: entry.conversationJid, messageId: entry.messageId }))
  return keys
}

