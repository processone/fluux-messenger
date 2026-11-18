import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BaseMessage } from '@fluux/sdk'
import { MessageBubble, type MessageBubbleProps } from './MessageBubble'
import { composeForward } from '@/utils/forwardMessage'
import { ForwardMessageProvider } from './forwardMessageContext'

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

// The picker itself is covered by ForwardMessageModal.test; here it only reports what the row asked to forward.
const modal = vi.hoisted(() => ({ props: undefined as undefined | { link?: string; quote?: Record<string, unknown> } }))
vi.mock('../ForwardMessageModal', () => ({
  ForwardMessageModal: (props: { link?: string; quote?: Record<string, unknown> }) => { modal.props = props; return null },
}))

vi.mock('./EncryptedPlaceholder', () => ({ EncryptedPlaceholder: () => <div /> }))

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

// Piece 2 of the forward plan: a received structured copy is shown, labelled and attributed to the claimed author.
describe('standalone forwarded copy', () => {
  const forwarded = { author: 'Bob', text: 'Ship it\nTonight', timestamp: Date.UTC(2026, 4, 1, 9, 0) }

  it('shows the copy beside the forwarder\'s comment and no second preview of the same link', () => {
    const { container } = render(<MessageBubble {...bubble({ body: `Please review\n${link}`, references: undefined, forwarded })} />)
    expect(screen.getByText('Please review', { exact: false })).toBeTruthy()
    const copy = container.querySelector('[data-forwarded-copy]')!
    expect(copy.textContent).toContain('chat.forwardedCopyLabel')
    expect(copy.textContent).toContain('Ship it')
    expect(copy.textContent).toContain('14:30')
    expect(screen.queryByTestId('source-preview')).toBeNull()
  })

  it('shows the text as plain text, never as markup', () => {
    const { container } = render(<MessageBubble {...bubble({ forwarded: { author: 'Bob', text: '<img src=x onerror=alert(1)>' }, references: undefined })} />)
    expect(container.querySelector('[data-forwarded-copy] img')).toBeNull()
    expect(container.querySelector('[data-forwarded-copy]')!.textContent).toContain('<img src=x')
  })

  // Review: a deletion removes the copied text from view even while the resident row still holds it.
  it('hides the copy once the message is retracted', () => {
    const { container } = render(<MessageBubble {...bubble({ forwarded, references: undefined, isRetracted: true })} />)
    expect(container.querySelector('[data-forwarded-copy]')).toBeNull()
    expect(screen.queryByText(/Ship it/)).toBeNull()
  })
})

// FLM-153 piece 3: Forward is offered on a one-to-one message with readable content, not on unreadable ones.
describe('forward on a one-to-one message', () => {
  const renderDirect = (message: Partial<BaseMessage>) => {
    modal.props = undefined
    return render(<ForwardMessageProvider conversationId="alice@example.com">
      <MessageBubble {...bubble({ body: 'Ship it', references: undefined, ...message })} /></ForwardMessageProvider>)
  }

  it('offers Forward and passes the content, the bare author address and no link', () => {
    renderDirect({ from: 'alice@example.com/phone' })
    fireEvent.click(screen.getAllByRole('button', { name: 'chat.forwardMessageLink' })[0])
    expect(modal.props?.link).toBeUndefined()
    expect(modal.props?.quote).toEqual({ author: 'Alice', text: 'Ship it', from: 'alice@example.com', type: 'chat', timestamp: Date.parse('2026-05-01T10:00:00Z') })
  })

  it('marks a message from an encrypted chat so it can only go into an encrypted chat', () => {
    renderDirect({ securityContext: { protocol: 'openpgp', trust: 'verified' } as BaseMessage['securityContext'] })
    fireEvent.click(screen.getAllByRole('button', { name: 'chat.forwardMessageLink' })[0])
    expect(modal.props?.quote?.fromEncrypted).toBe(true)
  })

  // The captain's ruling: a message holding a copy forwards its comment and the copied text as one quote, with no nested copy.
  describe('message holding a structured copy', () => {
    const forwarded = { author: 'Carol', from: 'carol@example.org', text: 'Ship it\nTonight', timestamp: 1, fallback: { begin: 5, end: 5 + '> Carol wrote:\n> Ship it'.length, text: '> Carol wrote:\n> Ship it' } }
    it('forwards the displayed comment and the attributed copied text, without the hidden quote', () => {
      renderDirect({ body: 'Look\n> Carol wrote:\n> Ship it', forwarded })
      fireEvent.click(screen.getAllByRole('button', { name: 'chat.forwardMessageLink' })[0])
      expect(modal.props?.quote).toMatchObject({ author: 'Alice', text: 'Look\nCarol wrote:\nShip it\nTonight', from: 'alice@example.com' })
      expect(modal.props?.quote).not.toHaveProperty('forwarded')
    })

    it('offers Forward on a copy-only message and forwards the attributed copied text', () => {
      renderDirect({ body: '', forwarded: { author: 'Carol', text: 'Ship it' } })
      fireEvent.click(screen.getAllByRole('button', { name: 'chat.forwardMessageLink' })[0])
      expect(modal.props?.quote).toMatchObject({ author: 'Alice', text: 'Carol wrote:\nShip it' })
    })

    it('keeps the protection flag of an encrypted copy-only message', () => {
      renderDirect({ body: '', forwarded: { author: 'Carol', text: 'Ship it' }, securityContext: { protocol: 'openpgp', trust: 'verified' } as BaseMessage['securityContext'] })
      fireEvent.click(screen.getAllByRole('button', { name: 'chat.forwardMessageLink' })[0])
      expect(modal.props?.quote?.fromEncrypted).toBe(true)
    })
  })

  it.each([
    ['retracted', { isRetracted: true }],
    ['undecryptable', { encryptedPayload: '<encrypted/>' }],
    ['failed to send', { deliveryError: 'x' }],
    ['without text', { body: '' }],
  ])('offers no Forward on a %s message', (_name, message) => {
    renderDirect(message as Partial<BaseMessage>)
    expect(screen.queryAllByRole('button', { name: 'chat.forwardMessageLink' })).toHaveLength(0)
  })
})
