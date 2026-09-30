/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useNotificationEvents } from './useNotificationEvents'
import { roomStore } from '../stores/roomStore'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { ignoreStore } from '../stores/ignoreStore'
import { createRoom, createMessage } from '../stores/roomStore.testHelpers'
import type { Message, RoomMessage } from '../core/types'
import type { StoredRoomMessage } from '../core/types/message-internal'
import * as messageCache from '../utils/messageCache'

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return { ...actual, isMessageCacheAvailable: vi.fn().mockReturnValue(false), getRoomMessages: vi.fn().mockResolvedValue([]) }
})

const ROOM = 'tech@conference.example.com'
const CONTACT = 'alice@example.com'

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

async function deliverToRoom(
  message: RoomMessage,
  options: { isLiveArrival?: boolean; incrementUnread?: boolean } = {},
): Promise<void> {
  await act(async () => {
    await roomStore.getState().addMessage(ROOM, message, { isLiveArrival: true, ...options })
    await settle()
  })
}

// Explicit, increasing timestamps: two rows sharing a millisecond are ordered by
// sender, which would let the second delivery land before the first.
let clock = Date.now() - 60_000
const mention = (id: string, nick: string, extra: Partial<RoomMessage> = {}): RoomMessage => ({
  ...createMessage(id, ROOM, nick, 'hey @testuser', false, new Date((clock += 1000))),
  isMention: true,
  ...extra,
})

