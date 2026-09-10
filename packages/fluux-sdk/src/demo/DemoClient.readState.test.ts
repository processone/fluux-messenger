/**
 * Demo-mode read state.
 *
 * `populateDemo` replays a whole archive through the live-arrival path, and a 1:1
 * arrival increments the badge even when it is delayed (offline delivery — see
 * `notificationState.onMessageReceived`'s `treatDelayedAsNew`). So the seed has to
 * establish a read position of its own: without one every seeded message lands in
 * the badge, and a pointerless entity carrying a live-accumulated count stands every
 * archive recount down (`pointerless-defer`), so nothing corrects it afterwards.
 *
 * `Conversation.unreadCount` / `Room.unreadCount` is the demo author's intent, and
 * these tests hold `populateDemo` to it: that many incoming messages after the
 * pointer, and the pointer naming the message before them.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { DemoClient } from './DemoClient'
import { chatStore } from '../stores/chatStore'
import { roomStore } from '../stores/roomStore'
import type { DemoData } from './types'
import type { Message, Conversation } from '../core/types/chat'
import type { Room, RoomMessage } from '../core/types/room'

const SELF = 'you@fluux.chat'
const PEER = 'emma@fluux.chat'
const ROOM_JID = 'team@conference.fluux.chat'

function makeClient(): DemoClient {
  const client = new DemoClient()
  ;(client as unknown as { currentJid: string | null }).currentJid = SELF
  ;(client as unknown as { selfJid: string }).selfJid = SELF
  return client
}

/** `count` alternating peer/own messages, oldest first, one minute apart. */
function chatHistory(count: number, incomingOnly = false): Message[] {
  const base = Date.now() - count * 60_000
  return Array.from({ length: count }, (_, i) => ({
    type: 'chat' as const,
    id: `m-${i + 1}`,
    from: incomingOnly || i % 2 === 0 ? PEER : SELF,
    body: `message ${i + 1}`,
    timestamp: new Date(base + i * 60_000),
    isOutgoing: incomingOnly ? false : i % 2 !== 0,
    conversationId: PEER,
  }))
}

function roomHistory(count: number): RoomMessage[] {
  const base = Date.now() - count * 60_000
  return Array.from({ length: count }, (_, i) => ({
    type: 'groupchat' as const,
    id: `r-${i + 1}`,
    from: `${ROOM_JID}/emma`,
    nick: 'emma',
    body: `room message ${i + 1}`,
    timestamp: new Date(base + i * 60_000),
    isOutgoing: false,
    roomJid: ROOM_JID,
  }))
}

function demoData(conversation: Conversation, messages: Message[], rooms: DemoData['rooms'] = []): DemoData {
  return {
    self: { jid: SELF, nick: 'You', domain: 'fluux.chat' },
    contacts: [],
    presences: [],
    conversations: [conversation],
    messages: new Map([[conversation.id, messages]]),
    rooms,
  }
}

function conversation(unreadCount: number): Conversation {
  return { id: PEER, name: 'Emma Wilson', type: 'chat', unreadCount }
}

function room(unreadCount: number, messages: RoomMessage[]): DemoData['rooms'][number] {
  const value: Room = {
    jid: ROOM_JID,
    name: 'Team Chat',
    joined: true,
    unreadCount,
    mentionsCount: 0,
  } as Room
  return { room: value, occupants: [], messages }
}

describe('DemoClient seeded read state', () => {
  beforeEach(() => {
    chatStore.setState({
      conversationEntities: new Map(),
      conversationMeta: new Map(),
      messages: new Map(),
      firstNewMessageMarkers: new Map(),
      conversationCoverage: new Map(),
      activeConversationId: null,
    })
    roomStore.setState({
      roomEntities: new Map(),
      roomMeta: new Map(),
      messages: new Map(),
      firstNewMessageMarkers: new Map(),
      roomCoverage: new Map(),
      activeRoomJid: null,
    })
  })

  it('leaves exactly the seeded number of messages unread', () => {
    const messages = chatHistory(10, true)
    makeClient().populateDemo(demoData(conversation(2), messages))

    const meta = chatStore.getState().conversationMeta.get(PEER)
    expect(meta?.unreadCount).toBe(2)
  })

  it('anchors the read pointer on the message before the unread tail', () => {
    const messages = chatHistory(10, true)
    makeClient().populateDemo(demoData(conversation(2), messages))

    const meta = chatStore.getState().conversationMeta.get(PEER)
    // 10 incoming messages, 2 unread: the pointer names the 8th.
    expect(meta?.readPointer?.identity.messageId).toBe('m-8')
  })

  it('marks a conversation seeded with no unread read to its newest message', () => {
    const messages = chatHistory(6)
    makeClient().populateDemo(demoData(conversation(0), messages))

    const meta = chatStore.getState().conversationMeta.get(PEER)
    expect(meta?.unreadCount).toBe(0)
    expect(meta?.readPointer?.identity.messageId).toBe('m-6')
  })

  it('skips own messages when placing the boundary', () => {
    // Alternating peer/own; the last two INCOMING are m-7 and m-9, so a
    // two-unread seed reads through m-6 (the message before m-7).
    const messages = chatHistory(10)
    makeClient().populateDemo(demoData(conversation(2), messages))

    const meta = chatStore.getState().conversationMeta.get(PEER)
    expect(meta?.unreadCount).toBe(2)
    expect(meta?.readPointer?.identity.messageId).toBe('m-6')
  })

  it('covers the seeded archive so a recount derives rather than defers', () => {
    const messages = chatHistory(10, true)
    makeClient().populateDemo(demoData(conversation(2), messages))

    // Coverage is what stops `recomputeUnreadForConversation` standing down on
    // `coverage-missing`; the seeded archive is contiguous by construction.
    const record = chatStore.getState().conversationCoverage.get(PEER)
    expect(record?.bottomId).toBe('sid-m-1')
    expect(record?.topId).toBe('sid-m-10')
  })

  it('leaves the divider to activation rather than parking one at seed time', () => {
    // The divider is derived from the read pointer when the conversation is
    // opened (`notifState.onActivate`); a seed that parked one would show it in
    // a conversation the reader has not entered.
    makeClient().populateDemo(demoData(conversation(3), chatHistory(10, true)))

    expect(chatStore.getState().firstNewMessageMarkers.has(PEER)).toBe(false)
  })

  it('seeds room read state from the room unread count', () => {
    const messages = roomHistory(8)
    makeClient().populateDemo(demoData(conversation(0), chatHistory(2), [room(2, messages)]))

    const meta = roomStore.getState().roomMeta.get(ROOM_JID)
    expect(meta?.unreadCount).toBe(2)
    expect(meta?.readPointer?.identity.messageId).toBe('r-6')
  })

  it('marks a room seeded with no unread read to its newest message', () => {
    const messages = roomHistory(8)
    makeClient().populateDemo(demoData(conversation(0), chatHistory(2), [room(0, messages)]))

    const meta = roomStore.getState().roomMeta.get(ROOM_JID)
    expect(meta?.unreadCount).toBe(0)
    expect(meta?.readPointer?.identity.messageId).toBe('r-8')
  })
})
