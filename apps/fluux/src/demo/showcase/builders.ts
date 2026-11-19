/**
 * Message builders for the showcase scene. They fill the fields every demo
 * message repeats, so the scene files read as a script rather than as stanzas.
 */

import type { Message, RoomMessage } from '@fluux/sdk'
import { SELF_JID } from '../constants'
import { SHOWCASE_SELF_NICK } from './constants'

type ChatExtras = Partial<Omit<Message, 'type' | 'id' | 'from' | 'body' | 'timestamp' | 'isOutgoing' | 'conversationId'>>
type RoomExtras = Partial<Omit<RoomMessage, 'type' | 'id' | 'from' | 'nick' | 'body' | 'timestamp' | 'isOutgoing' | 'roomJid'>>

/** A 1:1 message. `from` is the peer's bare JID, or `'self'` for an outgoing message. */
export function chatMessage(
  conversationId: string,
  id: string,
  from: string | 'self',
  body: string,
  timestamp: Date,
  extras: ChatExtras = {},
): Message {
  const isOutgoing = from === 'self'
  return {
    type: 'chat',
    id: `showcase-${id}`,
    stanzaId: undefined,
    originId: undefined,
    from: isOutgoing ? SELF_JID : from,
    body,
    timestamp,
    isOutgoing,
    conversationId,
    ...extras,
  }
}

/** A room message. `nick` is the occupant nickname, or `'self'` for an outgoing message. */
export function roomMessage(
  roomJid: string,
  id: string,
  nick: string | 'self',
  body: string,
  timestamp: Date,
  extras: RoomExtras = {},
): RoomMessage {
  const sender = nick === 'self' ? SHOWCASE_SELF_NICK : nick
  return {
    type: 'groupchat',
    id: `showcase-${id}`,
    stanzaId: undefined,
    originId: undefined,
    occupantId: `showcase-${roomJid}-${sender}`,
    from: `${roomJid}/${sender}`,
    nick: sender,
    body,
    timestamp,
    isOutgoing: nick === 'self',
    roomJid,
    ...extras,
  }
}
