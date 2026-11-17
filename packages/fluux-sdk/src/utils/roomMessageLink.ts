import type { DataReference, MessageReference } from '../core/types/chat'
import { parseXmppUri } from './xmppUri'

/** A room message link names the room's archive id, never a sender's client id. */
export interface RoomMessageLink {
  roomJid: string
  stanzaId: string
}

function isRoomAddress(jid: string): boolean {
  return /^[^\s@/]+@[^\s@/]+$/.test(jid)
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

/** Find pasted room links with offsets in the original body (UTF-16 in memory). */
export function roomMessageLinkReferences(body: string): DataReference[] {
  const references: DataReference[] = []
  for (const match of body.matchAll(/(?<![\w:])xmpp:[^\s<>]+/g)) {
    const uri = match[0].replace(/[.,;:!?)"'\]]+$/, '')
    if (parseRoomMessageLink(uri)) references.push({ type: 'data', uri, begin: match.index, end: match.index + uri.length })
  }
  return references
}

/** Prefer an explicit data reference; older clients can send just the body link. */
export function findRoomMessageLink(body: string, references?: MessageReference[]): RoomMessageLink | null {
  // A forward's marked link is its source, whatever other links its comment or quote holds.
  const marked = (references ?? []).filter(reference => reference.type === 'data' && reference.forwardFallback)
  for (const reference of [...marked, ...(references ?? [])]) {
    if (reference.type !== 'data') continue
    const target = parseRoomMessageLink(reference.uri)
    if (target) return target
  }
  for (const reference of roomMessageLinkReferences(body)) {
    const target = parseRoomMessageLink(reference.uri)
    if (target) return target
  }
  return null
}
