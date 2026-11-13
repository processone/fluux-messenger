import { parseXmppUri } from './xmppUri'

/** A room message link names the room's archive id, never a sender's client id. */
export interface RoomMessageLink {
  roomJid: string
  stanzaId: string
}

function isRoomAddress(jid: string): boolean {
  return /^[^\s@/?#]+@[^\s@/?#]+$/.test(jid)
}

function encodePart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** Build Fluux's room-message extension to the XMPP join URI. */
export function buildRoomMessageLink(roomJid: string, stanzaId: string): string {
  if (!isRoomAddress(roomJid) || !stanzaId) throw new Error('A room address and archive id are required')
  return `xmpp:${encodePart(roomJid).replace(/%40/g, '@')}?join;msg=${encodePart(stanzaId)}`
}

/** Reject malformed, empty, resource-addressed and non-join message links. */
export function parseRoomMessageLink(uri: string): RoomMessageLink | null {
  const parsed = parseXmppUri(uri)
  if (!parsed || parsed.action !== 'join' || !isRoomAddress(parsed.jid) || !parsed.params.msg) return null
  return { roomJid: parsed.jid, stanzaId: parsed.params.msg }
}