describe('notifications for what the user cannot see', () => {
  beforeEach(() => {
    vi.mocked(messageCache.isMessageCacheAvailable).mockReturnValue(false)
    vi.mocked(messageCache.getRoomMessages).mockResolvedValue([])
    clock = Date.now() - 60_000
    connectionStore.setState({ windowVisible: false })
    roomStore.setState({
      rooms: new Map(), roomEntities: new Map(), roomMeta: new Map(), roomRuntime: new Map(),
      messages: new Map(), lastArrivedMessage: new Map(), activeRoomJid: null,
      windowAtLiveEdge: new Map(), pendingRetractions: new Map(),
    })
    chatStore.setState({
      conversations: new Map(), conversationEntities: new Map(), conversationMeta: new Map(),
      messages: new Map(), lastArrivedMessage: new Map(), activeConversationId: null,
    })
    ignoreStore.setState({ ignoredUsers: {} })
    roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
  })

  afterEach(() => cleanup())

  describe('rooms', () => {
    it('notifies for a live mention (control)', async () => {
      const onRoomMessage = vi.fn()
      renderHook(() => useNotificationEvents({ onRoomMessage }))

      await deliverToRoom(mention('m1', 'bob'))

      expect(onRoomMessage).toHaveBeenCalledTimes(1)
    })

    it.each([
      { atLiveEdge: true, noLocalStore: true, notifications: 1 },
      { atLiveEdge: true, noLocalStore: false, notifications: 1 },
      { atLiveEdge: false, noLocalStore: true, notifications: 0 },
      { atLiveEdge: false, noLocalStore: false, notifications: 1 },
    ])('handles a nick-change notice (live edge: $atLiveEdge, transient: $noLocalStore)', async ({ atLiveEdge, noLocalStore, notifications }) => {
      const onRoomMessage = vi.fn()
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true, notifyAll: true }))
      await deliverToRoom(mention('sys1', 'alice'))
      roomStore.setState({ windowAtLiveEdge: new Map([[ROOM, atLiveEdge]]) })
      renderHook(() => useNotificationEvents({ onRoomMessage }))

      const notice: StoredRoomMessage = {
        ...createMessage('sys1', ROOM, 'bob', ''),
        noLocalStore,
        systemEvent: { kind: 'nick-changed', oldNick: 'bob', newNick: 'bobby' },
      }
      await deliverToRoom(notice, { incrementUnread: false })

      const arrival = roomStore.getState().lastArrivedMessage.get(ROOM)
      expect(arrival?.systemEvent).toEqual(notice.systemEvent)
      expect(roomStore.getState().messages.get(ROOM)?.includes(arrival!)).toBe(atLiveEdge)
      expect(onRoomMessage).toHaveBeenCalledTimes(notifications)
    })

    it('stays silent for a mention from an ignored occupant', async () => {
      const onRoomMessage = vi.fn()
      ignoreStore.getState().addIgnored(ROOM, { identifier: 'spammer', displayName: 'spammer' })
      renderHook(() => useNotificationEvents({ onRoomMessage }))

      await deliverToRoom(mention('m1', 'spammer'), { incrementUnread: false })

      expect(onRoomMessage).not.toHaveBeenCalled()
    })

    it('stays silent for a reply that quotes an ignored occupant', async () => {
      const onRoomMessage = vi.fn()
      ignoreStore.getState().addIgnored(ROOM, { identifier: 'spammer', displayName: 'spammer' })
      renderHook(() => useNotificationEvents({ onRoomMessage }))

      const reply = mention('m1', 'bob', { replyTo: { id: 'orig', to: `${ROOM}/spammer` } })
      await deliverToRoom(reply, { incrementUnread: false })

      expect(onRoomMessage).not.toHaveBeenCalled()
    })

    it.each([false, true])('notifies for a visible retraction placeholder (moderated: %s)', async (isModerated) => {
      const onRoomMessage = vi.fn()
      renderHook(() => useNotificationEvents({ onRoomMessage }))

      await deliverToRoom(mention('m1', 'bob', {
        isRetracted: true, isModerated, moderationReason: 'off topic', body: '',
      }))

      expect(onRoomMessage).toHaveBeenCalledTimes(1)
    })

    it('stays silent for a hidden spam tombstone', async () => {
      const onRoomMessage = vi.fn()
      renderHook(() => useNotificationEvents({ onRoomMessage }))

      await deliverToRoom(mention('spam1', 'bob', {
        isRetracted: true, isModerated: true, moderationReason: ' Spam ', body: '',
      }))

      expect(onRoomMessage).not.toHaveBeenCalled()
    })

    it('does not replay a visible arrival while reopening a small cached room', async () => {
      const onRoomMessage = vi.fn()
      connectionStore.setState({ windowVisible: true })
      roomStore.getState().setActiveRoom(ROOM)
      renderHook(() => useNotificationEvents({ onRoomMessage }))

      await deliverToRoom(mention('visible1', 'bob'))
      expect(onRoomMessage).not.toHaveBeenCalled()
      const cached = roomStore.getState().messages.get(ROOM)!.map(message => ({ ...message }))

      act(() => roomStore.getState().setActiveRoom(null))
      expect(roomStore.getState().messages.get(ROOM)).toHaveLength(0)
      vi.mocked(messageCache.isMessageCacheAvailable).mockReturnValue(true)
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue(cached)
      await act(async () => { await roomStore.getState().activateRoom(ROOM) })

      expect(roomStore.getState().messages.get(ROOM)).toHaveLength(1)
      expect(onRoomMessage).not.toHaveBeenCalled()
      vi.mocked(messageCache.isMessageCacheAvailable).mockReturnValue(false)
      connectionStore.setState({ windowVisible: false })
      await deliverToRoom(mention('new1', 'bob'))
      expect(onRoomMessage).toHaveBeenCalledTimes(1)
      expect(onRoomMessage.mock.calls[0][1].id).toBe('new1')
    })

    it.each([false, true])('consumes arrivals without a message handler (read handler: %s)', async (hasReadHandler) => {
      const onRoomMessage = vi.fn()
      const { rerender } = renderHook(({ enabled }) => useNotificationEvents({
        onRoomMessage: enabled ? onRoomMessage : undefined,
        onRoomRead: hasReadHandler ? vi.fn() : undefined,
      }), { initialProps: { enabled: false } })
      await deliverToRoom(mention('unhandled1', 'bob'))

      rerender({ enabled: true })
      act(() => roomStore.setState({ activationPending: false }))
      expect(onRoomMessage).not.toHaveBeenCalled()

      await deliverToRoom(mention('handled1', 'bob'))
      expect(onRoomMessage).toHaveBeenCalledTimes(1)
    })

    it('does not replay arrivals already present when the hook mounts', async () => {
      await deliverToRoom(mention('before-mount', 'bob'))
      const onRoomMessage = vi.fn()
      renderHook(() => useNotificationEvents({ onRoomMessage }))

      act(() => roomStore.setState({ activationPending: false }))
      expect(onRoomMessage).not.toHaveBeenCalled()

      await deliverToRoom(mention('after-mount', 'bob'))
      expect(onRoomMessage).toHaveBeenCalledTimes(1)
    })

    it('notifies for a live arrival while the resident window is parked', async () => {
      const onRoomMessage = vi.fn()
      roomStore.setState({ windowAtLiveEdge: new Map([[ROOM, false]]) })
      renderHook(() => useNotificationEvents({ onRoomMessage }))

      await deliverToRoom(mention('parked1', 'bob'))

      expect(roomStore.getState().messages.get(ROOM) ?? []).toHaveLength(0)
      expect(onRoomMessage).toHaveBeenCalledTimes(1)
    })

    it('notifies for separate live rows sharing a client message id', async () => {
      const onRoomMessage = vi.fn()
      renderHook(() => useNotificationEvents({ onRoomMessage }))

      await deliverToRoom(mention('shared-id', 'bob'))
      await deliverToRoom(mention('shared-id', 'alice'))

      expect(onRoomMessage).toHaveBeenCalledTimes(2)
    })

    it('stays silent for an undecrypted bodiless stanza in a notify-all room', async () => {
      const onRoomMessage = vi.fn()
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true, notifyAll: true }))
      renderHook(() => useNotificationEvents({ onRoomMessage }))

      await deliverToRoom({ ...createMessage('enc1', ROOM, 'bob', ''), body: '' })

      expect(onRoomMessage).not.toHaveBeenCalled()
    })

    it('stays silent for a fresh mention that was fetched, not delivered', async () => {
      const onRoomMessage = vi.fn()
      renderHook(() => useNotificationEvents({ onRoomMessage }))

      await deliverToRoom(mention('m1', 'bob'), { isLiveArrival: false, incrementUnread: false })

      expect(onRoomMessage).not.toHaveBeenCalled()
    })

    it('still notifies for a visible message after an ignored one', async () => {
      const onRoomMessage = vi.fn()
      ignoreStore.getState().addIgnored(ROOM, { identifier: 'spammer', displayName: 'spammer' })
      renderHook(() => useNotificationEvents({ onRoomMessage }))

      await deliverToRoom(mention('m1', 'spammer'), { incrementUnread: false })
      await deliverToRoom(mention('m2', 'bob'))

      expect(onRoomMessage).toHaveBeenCalledTimes(1)
      expect(onRoomMessage.mock.calls[0][1].id).toBe('m2')
    })
  })

  describe('conversations', () => {
    const incoming = (id: string): Message => ({
      type: 'chat',
      id,
      stanzaId: undefined,
      originId: undefined,
      conversationId: CONTACT,
      from: CONTACT,
      body: 'hello',
      timestamp: new Date(),
      isOutgoing: false,
    })

    beforeEach(() => {
      chatStore.getState().addConversation({ id: CONTACT, name: 'Alice', type: 'chat', unreadCount: 0 })
    })

    it('notifies for a live message (control)', async () => {
      const onConversationMessage = vi.fn()
      renderHook(() => useNotificationEvents({ onConversationMessage }))

      await act(async () => { chatStore.getState().addMessage(incoming('c1')); await settle() })

      expect(onConversationMessage).toHaveBeenCalledTimes(1)
    })
  })
})
