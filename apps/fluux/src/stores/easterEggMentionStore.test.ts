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

  it('adds a pending egg with played set to false', () => {
    useEasterEggMentionStore.getState().add(egg('a@x', 'fireworks'))
    expect(useEasterEggMentionStore.getState().mentions.get('a@x')?.played).toBe(false)
  })

  it('latest egg wins per conversation', () => {
    useEasterEggMentionStore.getState().add(egg('a@x', 'fireworks'))
    useEasterEggMentionStore.getState().add(egg('a@x', 'christmas'))
    expect(useEasterEggMentionStore.getState().mentions.size).toBe(1)
    expect(useEasterEggMentionStore.getState().mentions.get('a@x')?.animation).toBe('christmas')
  })

  it('re-adding for the same conversation resets played to false', () => {
    useEasterEggMentionStore.getState().add(egg('a@x', 'fireworks'))
    useEasterEggMentionStore.getState().markPlayed('a@x')
    expect(useEasterEggMentionStore.getState().mentions.get('a@x')?.played).toBe(true)

    useEasterEggMentionStore.getState().add(egg('a@x', 'christmas'))
    expect(useEasterEggMentionStore.getState().mentions.get('a@x')?.played).toBe(false)
  })

  it('dismiss removes the conversation entry', () => {
    useEasterEggMentionStore.getState().add(egg('a@x', 'fireworks'))
    useEasterEggMentionStore.getState().dismiss('a@x')
    expect(useEasterEggMentionStore.getState().mentions.has('a@x')).toBe(false)
  })

  it('markPlayed sets played to true on the existing entry', () => {
    useEasterEggMentionStore.getState().add(egg('a@x', 'fireworks'))
    useEasterEggMentionStore.getState().markPlayed('a@x')
    expect(useEasterEggMentionStore.getState().mentions.get('a@x')?.played).toBe(true)
  })

  it('markPlayed is a safe no-op when the conversation has no entry', () => {
    const before = useEasterEggMentionStore.getState().mentions
    useEasterEggMentionStore.getState().markPlayed('missing@x')
    expect(useEasterEggMentionStore.getState().mentions).toBe(before)
    expect(useEasterEggMentionStore.getState().mentions.size).toBe(0)
  })
})
