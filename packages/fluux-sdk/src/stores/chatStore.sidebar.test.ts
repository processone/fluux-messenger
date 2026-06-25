import { describe, it, expect, beforeEach } from 'vitest'
import { chatStore } from './chatStore'
import type { Conversation } from '../core/types/chat'

// Minimal conversation for the sidebar-id selectors, which read only id +
// lastMessage.timestamp (+ the archived set).
const conv = (id: string, lastMessageTime?: number): Conversation =>
  ({
    id,
    name: id.split('@')[0],
    type: 'chat',
    unreadCount: 0,
    lastMessage: lastMessageTime != null ? ({ timestamp: new Date(lastMessageTime) } as Conversation['lastMessage']) : undefined,
  }) as Conversation

describe('chatStore conversation sidebar id selectors', () => {
  beforeEach(() => {
    chatStore.setState({ conversations: new Map(), archivedConversations: new Set() })
  })

  it('conversationSidebarIds returns active ids sorted by last activity (most recent first)', () => {
    chatStore.setState({
      conversations: new Map([
        ['a@x', conv('a@x', 1000)],
        ['b@x', conv('b@x', 3000)],
        ['c@x', conv('c@x', 2000)],
      ]),
    })
    expect(chatStore.getState().conversationSidebarIds()).toEqual(['b@x', 'c@x', 'a@x'])
  })

  it('conversationSidebarIds excludes archived conversations', () => {
    chatStore.setState({
      conversations: new Map([
        ['a@x', conv('a@x', 1000)],
        ['b@x', conv('b@x', 2000)],
      ]),
      archivedConversations: new Set(['b@x']),
    })
    expect(chatStore.getState().conversationSidebarIds()).toEqual(['a@x'])
  })

  it('archivedConversationSidebarIds returns only archived ids, sorted', () => {
    chatStore.setState({
      conversations: new Map([
        ['a@x', conv('a@x', 1000)],
        ['b@x', conv('b@x', 2000)],
        ['c@x', conv('c@x', 3000)],
      ]),
      archivedConversations: new Set(['a@x', 'c@x']),
    })
    expect(chatStore.getState().archivedConversationSidebarIds()).toEqual(['c@x', 'a@x'])
  })

  it('returns a referentially-stable empty array when there are no conversations', () => {
    const a = chatStore.getState().conversationSidebarIds()
    const b = chatStore.getState().conversationSidebarIds()
    expect(a).toEqual([])
    expect(a).toBe(b) // stable identity so useShallow consumers never re-render
  })

  it('content is equal across a non-reordering change (so useShallow bails)', () => {
    chatStore.setState({
      conversations: new Map([
        ['a@x', conv('a@x', 5000)],
        ['b@x', conv('b@x', 1000)],
      ]),
    })
    const before = chatStore.getState().conversationSidebarIds()
    // A new message to `a` (already newest) bumps its timestamp but does not reorder.
    chatStore.setState({
      conversations: new Map([
        ['a@x', conv('a@x', 6000)],
        ['b@x', conv('b@x', 1000)],
      ]),
    })
    expect(chatStore.getState().conversationSidebarIds()).toEqual(before)
  })
})
