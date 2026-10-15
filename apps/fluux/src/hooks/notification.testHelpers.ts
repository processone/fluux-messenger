import { chatStore, roomStore, connectionStore } from '@fluux/sdk/stores'
import type { Conversation, Message, Room, RoomMessage } from '@fluux/sdk'

export function resetNotificationFixtures(): void {
  chatStore.setState({ conversations: new Map(), conversationEntities: new Map(), conversationMeta: new Map(), messages: new Map(), lastArrivedMessage: new Map(), activeConversationId: null })
  roomStore.setState({ rooms: new Map(), roomEntities: new Map(), roomMeta: new Map(), roomRuntime: new Map(), messages: new Map(), lastArrivedMessage: new Map(), activeRoomJid: null })
  connectionStore.setState({ jid: 'me@example.com', windowVisible: false })
}

/** Transport tests start from an eligible arrival and can change its current copy during awaits. */
export function chatNotificationFixture(conversation: unknown, message: unknown): [Conversation, Message] {
  const conv = conversation as Partial<Conversation>
  const msg = message as Partial<Message>
  const id = conv.id ?? 'fixture@example.test'
  const full: Message = { type: 'chat', id: 'fixture-message', stanzaId: undefined, originId: undefined, body: 'fixture body', timestamp: new Date(), isOutgoing: false, from: id, ...msg, conversationId: id }
  chatStore.getState().addConversation({ id, name: 'Fixture', type: 'chat', unreadCount: 1, ...conv, lastMessage: full })
  chatStore.setState(state => ({ messages: new Map(state.messages).set(id, [full]), lastArrivedMessage: new Map(state.lastArrivedMessage).set(id, full) }))
  return [chatStore.getState().conversations.get(id)!, full]
}

export function roomNotificationFixture(room: unknown, message: unknown): [Room, RoomMessage] {
  const entity = room as Partial<Room>
  const msg = message as Partial<RoomMessage>
  const jid = entity.jid ?? 'fixture@conference.example.test'
  const full: RoomMessage = { type: 'groupchat', id: 'fixture-message', stanzaId: undefined, originId: undefined, occupantId: undefined, body: 'fixture body', timestamp: new Date(), isOutgoing: false, nick: 'bob', from: `${jid}/bob`, ...msg, roomJid: jid }
  roomStore.getState().addRoom({ jid, name: 'Fixture', nickname: 'me', joined: true, notifyAll: true, unreadCount: 1, mentionsCount: 0, isBookmarked: false, autojoin: false, occupants: new Map(), typingUsers: new Set(), ...entity, lastMessage: full })
  roomStore.setState(state => ({ messages: new Map(state.messages).set(jid, [full]), lastArrivedMessage: new Map(state.lastArrivedMessage).set(jid, full) }))
  return [roomStore.getState().rooms.get(jid)!, full]
}
