import { describe, it, expect, beforeEach } from 'vitest'
import { reactionMentionStore } from './reactionMentionStore'

const m = (over = {}) => ({ id: 'c1:msg1', conversationId: 'c1', messageId: 'msg1', reactorName: 'Marie', emoji: '❤️', preview: 'hi', ...over })

describe('reactionMentionStore', () => {
  beforeEach(() => reactionMentionStore.getState().clearConversation('c1'))

  it('adds a mention and reads it back by conversation', () => {
    reactionMentionStore.getState().addMention(m())
    expect(reactionMentionStore.getState().mentions.get('c1')?.length).toBe(1)
  })
  it('de-dupes by id (latest wins) instead of stacking duplicates', () => {
    reactionMentionStore.getState().addMention(m({ emoji: '❤️' }))
    reactionMentionStore.getState().addMention(m({ emoji: '👍' }))
    const list = reactionMentionStore.getState().mentions.get('c1')!
    expect(list.length).toBe(1)
    expect(list[0].emoji).toBe('👍')
  })
  it('dismisses a mention', () => {
    reactionMentionStore.getState().addMention(m())
    reactionMentionStore.getState().dismissMention('c1', 'c1:msg1')
    expect(reactionMentionStore.getState().mentions.get('c1')?.length ?? 0).toBe(0)
  })
})
