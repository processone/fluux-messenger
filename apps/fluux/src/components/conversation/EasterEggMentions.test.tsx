import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EasterEggMentions } from './EasterEggMentions'
import { useEasterEggMentionStore } from '@/stores/easterEggMentionStore'

describe('EasterEggMentions', () => {
  beforeEach(() => useEasterEggMentionStore.setState({ mentions: new Map() }))

  it('renders nothing without a pending egg', () => {
    const { container } = render(<EasterEggMentions conversationId="a@x" onReplay={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('replays and dismisses a pending egg', () => {
    useEasterEggMentionStore.getState().add({ id: 'a@x', conversationId: 'a@x', animation: 'fireworks', senderName: 'ava' })
    const onReplay = vi.fn()
    render(<EasterEggMentions conversationId="a@x" onReplay={onReplay} />)
    fireEvent.click(screen.getByText('Replay'))
    expect(onReplay).toHaveBeenCalledWith('fireworks')
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(useEasterEggMentionStore.getState().mentions.has('a@x')).toBe(false)
  })
})
