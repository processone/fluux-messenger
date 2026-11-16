import { describe, expect, it } from 'vitest'
import { xml } from '@xmpp/client'
import { badgeMessageKey, badgeStanzaKey } from './badgeIdentity'

// Intent: badge traces must not combine different senders or occurrences that
// reuse a client id, and observation must not change a protocol/store object.
describe('badge processing occurrence correlation', () => {
  const stanza = (from: string, occupant: string) => xml('message', { id: 'shared-id', from, type: 'groupchat' },
    xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: occupant }), xml('body', {}, 'A room message'))

  it('distinguishes senders, reassigned nicknames and otherwise identical occurrences', () => {
    const first = stanza('team@conference.example.test/writer', 'occupant-a')
    const otherSender = stanza('team@conference.example.test/other', 'occupant-b')
    const reassigned = stanza('team@conference.example.test/writer', 'occupant-c')
    const repeated = stanza('team@conference.example.test/writer', 'occupant-a')
    const keys = [first, otherSender, reassigned, repeated].map(badgeStanzaKey)
    expect(keys.every(Boolean)).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
    expect(badgeStanzaKey(first)).toBe(keys[0])
  })

  it('carries one stanza occurrence into its parsed message without adding message fields', () => {
    const wire = stanza('team@conference.example.test/writer', 'occupant-a')
    const message = { id: 'shared-id', from: wire.attrs.from, roomJid: 'team@conference.example.test', occupantId: 'occupant-a', receivedAt: new Date(), body: 'A room message' }
    const before = Reflect.ownKeys(message)
    const serialized = JSON.stringify(message)
    expect(badgeMessageKey(message, wire)).toBe(badgeStanzaKey(wire))
    expect(badgeMessageKey(message)).toBe(badgeStanzaKey(wire))
    expect(Reflect.ownKeys(message)).toEqual(before)
    expect(JSON.stringify(message)).toBe(serialized)
    // Deferred recovery parses a fresh stanza but still owns this same source row.
    const retry = stanza('team@conference.example.test/writer', 'occupant-a')
    expect(badgeMessageKey(message, retry)).toBe(badgeStanzaKey(wire))
    expect(badgeStanzaKey(retry)).toBe(badgeStanzaKey(wire))
  })

  it('does not combine incoming and outgoing chats that reuse an id', () => {
    const incoming = { id: 'shared-id', from: 'peer@example.test', isOutgoing: false }
    const outgoing = { id: 'shared-id', from: 'self@example.test', isOutgoing: true }
    expect(badgeMessageKey(incoming)).not.toBe(badgeMessageKey(outgoing))
  })
})
