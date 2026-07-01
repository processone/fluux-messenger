import { describe, it, expect } from 'vitest'
import { decideReactionNotification } from './reactionNotificationDecision'

const ev = (over: Record<string, unknown> = {}) => ({
  conversationId: 'c1',
  messageId: 'm1',
  reactorName: 'Marie',
  emojis: ['❤️'],
  isLive: true,
  ...over,
})

describe('decideReactionNotification', () => {
  it('ignores non-live reactions (MAM replay)', () => {
    expect(
      decideReactionNotification(ev({ isLive: false }), {
        activeConversationId: 'c1',
        isLastMessage: false,
        isOwnOutgoing: true,
      }).kind,
    ).toBe('none')
  })

  it('ignores reactions on messages that are not our own outgoing', () => {
    expect(
      decideReactionNotification(ev(), {
        activeConversationId: null,
        isLastMessage: false,
        isOwnOutgoing: false,
      }).kind,
    ).toBe('none')
  })

  it('shows a toast when the conversation is not active', () => {
    expect(
      decideReactionNotification(ev(), {
        activeConversationId: 'other',
        isLastMessage: false,
        isOwnOutgoing: true,
      }).kind,
    ).toBe('toast')
  })

  it('shows an in-flow mention when active and the target is not the last message', () => {
    expect(
      decideReactionNotification(ev(), {
        activeConversationId: 'c1',
        isLastMessage: false,
        isOwnOutgoing: true,
      }).kind,
    ).toBe('mention')
  })

  it('shows nothing when active and the target IS the last message (badge suffices)', () => {
    expect(
      decideReactionNotification(ev(), {
        activeConversationId: 'c1',
        isLastMessage: true,
        isOwnOutgoing: true,
      }).kind,
    ).toBe('none')
  })

  it('ignores reactions with no emojis', () => {
    expect(
      decideReactionNotification(ev({ emojis: [] }), {
        activeConversationId: 'other',
        isLastMessage: false,
        isOwnOutgoing: true,
      }).kind,
    ).toBe('none')
  })

  it('shows toast when active conversation is null (no active conversation)', () => {
    expect(
      decideReactionNotification(ev(), {
        activeConversationId: null,
        isLastMessage: false,
        isOwnOutgoing: true,
      }).kind,
    ).toBe('toast')
  })
})
