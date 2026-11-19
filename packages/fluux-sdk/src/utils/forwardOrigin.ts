import type { BaseMessage } from '../core/types'
import { getBareJid } from '../core/jid'
import { parseRoomMessageLink, type RoomMessageLink } from './roomMessageLink'
import { getMessage, getMessageByStanzaId, getMessages, getRoomMessages } from './messageCache'

/** Where the original of a forwarded copy can be opened. */
export type ForwardOrigin =
  | { kind: 'room'; roomJid: string; stanzaId: string }
  | { kind: 'chat'; conversationId: string; messageId: string }

/** How far from the copy's time a message may be and still count as the original. */
export const FORWARD_ORIGIN_WINDOW_MS = 2 * 60 * 1000

/** The room message link the forward generated: a link inside the text marked as the copy's fallback, never one pasted in the comment. */
export function forwardedCopyRoomLink(message: Pick<BaseMessage, 'references' | 'forwarded'>): RoomMessageLink | null {
  const marked = message.forwarded?.fallback?.text
  if (!marked) return null
  for (const reference of message.references ?? []) {
    if (reference.type !== 'data' || !marked.includes(reference.uri)) continue
    const target = parseRoomMessageLink(reference.uri)
    if (target) return target
  }
  return null
}

const sameText = (body: string, copy: string) => {
  const a = body.trim(), b = copy.trim()
  return !!b && (a === b || a.startsWith(b))
}

/**
 * Find the original of a forwarded copy: first the room message link the forward carries, then
 * the ids it carries, then local history by sender, time and text. Reads local history only, and
 * only when called; null when the original is not there.
 *
 * @param conversationIds - the direct conversations to search when the original's sender is the account itself
 */
export async function findForwardedOrigin(
  message: Pick<BaseMessage, 'references' | 'forwarded'>,
  account: string,
  conversationIds: readonly string[],
): Promise<ForwardOrigin | null> {
  const copy = message.forwarded
  if (!copy) return null
  const me = getBareJid(account)
  const link = forwardedCopyRoomLink(message)
  if (link) return { kind: 'room', ...link }

  const from = copy.from ? getBareJid(copy.from) : ''
  const isRoom = copy.type === 'groupchat'
  if (isRoom && copy.stanzaId && copy.stanzaIdBy === from) return { kind: 'room', roomJid: from, stanzaId: copy.stanzaId }
  const window = copy.timestamp !== undefined
    ? { after: new Date(copy.timestamp - FORWARD_ORIGIN_WINDOW_MS), before: new Date(copy.timestamp + FORWARD_ORIGIN_WINDOW_MS) } : undefined

  if (isRoom) {
    if (!from || !window) return null
    const slash = copy.from?.indexOf('/') ?? -1
    const nick = slash >= 0 ? copy.from!.slice(slash + 1) : copy.author
    const rows = await getRoomMessages(from, window)
    const hit = rows.find(row => !row.isPrivate && !!row.stanzaId && row.nick === nick && sameText(row.body, copy.text))
    return hit?.stanzaId ? { kind: 'room', roomJid: from, stanzaId: hit.stanzaId } : null
  }

  // A direct copy: the sender's own conversation first, every direct conversation when it was the account's own message.
  const senderIsMe = from === me
  const candidates = senderIsMe ? [...conversationIds] : [from, ...conversationIds.filter(id => id !== from)]
  if (copy.id) {
    for (const conversationId of candidates) {
      const hit = await getMessage(conversationId, copy.id)
      if (hit && (senderIsMe ? hit.isOutgoing : getBareJid(hit.from) === from)) return { kind: 'chat', conversationId, messageId: hit.id }
    }
  }
  if (copy.stanzaId && copy.stanzaIdBy === me) {
    for (const conversationId of candidates) {
      const hit = await getMessageByStanzaId(conversationId, copy.stanzaId)
      if (hit) return { kind: 'chat', conversationId, messageId: hit.id }
    }
  }
  if (!window) return null
  for (const conversationId of senderIsMe ? candidates : [from]) {
    const rows = await getMessages(conversationId, {
      ...window,
      filter: row => (senderIsMe ? row.isOutgoing : !row.isOutgoing && getBareJid(row.from) === from) && sameText(row.body, copy.text),
    })
    if (rows[0]) return { kind: 'chat', conversationId, messageId: rows[0].id }
  }
  return null
}
