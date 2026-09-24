import type { Message, RoomMessage } from '../../index'

// Every identity key is present on a message, even when its value is absent. A
// construction or projection that drops one must not compile.

const timestamp = new Date(0)

const chat: Message = {
  type: 'chat', id: 'client', stanzaId: undefined, originId: undefined,
  conversationId: 'peer@example.com', from: 'peer@example.com', body: '', timestamp, isOutgoing: false,
}

const room: RoomMessage = {
  type: 'groupchat', id: 'client', stanzaId: undefined, originId: undefined, occupantId: undefined,
  roomJid: 'room@conference.example.com', from: 'room@conference.example.com/peer', nick: 'peer', body: '',
  timestamp, isOutgoing: false,
}

// @ts-expect-error stanzaId is required on Message
const chatWithoutStanzaId: Message = {
  type: 'chat', id: 'client', originId: undefined,
  conversationId: 'peer@example.com', from: 'peer@example.com', body: '', timestamp, isOutgoing: false,
}

// @ts-expect-error originId is required on Message
const chatWithoutOriginId: Message = {
  type: 'chat', id: 'client', stanzaId: undefined,
  conversationId: 'peer@example.com', from: 'peer@example.com', body: '', timestamp, isOutgoing: false,
}

// @ts-expect-error stanzaId is required on RoomMessage
const roomWithoutStanzaId: RoomMessage = {
  type: 'groupchat', id: 'client', originId: undefined, occupantId: undefined,
  roomJid: 'room@conference.example.com', from: 'room@conference.example.com/peer', nick: 'peer', body: '',
  timestamp, isOutgoing: false,
}

// @ts-expect-error originId is required on RoomMessage
const roomWithoutOriginId: RoomMessage = {
  type: 'groupchat', id: 'client', stanzaId: undefined, occupantId: undefined,
  roomJid: 'room@conference.example.com', from: 'room@conference.example.com/peer', nick: 'peer', body: '',
  timestamp, isOutgoing: false,
}

// @ts-expect-error occupantId is required on RoomMessage
const roomWithoutOccupantId: RoomMessage = {
  type: 'groupchat', id: 'client', stanzaId: undefined, originId: undefined,
  roomJid: 'room@conference.example.com', from: 'room@conference.example.com/peer', nick: 'peer', body: '',
  timestamp, isOutgoing: false,
}

// A projection that strips a tier and rebuilds the message is rejected too.
const { occupantId: _strippedOccupantId, ...roomWithoutOccupant } = room
// @ts-expect-error the rebuilt room message lost its occupantId
const rebuiltRoom: RoomMessage = roomWithoutOccupant

// Forwarding a field that may be absent keeps the key, so it type-checks.
declare const hit: { stanzaId?: string; originId?: string }
const projected: Message = { ...chat, stanzaId: hit.stanzaId, originId: hit.originId }

void [chatWithoutStanzaId, chatWithoutOriginId, roomWithoutStanzaId, roomWithoutOriginId, roomWithoutOccupantId, rebuiltRoom, projected]
