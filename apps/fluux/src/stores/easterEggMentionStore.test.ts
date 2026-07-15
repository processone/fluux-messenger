import { describe, it, expect, beforeEach } from 'vitest'
import { useEasterEggMentionStore } from './easterEggMentionStore'

const egg = (conversationId: string, animation: string, senderName = 'ava') => ({
  id: conversationId, conversationId, animation, senderName,
})

describe('easterEggMentionStore', () => {
  beforeEach(() => useEasterEggMentionStore.setState({ mentions: new Map() }))

  it('adds a pending egg', () => {
    useEasterEggMentionStore.getState().add(egg('a@x', 'fireworks'))
    expect(useEasterEggMentionStore.getState().mentions.get('a@x')?.animation).toBe('fireworks')
  })

  it('latest egg wins per conversation', () => {
    useEasterEggMentionStore.getState().add(egg('a@x', 'fireworks'))
    useEasterEggMentionStore.getState().add(egg('a@x', 'christmas'))
    expect(useEasterEggMentionStore.getState().mentions.size).toBe(1)
    expect(useEasterEggMentionStore.getState().mentions.get('a@x')?.animation).toBe('christmas')
  })

  it('dismiss removes the conversation entry', () => {
    useEasterEggMentionStore.getState().add(egg('a@x', 'fireworks'))
    useEasterEggMentionStore.getState().dismiss('a@x')
    expect(useEasterEggMentionStore.getState().mentions.has('a@x')).toBe(false)
  })
})
