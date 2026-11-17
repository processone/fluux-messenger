import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BaseMessage } from '@fluux/sdk'
import { MessageBubble, type MessageBubbleProps } from './MessageBubble'
import { composeForward } from '@/utils/forwardMessage'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('date-fns', () => ({ format: vi.fn(() => '14:30') }))
vi.mock('../Avatar', () => ({ Avatar: () => <div data-testid="avatar" /> }))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { densityMode: string }) => unknown) => selector({ densityMode: 'comfortable' }),
}))
// The preview's own source lookup is covered by RoomMessageLinkPreview.test; here it only reports whether it shows the source.
const preview = vi.hoisted(() => ({ report: undefined as undefined | ((shown: boolean) => void) }))
vi.mock('./RoomMessageLinkPreview', () => ({
  RoomMessageLinkPreview: ({ onSourceShown }: { onSourceShown?: (shown: boolean) => void }) => {
    preview.report = onSourceShown
    return <div data-testid="source-preview" />
  },
}))

const link = 'xmpp:design@conference.fluux.chat?join;msg=1731490000123456'
const forward = composeForward('Please review', link, { author: 'Bob', text: 'Ship it' })

function bubble(message: Partial<BaseMessage> = {}): MessageBubbleProps {
  return {
    message: { stanzaId: undefined, originId: undefined, type: 'chat', id: 'fwd', from: 'alice@example.com',
      body: forward.body, references: forward.references, timestamp: new Date('2026-05-01T10:00:00Z'), isOutgoing: false, ...message },
    showAvatar: true, isLastOutgoing: false, isLastMessage: false, senderName: 'Alice', senderColor: 'rgb(1,1,1)',
    avatarIdentifier: 'alice@example.com', myReactions: [], onReaction: vi.fn(), getReactorName: vi.fn(id => id),
    onReply: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined), formatTime: () => '14:30', timeFormat: '24h',
  }
}

// Approved forward plan: the quote and link stay, labelled, until the source is readable.
describe('forwarded message quote and link', () => {
  it('keeps the quote and link visible and labelled while the source is not shown', () => {
    render(<MessageBubble {...bubble()} />)
    expect(screen.getByText(/Ship it/)).toBeTruthy()
    expect(screen.getByText('chat.forwardQuotedCopy')).toBeTruthy()
  })

  it('hides the quote and link, keeping the comment, once the source is shown, and restores them if it stops', () => {
    render(<MessageBubble {...bubble()} />)
    act(() => preview.report!(true))
    expect(screen.queryByText(/Ship it/)).toBeNull()
    expect(screen.queryByText('chat.forwardQuotedCopy')).toBeNull()
    expect(screen.getByText('Please review')).toBeTruthy()
    act(() => preview.report!(false))
    expect(screen.getByText(/Ship it/)).toBeTruthy()
  })

  it('renders no empty text row when the whole body was fallback', () => {
    const only = composeForward('', link, { author: 'Bob', text: 'Ship it' })
    const { container } = render(<MessageBubble {...bubble({ body: only.body, references: only.references })} />)
    act(() => preview.report!(true))
    expect(screen.queryByText(/Ship it/)).toBeNull()
    expect(container.querySelector('[data-forward-quoted-copy]')).toBeNull()
  })

  it('leaves an ordinary message with a pasted link untouched', () => {
    render(<MessageBubble {...bubble({ body: `see ${link}`, references: [{ type: 'data', uri: link, begin: 4, end: 4 + link.length }] })} />)
    expect(screen.queryByText('chat.forwardQuotedCopy')).toBeNull()
  })
})
