import { openDB } from 'idb'
import type { Message, RoomMessage } from '../../core/types'
import { chatCacheKey } from '../messageCache'
import { searchDocumentKey, identityKeys, roomScope } from '../messageIdentity'
import { tokenize } from '../searchIndex'

/** Distinct archive identities keep cache deduplication from collapsing the repeated corpus. */
export function generateSearchHistory(corpus: readonly (Message | RoomMessage)[], count = 50_000): Array<Message | RoomMessage> {
  if (!corpus.length) throw new Error('A conversation corpus is required')
  return Array.from({ length: count }, (_, index) => {
    const source = corpus[index % corpus.length]
    return { ...source, id: `history-${index}`, stanzaId: `archive-${index}`, originId: undefined,
      timestamp: new Date(Date.UTC(2024, 0, 1) + index * 60_000) }
  })
}

/** The historical schema avoids validating a migration against rows produced by its own writer. */
export async function seedVersion5SearchHistory(scope: string, messages: readonly (Message | RoomMessage)[]): Promise<void> {
  const db = await openDB(`fluux-search-index:${scope}`, 5, {
    upgrade(db) {
      db.createObjectStore('search-tokens', { keyPath: 'token' })
      const docs = db.createObjectStore('search-docs', { keyPath: 'indexId' })
      docs.createIndex('conversationId', 'conversationId')
      docs.createIndex('identityKeys', 'identityKeys', { multiEntry: true })
      docs.createIndex('docNo', 'docNo', { unique: true })
      db.createObjectStore('search-postings')
      db.createObjectStore('search-meta', { keyPath: 'key' })
    },
  })
  try {
    const tx = db.transaction(['search-tokens', 'search-docs', 'search-postings', 'search-meta'], 'readwrite')
    const tokens = new Map<string, string[]>()
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      const room = message.type === 'groupchat'
      const indexId = room ? `room:${searchDocumentKey(message)}` : `chat:${chatCacheKey(message)}`
      const words = [...new Set(tokenize(message.body ?? ''))]
      const docNo = index + 1
      const doc = { indexId, messageId: message.id, tokens: words,
        conversationId: room ? message.roomJid : message.conversationId,
        from: message.from, nick: room ? message.nick : undefined,
        occupantId: room ? message.occupantId : undefined,
        identityKeys: room ? identityKeys(roomScope(message.roomJid), message) : undefined,
        isDelayed: message.isDelayed,
        receivedAt: room ? message.receivedAt?.getTime() : undefined,
        stanzaId: message.stanzaId, originId: message.originId, isOutgoing: message.isOutgoing,
        timestamp: message.timestamp.getTime(), body: message.body, isRoom: room, docNo }
      await tx.objectStore('search-docs').put(doc)
      for (const word of words) {
        const postings = tokens.get(word) ?? []
        postings.push(indexId)
        tokens.set(word, postings)
        await tx.objectStore('search-postings').put(1, [word, -doc.timestamp, docNo])
      }
    }
    for (const [token, postings] of tokens) await tx.objectStore('search-tokens').put({ token, postings })
    await tx.objectStore('search-meta').put({ key: 'next-doc-no', value: String(messages.length + 1) })
    await tx.objectStore('search-meta').put({ key: 'postings-ready', value: '1' })
    await tx.objectStore('search-meta').put({ key: 'backfill-complete', value: 'chat-cache-key' })
    await tx.done
  } finally { db.close() }
}

export const SEARCH_BOUNDARY_WINDOWS = [
  { name: 'spring', start: '2024-03-30T23:00:00.000Z', end: '2024-03-31T22:00:00.000Z' },
  { name: 'autumn', start: '2024-10-26T22:00:00.000Z', end: '2024-10-27T23:00:00.000Z' },
] as const

export function generateSearchBoundaryHistory(corpus: readonly (Message | RoomMessage)[]): Array<Message | RoomMessage> {
  const messages = generateSearchHistory(corpus, SEARCH_BOUNDARY_WINDOWS.length * 4)
  return SEARCH_BOUNDARY_WINDOWS.flatMap((window, index) => [
    ['before', Date.parse(window.start) - 1], ['start', Date.parse(window.start)],
    ['last', Date.parse(window.end) - 1], ['end', Date.parse(window.end)],
  ].map(([position, stamp], offset) => ({
    ...messages[index * 4 + offset], id: `${window.name}-${position}`, stanzaId: `${window.name}-${position}`,
    timestamp: new Date(stamp),
  })))
}
