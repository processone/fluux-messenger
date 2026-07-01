import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { reactionMentionStore } from '@/stores/reactionMentionStore'
import { ReactionMentions } from './ReactionMentions'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k) }) }))
const scrollToMessage = vi.fn()
vi.mock('./messageGrouping', () => ({ scrollToMessage: (id: string) => scrollToMessage(id) }))

describe('ReactionMentions', () => {
  beforeEach(() => { vi.clearAllMocks(); reactionMentionStore.getState().clearConversation('c1') })

  it('renders nothing when there are no mentions', () => {
    const { container } = render(<ReactionMentions conversationId="c1" />)
    expect(container.firstChild).toBeNull()
  })
  it('renders a mention, jumps on See, and dismisses on ✕', () => {
    reactionMentionStore.getState().addMention({ id: 'c1:m1', conversationId: 'c1', messageId: 'm1', reactorName: 'Marie', emoji: '❤️', preview: 'hi' })
    render(<ReactionMentions conversationId="c1" />)
    fireEvent.click(screen.getByText('reactions.see'))
    expect(scrollToMessage).toHaveBeenCalledWith('m1')
    fireEvent.click(screen.getByLabelText('common.dismiss'))
    expect(reactionMentionStore.getState().mentions.get('c1')?.length ?? 0).toBe(0)
  })
})
