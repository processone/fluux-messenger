import { describe, it, expect } from 'vitest'
import { isRenderableStoredMessage } from './messageRenderability'
import type { Message, RoomMessage } from '../core/types'

function chat(overrides: Partial<Message>): Message {
  return {
    type: 'chat',
    id: 'm1',
    conversationId: 'peer@example.com',
    from: 'peer@example.com',
    body: '',
    timestamp: new Date(),
    isOutgoing: false,
    ...overrides,
  } as Message
}

function room(overrides: Partial<RoomMessage>): RoomMessage {
  return {
    type: 'groupchat',
    id: 'r1',
    roomJid: 'room@conference.example.com',
    from: 'room@conference.example.com/alice',
    nick: 'alice',
    body: '',
    timestamp: new Date(),
    isOutgoing: false,
    ...overrides,
  } as RoomMessage
}

describe('isRenderableStoredMessage', () => {
  it('keeps a message with body text', () => {
    expect(isRenderableStoredMessage(chat({ body: 'hello' }))).toBe(true)
  })

  it('drops an empty-body message with no other content (the stale blank row)', () => {
    expect(isRenderableStoredMessage(chat({ body: '' }))).toBe(false)
    expect(isRenderableStoredMessage(room({ body: '' }))).toBe(false)
  })

  it('drops a whitespace-only body', () => {
    expect(isRenderableStoredMessage(chat({ body: '   \n ' }))).toBe(false)
  })

  it('keeps a retraction tombstone (empty body but isRetracted)', () => {
    expect(isRenderableStoredMessage(chat({ body: '', isRetracted: true }))).toBe(true)
  })

  it('keeps an empty-body message that carries an attachment', () => {
    expect(isRenderableStoredMessage(chat({ body: '', attachment: { url: 'https://x/y.png', filename: 'y.png' } as unknown as Message['attachment'] }))).toBe(true)
  })

  it('keeps a poll message with empty body', () => {
    expect(isRenderableStoredMessage(room({ body: '', poll: { title: 'Q?', options: [] } as unknown as RoomMessage['poll'] }))).toBe(true)
  })

  it('keeps a poll-closed announcement with empty body', () => {
    expect(isRenderableStoredMessage(room({ body: '', pollClosed: { pollMessageId: 'p1', title: 'Q?', results: [] } as unknown as RoomMessage['pollClosed'] }))).toBe(true)
  })

  it('keeps an encrypted-but-bodiless placeholder', () => {
    expect(isRenderableStoredMessage(chat({ body: '', encryptedPayload: '<encrypted/>' }))).toBe(true)
    expect(isRenderableStoredMessage(chat({ body: '', unsupportedEncryption: { namespace: 'eu.siacs.conversations.axolotl' } as unknown as Message['unsupportedEncryption'] }))).toBe(true)
  })
})
