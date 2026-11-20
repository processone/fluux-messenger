import { describe, it, expect } from 'vitest'
import { buildSavedMessage, canSaveMessage } from './savedMessageBuilder'
import type { Message } from '../core/types/chat'
import type { RoomMessage } from '../core/types/room'

const OWN = 'romeo@montague.example/phone'
const chat = (extra: Partial<Message> = {}): Message => ({
  type: 'chat', id: 'm1', conversationId: 'juliet@capulet.example', from: 'juliet@capulet.example/balcony',
  body: 'hi', timestamp: new Date(1000), isOutgoing: false, stanzaId: 's1', originId: undefined, ...extra,
})
const room = (extra: Partial<RoomMessage> = {}): RoomMessage => ({
  type: 'groupchat', id: 'r1', roomJid: 'team@conference.example', nick: 'Alice', from: 'team@conference.example/Alice',
  body: 'hello', timestamp: new Date(2000), isOutgoing: false, stanzaId: 'rs1', originId: 'ro1', occupantId: 'occ', ...extra,
})

describe('buildSavedMessage', () => {
  it('names a room message by the room archive id and keeps the occupant id', () => {
    const entry = buildSavedMessage(room(), OWN, 5)
    expect(entry).toMatchObject({ conversationJid: 'team@conference.example', type: 'groupchat', from: 'team@conference.example/Alice',
      stanzaId: 'rs1', stanzaIdBy: 'team@conference.example', occupantId: 'occ', text: 'hello', savedAt: 5, sentAt: 2000 })
  })

  it('names a chat message by the account archive and addresses it from/to the account', () => {
    expect(buildSavedMessage(chat({ ownArchiveId: 's1', ownArchiveBy: 'romeo@montague.example' }), OWN))
      .toMatchObject({ from: 'juliet@capulet.example', to: 'romeo@montague.example', stanzaId: 's1', stanzaIdBy: 'romeo@montague.example' })
    // An archive id stamped by a foreign archive is never relabelled as the account's own.
    expect(buildSavedMessage(chat({ stanzaId: 's1' }), OWN).stanzaId).toBeUndefined()
    expect(buildSavedMessage(chat({ isOutgoing: true }), OWN)).toMatchObject({ from: 'romeo@montague.example', to: 'juliet@capulet.example' })
  })

  it('keeps the text of an encrypted message this device decrypted, and none for one still waiting for its key; at most 4000 characters', () => {
    expect(buildSavedMessage(chat({ encryptedPayload: '<x/>', body: '' }), OWN)).toMatchObject({ text: '', encrypted: true })
    expect(buildSavedMessage(chat({ securityContext: { kind: 'encrypted' } as never, body: 'decrypted text' }), OWN))
      .toMatchObject({ text: 'decrypted text', encrypted: true })
    expect(Array.from(buildSavedMessage(chat({ body: 'é'.repeat(5000) }), OWN).text)).toHaveLength(4000)
  })

  it('gives the same id on two devices and for the same message later learning its archive id', () => {
    expect(buildSavedMessage(room(), OWN, 1).id).toBe(buildSavedMessage(room(), OWN, 99).id)
  })
})

describe('canSaveMessage', () => {
  it('offers nothing for pending or failed outgoing messages, whispers and deleted messages', () => {
    expect(canSaveMessage(chat())).toBe(true)
    expect(canSaveMessage(chat({ isOutgoing: true, stanzaId: undefined, originId: undefined }))).toBe(false)
    expect(canSaveMessage(chat({ isOutgoing: true, deliveryError: { condition: 'x' } as never }))).toBe(false)
    expect(canSaveMessage(room({ isPrivate: true }))).toBe(false)
    expect(canSaveMessage(chat({ isRetracted: true }))).toBe(false)
  })
})
