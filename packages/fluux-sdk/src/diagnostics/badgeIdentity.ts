import type { Element } from '@xmpp/client'
import { canonicalKey, receiptQualifiedKey, type IdentityFields, type IdentityScope } from '../utils/messageIdentity'
import { generateUUID } from '../utils/uuid'
import { getBareJid } from '../core/jid'
import { NS_OCCUPANT_ID, NS_STANZA_ID } from '../core/namespaces'

// Module entry points share one weak map. No diagnostic field is added to a
// message, persisted by a cache, or confused with the product's row identity.
const registryKey = Symbol.for('fluux.sdk.badge-diagnostic-occurrences')
const registry = globalThis as typeof globalThis & Record<symbol, WeakMap<object, string> | undefined>
const occurrences = registry[registryKey] ??= new WeakMap<object, string>()

export function badgeMessageKey(message: IdentityFields, stanza?: Element): string | undefined {
  try {
    let key = occurrences.get(message)
    if (!key) {
      key = stanza ? badgeStanzaKey(stanza) : qualified(message)
      if (key) occurrences.set(message, key)
    }
    if (key && stanza) occurrences.set(stanza, key)
    return key
  } catch { return undefined }
}

function qualified(message: IdentityFields): string {
  const scope: IdentityScope = message.roomJid ? { kind: 'room', roomJid: message.roomJid } : { kind: 'chat' }
  // Existing identity tiers qualify sender/occupant/receipt. The nonce separates
  // distinct processing occurrences even if every sender-supplied field collides.
  return JSON.stringify([canonicalKey(scope, message), receiptQualifiedKey(scope, message), message.isOutgoing === true, generateUUID()])
}

export function badgeStanzaKey(stanza: Element): string | undefined {
  try {
    let key = occurrences.get(stanza)
    if (key) return key
    key = qualified({
      id: stanza.attrs.id ?? '', from: stanza.attrs.from ?? '',
      roomJid: stanza.attrs.type === 'groupchat' ? getBareJid(stanza.attrs.from ?? '') : undefined,
      originId: stanza.getChild('origin-id', NS_STANZA_ID)?.attrs.id,
      occupantId: stanza.getChild('occupant-id', NS_OCCUPANT_ID)?.attrs.id,
      receivedAt: new Date(),
    })
    occurrences.set(stanza, key)
    return key
  } catch { return undefined }
}
