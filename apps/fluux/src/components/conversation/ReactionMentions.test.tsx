import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { reactionMentionStore } from '@/stores/reactionMentionStore'
import { ReactionMentions } from './ReactionMentions'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k) }) }))

describe('ReactionMentions', () => {
  beforeEach(() => { vi.clearAllMocks(); reactionMentionStore.getState().clearConversation('c1') })

  it('renders nothing when there are no mentions', () => {
    const { container } = render(<ReactionMentions conversationId="c1" onSee={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })
  it('renders a mention, invokes onSee with the message id, and dismisses on ✕', () => {
    const onSee = vi.fn()
    reactionMentionStore.getState().addMention({ id: 'c1:m1', conversationId: 'c1', messageId: 'm1', reactorName: 'Marie', emoji: '❤️', preview: 'hi' })
    render(<ReactionMentions conversationId="c1" onSee={onSee} />)
    fireEvent.click(screen.getByText('reactions.see'))
    expect(onSee).toHaveBeenCalledWith('m1')
    fireEvent.click(screen.getByLabelText('common.dismiss'))
    expect(reactionMentionStore.getState().mentions.get('c1')?.length ?? 0).toBe(0)
  })
})
