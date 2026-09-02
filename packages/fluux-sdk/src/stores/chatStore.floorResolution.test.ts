/**
 * A floor read pointer naming the NEWEST message, driven through the REAL
 * chatStore rather than the pure `notificationState` helpers.
 *
 * The pure pass (`shared/notificationState.test.ts`, "resolves a floor onto the
 * message it names") proves the rule. This file proves the WIRING it depends
 * on: `advanceReadPointer` commits on a reference check, so a resolution that
 * handed back the same object would be silently dropped, and the symptom —
 * "Nouveaux messages" back at every reopen — would survive a green unit test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatStore } from './chatStore'
import { connectionStore } from './connectionStore'
import type { Message, Conversation } from '../core'
import type { ReadPointer } from './shared/readPointer'
import { _clearAllTransientForTesting } from './shared/transientUnread'

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessages: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    getMessagesAround: vi.fn().mockResolvedValue([]),
  }
})

const CID = 'alice@example.com'

function msg(id: string, minute: number): Message {
  return {
    type: 'chat',
    id,
    conversationId: CID,
    from: CID,
    body: id,
    timestamp: new Date(`2025-01-15T09:${String(minute).padStart(2, '0')}:00Z`),
    isOutgoing: false,
  }
}

const MESSAGES = [msg('m1', 1), msg('m2', 2)]

/**
 * A keyless pointer from the #1081 migration of the legacy
 * `lastSeenMessageId` + `lastReadAt` pair carries `lastReadAt` as the floor's
 * millisecond. It is not the named message's own timestamp, and this fixture
 * names the newest message in the conversation.
 */
const FLOOR_ON_NEWEST: ReadPointer = {
  order: { role: 'floor', timestamp: new Date('2025-01-15T09:01:30Z').getTime() },
  identity: { state: 'local', messageId: 'm2' },
}

function seed(): void {
  const conversation: Conversation = { id: CID, name: 'alice', type: 'chat', unreadCount: 1 }
  chatStore.setState({
    conversations: new Map([[CID, conversation]]),
    conversationMeta: new Map([[CID, { unreadCount: 1, readPointer: FLOOR_ON_NEWEST }]]),
    messages: new Map([[CID, MESSAGES]]),
    firstNewMessageMarkers: new Map(),
    activeConversationId: null,
  })
}

function dividerAfterOpening(): string | undefined {
  chatStore.getState().setActiveConversation(CID)
  return chatStore.getState().firstNewMessageMarkers.get(CID)?.id
}

describe('chatStore — a floor pointer naming the newest message', () => {
  beforeEach(() => {
    _clearAllTransientForTesting()
    connectionStore.setState({ windowVisible: true })
    seed()
  })

  it('stops re-showing the divider once the named message has been read', () => {
    // Opening puts the divider on the very message the pointer names: the
    // counting rule is at-or-after, so that message reads as unread.
    expect(dividerAfterOpening()).toBe('m2')

    // This viewport report resolves the floor onto its named message.
    chatStore.getState().advanceReadPointer(CID, { id: 'm2' })

    const pointer = chatStore.getState().conversationMeta.get(CID)?.readPointer
    expect(pointer?.identity.messageId).toBe('m2') // still the same message
    expect(pointer?.order.role).toBe('exact')

    // Leave, clear the line, come back.
    chatStore.getState().clearFirstNewMessageId(CID)
    chatStore.getState().setActiveConversation(null)
    expect(dividerAfterOpening()).toBeUndefined()
  })

  // The invariant the resolution has to keep: it makes a position exact, it
  // never relocates it. A pointer naming any other message moves a forward-only
  // position, which is unrecoverable.
  it('leaves the pointer on the message it named — never on another one', () => {
    chatStore.getState().setActiveConversation(CID)
    chatStore.getState().advanceReadPointer(CID, { id: 'm2' })
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('m2')

    // A second report is a no-op: the pointer is exact now and settles.
    const settled = chatStore.getState().conversationMeta.get(CID)?.readPointer
    chatStore.getState().advanceReadPointer(CID, { id: 'm2' })
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBe(settled)
  })
})
