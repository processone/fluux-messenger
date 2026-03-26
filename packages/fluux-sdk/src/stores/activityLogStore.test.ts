import { describe, it, expect, beforeEach } from 'vitest'
import { activityLogStore } from './activityLogStore'
import type { ActivityEventInput, ReactionReceivedPayload } from '../core/types/activity'

function makeReactionInput(conversationId: string, messageId: string): ActivityEventInput {
  return {
    type: 'reaction-received',
    kind: 'informational',
    timestamp: new Date(),
    payload: {
      type: 'reaction-received',
      conversationId,
      messageId,
      reactors: [{ reactorJid: 'alice@example.com', emojis: ['👍'] }],
    } as ReactionReceivedPayload,
  }
}

function makeNonReactionInput(): ActivityEventInput {
  return {
    type: 'subscription-request',
    kind: 'actionable',
    timestamp: new Date(),
    payload: {
      type: 'subscription-request',
      from: 'bob@example.com',
    },
  }
}

describe('activityLogStore — scoped reaction muting', () => {
  beforeEach(() => {
    activityLogStore.getState().reset()
  })

  it('non-reaction events always have muted: false', () => {
    const event = activityLogStore.getState().addEvent(makeNonReactionInput())
    expect(event.muted).toBe(false)
  })

  it('reaction events have muted: false when nothing is muted', () => {
    const event = activityLogStore.getState().addEvent(makeReactionInput('chat@example.com', 'msg-1'))
    expect(event.muted).toBe(false)
  })

  describe('muteReactionsForConversation', () => {
    it('re-stamps existing reaction events for that conversation', () => {
      activityLogStore.getState().addEvent(makeReactionInput('chat-a@example.com', 'msg-1'))
      activityLogStore.getState().addEvent(makeReactionInput('chat-b@example.com', 'msg-2'))

      activityLogStore.getState().muteReactionsForConversation('chat-a@example.com')

      const events = activityLogStore.getState().events
      const mutedEvent = events.find((e) =>
        (e.payload as ReactionReceivedPayload).conversationId === 'chat-a@example.com'
      )
      const unmutedEvent = events.find((e) =>
        (e.payload as ReactionReceivedPayload).conversationId === 'chat-b@example.com'
      )
      expect(mutedEvent?.muted).toBe(true)
      expect(unmutedEvent?.muted).toBe(false)
    })

    it('new reaction events from that conversation are muted', () => {
      activityLogStore.getState().muteReactionsForConversation('chat-a@example.com')
      const event = activityLogStore.getState().addEvent(makeReactionInput('chat-a@example.com', 'msg-3'))
      expect(event.muted).toBe(true)
    })

    it('does not affect non-reaction events', () => {
      activityLogStore.getState().addEvent(makeNonReactionInput())
      activityLogStore.getState().muteReactionsForConversation('bob@example.com')

      const events = activityLogStore.getState().events
      expect(events[0].muted).toBe(false)
    })
  })

  describe('unmuteReactionsForConversation', () => {
    it('re-stamps events back to unmuted', () => {
      activityLogStore.getState().addEvent(makeReactionInput('chat-a@example.com', 'msg-1'))
      activityLogStore.getState().muteReactionsForConversation('chat-a@example.com')
      expect(activityLogStore.getState().events[0].muted).toBe(true)

      activityLogStore.getState().unmuteReactionsForConversation('chat-a@example.com')
      expect(activityLogStore.getState().events[0].muted).toBe(false)
    })
  })

  describe('muteReactionsForMessage', () => {
    it('mutes events for that specific message only', () => {
      activityLogStore.getState().addEvent(makeReactionInput('chat-a@example.com', 'msg-1'))
      activityLogStore.getState().addEvent(makeReactionInput('chat-a@example.com', 'msg-2'))

      activityLogStore.getState().muteReactionsForMessage('msg-1')

      const events = activityLogStore.getState().events
      const msg1Event = events.find((e) =>
        (e.payload as ReactionReceivedPayload).messageId === 'msg-1'
      )
      const msg2Event = events.find((e) =>
        (e.payload as ReactionReceivedPayload).messageId === 'msg-2'
      )
      expect(msg1Event?.muted).toBe(true)
      expect(msg2Event?.muted).toBe(false)
    })

    it('new events for that message are muted', () => {
      activityLogStore.getState().muteReactionsForMessage('msg-1')
      const event = activityLogStore.getState().addEvent(makeReactionInput('chat-a@example.com', 'msg-1'))
      expect(event.muted).toBe(true)
    })
  })

  describe('unmuteReactionsForMessage', () => {
    it('re-stamps events back to unmuted', () => {
      activityLogStore.getState().addEvent(makeReactionInput('chat-a@example.com', 'msg-1'))
      activityLogStore.getState().muteReactionsForMessage('msg-1')
      expect(activityLogStore.getState().events[0].muted).toBe(true)

      activityLogStore.getState().unmuteReactionsForMessage('msg-1')
      expect(activityLogStore.getState().events[0].muted).toBe(false)
    })
  })

  describe('combined muting', () => {
    it('conversation mute covers all messages in that conversation', () => {
      activityLogStore.getState().muteReactionsForConversation('chat-a@example.com')
      const event = activityLogStore.getState().addEvent(makeReactionInput('chat-a@example.com', 'any-msg'))
      expect(event.muted).toBe(true)
    })

    it('message mute works independently of conversation mute', () => {
      activityLogStore.getState().muteReactionsForMessage('msg-1')
      const event = activityLogStore.getState().addEvent(makeReactionInput('chat-b@example.com', 'msg-1'))
      expect(event.muted).toBe(true)
    })
  })

  describe('isReactionMuted', () => {
    it('returns false when nothing is muted', () => {
      expect(activityLogStore.getState().isReactionMuted('chat-a@example.com', 'msg-1')).toBe(false)
    })

    it('returns true when conversation is muted', () => {
      activityLogStore.getState().muteReactionsForConversation('chat-a@example.com')
      expect(activityLogStore.getState().isReactionMuted('chat-a@example.com', 'any-msg')).toBe(true)
    })

    it('returns true when message is muted', () => {
      activityLogStore.getState().muteReactionsForMessage('msg-1')
      expect(activityLogStore.getState().isReactionMuted('any-chat', 'msg-1')).toBe(true)
    })
  })

  describe('pendingActionableCount', () => {
    it('counts only pending actionable events', () => {
      // Add two actionable events (subscription requests)
      activityLogStore.getState().addEvent(makeNonReactionInput())
      activityLogStore.getState().addEvent(makeNonReactionInput())
      expect(activityLogStore.getState().pendingActionableCount()).toBe(2)

      // Resolve one — count should drop
      const eventId = activityLogStore.getState().events[0].id
      activityLogStore.getState().resolveEvent(eventId, 'accepted')
      expect(activityLogStore.getState().pendingActionableCount()).toBe(1)
    })

    it('does not count informational events', () => {
      activityLogStore.getState().addEvent(makeReactionInput('chat-a@example.com', 'msg-1'))
      expect(activityLogStore.getState().pendingActionableCount()).toBe(0)
    })
  })
})
