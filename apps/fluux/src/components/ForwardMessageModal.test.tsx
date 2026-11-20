import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ForwardMessageModal } from './ForwardMessageModal'
import { sendsSettled } from '@/utils/pendingSends'
import { useContactSecurityRequestStore } from '@/stores/contactSecurityRequestStore'
import { ForwardMessageProvider, useForwardMessage } from './conversation/forwardMessageContext'

const fixture = vi.hoisted(() => ({
  chatSend: vi.fn(), roomSend: vi.fn(),
  rooms: new Map(), conversations: new Map(),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@fluux/sdk', async () => ({
  E2EEEncryptionRequiredError: (await vi.importActual<typeof import('@fluux/sdk')>('@fluux/sdk')).E2EEEncryptionRequiredError,
  E2EEPluginError: (await vi.importActual<typeof import('@fluux/sdk')>('@fluux/sdk')).E2EEPluginError,
  isE2EEPluginError: (await vi.importActual<typeof import('@fluux/sdk')>('@fluux/sdk')).isE2EEPluginError,
  // The shared picker filters with the SDK's own name/address matcher.
  matchNameOrJid: (await vi.importActual<typeof import('@fluux/sdk')>('@fluux/sdk')).matchNameOrJid,
  useRoster: () => ({ contacts: [{ jid: 'emma@fluux.chat', name: 'Emma' }, { jid: 'james@fluux.chat', name: 'James' }] }),
  useChatActions: () => ({ sendMessage: fixture.chatSend }),
  useRoomActions: () => ({ sendMessage: fixture.roomSend }),
  roomStore: { getState: () => ({ rooms: fixture.rooms }) },
  chatStore: { getState: () => ({ conversations: fixture.conversations }) },
}))
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({ conversations: fixture.conversations }),
  useRoomStore: (selector: (state: unknown) => unknown) => selector({ rooms: fixture.rooms }),
  useConnectionStore: (selector: (state: unknown) => unknown) => selector({ status: 'online' }),
}))
// Keep the real ModalShell/ModalOverlay and the real ContactSelector: pending-dismissal
// regressions occur in the exit transition and focus handling, and the picker is the
// destination control under test.

// The room-link forwarding specification owns these transitions: one destination, optional
// comment, no source copy; pending/failure/cancel must not produce extra sends.
// Identities follow the existing demo contact and room fixtures.
const link = 'xmpp:design@conference.fluux.chat?join;msg=1731490000123456'
// The link is the whole generated block unless a quote precedes it; both are XEP-0428 fallback.
const marked = (lead: string, quoteLength = 0) => ({ references: [{ type: 'data', uri: link,
  begin: lead.length + quoteLength, end: lead.length + quoteLength + link.length,
  forwardFallback: { begin: lead.length, end: lead.length + quoteLength + link.length } }] })
const roomJid = 'design@conference.fluux.chat'
const dan = { id: 'dan@example.org', name: 'Dan', type: 'chat', lastMessage: { timestamp: new Date() } }
const picker = () => screen.getByLabelText('chat.forwardDestination')
const suggestions = () => screen.queryByTestId('contact-suggestions')?.querySelectorAll('[role="button"]') ?? []
/** Type into the destination picker and pick the highlighted entry with Enter. */
const choose = (query: string) => {
  fireEvent.focus(picker())
  fireEvent.change(picker(), { target: { value: query } })
  fireEvent.keyDown(picker(), { key: 'Enter' })
}
const send = () => fireEvent.click(screen.getByRole('button', { name: 'chat.forwardSend' }))
function SourceRow() {
  const open = useForwardMessage()
  return <button type="button" onClick={() => open?.({ link })}>Forward source row</button>
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.chatSend.mockReset().mockResolvedValue('sent-chat-message')
  fixture.roomSend.mockReset().mockResolvedValue('sent-room-message')
  fixture.rooms = new Map([[roomJid, { jid: roomJid, name: 'Design', joined: true }]])
  fixture.conversations = new Map()
})

describe('ForwardMessageModal', () => {
  it('narrows the picker as you type, picks with Enter and sends one link with the comment', async () => {
    const onClose = vi.fn()
    render(<ForwardMessageModal link={link} onClose={onClose} />)
    expect(screen.getByRole('button', { name: 'chat.forwardSend' })).toBeDisabled()
    expect(picker()).toHaveFocus()
    expect(Array.from(suggestions(), row => row.textContent)).toEqual([
      expect.stringContaining('Emma'), expect.stringContaining('James'), expect.stringContaining('Design'),
    ])
    fireEvent.change(picker(), { target: { value: 'em' } })
    expect(Array.from(suggestions(), row => row.textContent)).toEqual([expect.stringContaining('Emma')])
    fireEvent.keyDown(picker(), { key: 'Enter' })
    expect(screen.getByLabelText('chat.forwardComment')).toHaveFocus()
    expect(picker()).toHaveValue('')
    expect(screen.getByText('Emma')).toBeInTheDocument()
    // The field under the chosen chip must not still ask for a choice.
    expect(picker()).toHaveAttribute('placeholder', '')
    fireEvent.change(screen.getByLabelText('chat.forwardComment'), { target: { value: 'Please review' } })
    send()
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(fixture.chatSend).toHaveBeenCalledExactlyOnceWith('emma@fluux.chat', `Please review\n${link}`, marked('Please review\n'))
    expect(fixture.roomSend).not.toHaveBeenCalled()
  })

  it('sends the comment, an attributed quote and the link, with the quote and link marked as fallback', async () => {
    const onClose = vi.fn()
    render(<ForwardMessageModal link={link} quote={{ author: 'Bob', text: 'Ship it\nTonight' }} onClose={onClose} />)
    fireEvent.change(picker(), { target: { value: 'em' } })
    fireEvent.keyDown(picker(), { key: 'Enter' })
    fireEvent.change(screen.getByLabelText('chat.forwardComment'), { target: { value: 'Please review' } })
    send()
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const quote = '> Bob wrote:\n> Ship it\n> Tonight\n'
    expect(fixture.chatSend).toHaveBeenCalledExactlyOnceWith('emma@fluux.chat',
      `Please review\n${quote}${link}`, marked('Please review\n', quote.length))
  })

  // Piece 2 of the forward plan: a chat gets one stanza with the quote, the copy and a fallback marker; rooms get the quote.
  describe('standalone forwarded copy', () => {
    const source = { author: 'Bob', text: 'Ship it', from: `${roomJid}/Bob`, timestamp: 1731490000000 }
    const forwardTo = async (query: string, comment = 'Please review') => {
      render(<ForwardMessageModal link={link} quote={source} onClose={vi.fn()} />)
      fireEvent.change(picker(), { target: { value: query } })
      fireEvent.keyDown(picker(), { key: 'Enter' })
      fireEvent.change(screen.getByLabelText('chat.forwardComment'), { target: { value: comment } })
      send()
      await waitFor(() => expect(fixture.chatSend.mock.calls.length + fixture.roomSend.mock.calls.length).toBe(1))
    }

    it('sends the comment, quote and link with the copy, and marks the quote and link as its fallback', async () => {
      await forwardTo('em')
      const lead = 'Please review\n'
      const quote = '> Bob wrote:\n> Ship it\n'
      expect(fixture.chatSend).toHaveBeenCalledExactlyOnceWith('emma@fluux.chat', `${lead}${quote}${link}`, {
        references: [{ type: 'data', uri: link, begin: lead.length + quote.length, end: lead.length + quote.length + link.length }],
        forwarded: { from: `${roomJid}/Bob`, text: 'Ship it', timestamp: 1731490000000,
          fallback: { begin: lead.length, end: lead.length + quote.length + link.length } },
      })
    })

    it('keeps the quoted fallback alone for a room', async () => {
      await forwardTo('design')
      expect(fixture.roomSend.mock.calls[0][2]).not.toHaveProperty('forwarded')
      expect(fixture.roomSend.mock.calls[0][1]).toContain('> Bob wrote:')
    })

    it('keeps the quoted fallback alone when the source has no author address to attribute', async () => {
      render(<ForwardMessageModal link={link} quote={{ author: 'Bob', text: 'Ship it' }} onClose={vi.fn()} />)
      fireEvent.change(picker(), { target: { value: 'em' } })
      fireEvent.keyDown(picker(), { key: 'Enter' })
      send()
      await waitFor(() => expect(fixture.chatSend).toHaveBeenCalledOnce())
      expect(fixture.chatSend.mock.calls[0][1]).toContain('> Bob wrote:')
      expect(fixture.chatSend.mock.calls[0][2]).not.toHaveProperty('forwarded')
    })
  })

  // FLM-153 piece 3: a one-to-one message has no link; its content is forwarded, protected if it was.
  describe('one-to-one source', () => {
    const direct = { author: 'Bob', text: 'Ship it', from: 'bob@example.org', timestamp: 1731490000000 }
    const pickAndSend = (query: string) => {
      fireEvent.change(picker(), { target: { value: query } })
      fireEvent.keyDown(picker(), { key: 'Enter' })
      send()
    }

    it('sends the quote and a copy with no link, the quote marked as the copy fallback', async () => {
      render(<ForwardMessageModal quote={direct} onClose={vi.fn()} />)
      expect(screen.getByText('chat.forwardQuoteOnly')).toBeInTheDocument()
      pickAndSend('em')
      await waitFor(() => expect(fixture.chatSend).toHaveBeenCalledOnce())
      const quote = '> Bob wrote:\n> Ship it'
      expect(fixture.chatSend).toHaveBeenCalledWith('emma@fluux.chat', quote, {
        references: [], forwarded: { from: 'bob@example.org', text: 'Ship it', timestamp: 1731490000000, fallback: { begin: 0, end: quote.length } },
      })
    })

    it('sends only the quote to a room', async () => {
      render(<ForwardMessageModal quote={direct} onClose={vi.fn()} />)
      pickAndSend('design')
      await waitFor(() => expect(fixture.roomSend).toHaveBeenCalledOnce())
      expect(fixture.roomSend.mock.calls[0][1]).toBe('> Bob wrote:\n> Ship it')
    })

    it('marks an encrypted source, offers no room and keeps the chat copy marked for protection', async () => {
      render(<ForwardMessageModal quote={{ ...direct, fromEncrypted: true }} onClose={vi.fn()} />)
      expect(screen.getByText('chat.forwardEncryptedOnly')).toBeInTheDocument()
      fireEvent.focus(picker())
      expect(Array.from(suggestions(), row => row.textContent).join()).not.toContain('Design')
      pickAndSend('em')
      await waitFor(() => expect(fixture.chatSend).toHaveBeenCalledOnce())
      expect(fixture.chatSend.mock.calls[0][2].forwarded).toMatchObject({ fromEncrypted: true })
      expect(fixture.roomSend).not.toHaveBeenCalled()
    })

    // FLM-319: a contact whose every key waits for a decision refuses the send; the dialog names the
    // contact, stays encrypted-only (one send attempt, never plain text) and offers Review keys.
    it('names the contact and offers Review keys when every key waits for a decision', async () => {
      const { E2EEPluginError } = await vi.importActual<typeof import('@fluux/sdk')>('@fluux/sdk')
      fixture.chatSend.mockRejectedValue(new E2EEPluginError('permanent', 'peer-keys-awaiting-decision', 'waiting'))
      useContactSecurityRequestStore.getState().clearContactSecurityRequest()
      const onClose = vi.fn()
      render(<ForwardMessageModal quote={direct} onClose={onClose} />)
      pickAndSend('em')
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('chat.encryption.heldKeys.all'))
      expect(fixture.chatSend).toHaveBeenCalledOnce()
      fireEvent.click(screen.getByRole('button', { name: 'chat.encryption.heldKeys.review' }))
      expect(useContactSecurityRequestStore.getState().jid).toBe('emma@fluux.chat')
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('offers no Review keys for another refusal', async () => {
      const { E2EEPluginError } = await vi.importActual<typeof import('@fluux/sdk')>('@fluux/sdk')
      fixture.chatSend.mockRejectedValue(new E2EEPluginError('permanent', 'peer-keys-trust-pending', 'pending'))
      render(<ForwardMessageModal quote={direct} onClose={vi.fn()} />)
      pickAndSend('em')
      expect(await screen.findByRole('alert')).toHaveTextContent('chat.encryption.sendBlockedTrustPending')
      expect(screen.queryByRole('button', { name: 'chat.encryption.heldKeys.review' })).toBeNull()
    })

    it('shows the encryption refusal and keeps the dialog when the destination cannot be encrypted', async () => {
      const { E2EEEncryptionRequiredError } = await vi.importActual<typeof import('@fluux/sdk')>('@fluux/sdk')
      fixture.chatSend.mockRejectedValue(new E2EEEncryptionRequiredError({ kind: 'direct', peer: 'emma@fluux.chat' }))
      const onClose = vi.fn()
      render(<ForwardMessageModal quote={{ ...direct, fromEncrypted: true }} onClose={onClose} />)
      pickAndSend('em')
      expect(await screen.findByRole('alert')).toHaveTextContent('chat.encryption.sendBlockedEncryptionRequired')
      expect(onClose).not.toHaveBeenCalled()
    })
  })

  it('keeps the highlighted recipient when a message from them arrives before Enter', async () => {
    const onClose = vi.fn()
    const { rerender } = render(<ForwardMessageModal link={link} onClose={onClose} />)
    fireEvent.change(picker(), { target: { value: 'm' } })
    expect(Array.from(suggestions(), row => row.textContent)).toEqual([
      expect.stringContaining('Emma'), expect.stringContaining('James'),
    ])
    fireEvent.keyDown(picker(), { key: 'ArrowDown' })
    // James writes while the list is open; Forward re-renders from its conversations subscription.
    fixture.conversations = new Map([['james@fluux.chat', {
      id: 'james@fluux.chat', name: 'James', type: 'chat', lastMessage: { timestamp: new Date() },
    }]])
    rerender(<ForwardMessageModal link={link} onClose={onClose} />)
    fireEvent.keyDown(picker(), { key: 'Enter' })
    send()
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(fixture.chatSend).toHaveBeenCalledExactlyOnceWith('james@fluux.chat', link, marked(''))
  })

  it('keeps the highlighted destination when a new chat joins the list before Enter', async () => {
    const onClose = vi.fn()
    const { rerender } = render(<ForwardMessageModal link={link} onClose={onClose} />)
    fireEvent.change(picker(), { target: { value: 'd' } })
    expect(Array.from(suggestions(), row => row.textContent)).toEqual([expect.stringContaining('Design')])
    // A first message from someone outside the roster creates a chat sorted ahead of Design.
    fixture.conversations = new Map([[dan.id, dan]])
    rerender(<ForwardMessageModal link={link} onClose={onClose} />)
    expect(Array.from(suggestions(), row => row.textContent)).toEqual([
      expect.stringContaining('Dan'), expect.stringContaining('Design'),
    ])
    fireEvent.keyDown(picker(), { key: 'Enter' })
    send()
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(fixture.roomSend).toHaveBeenCalledExactlyOnceWith(roomJid, link, marked(''))
    expect(fixture.chatSend).not.toHaveBeenCalled()
  })

  it('asks for a fresh choice when the highlighted destination leaves the list', () => {
    const diego = { id: 'diego@example.org', name: 'Diego', type: 'chat' }
    fixture.conversations = new Map([[diego.id, diego]])
    const props = { link, onClose: vi.fn() }
    const { rerender } = render(<ForwardMessageModal {...props} />)
    fireEvent.change(picker(), { target: { value: 'd' } })
    expect(Array.from(suggestions(), row => row.textContent)).toEqual([
      expect.stringContaining('Design'), expect.stringContaining('Diego'),
    ])
    // The highlighted room is left; Diego moves up to where Design was.
    fixture.rooms = new Map([[roomJid, { jid: roomJid, name: 'Design', joined: false }]])
    rerender(<ForwardMessageModal {...props} />)
    expect(Array.from(suggestions(), row => row.textContent)).toEqual([expect.stringContaining('Diego')])
    fireEvent.keyDown(picker(), { key: 'Enter' })
    expect(within(screen.getByRole('dialog')).queryByText('Diego')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'chat.forwardSend' })).toBeDisabled()
    fireEvent.keyDown(picker(), { key: 'ArrowDown' })
    fireEvent.keyDown(picker(), { key: 'Enter' })
    expect(within(screen.getByRole('dialog')).getByText('Diego')).toBeInTheDocument()
  })

  it('replaces an earlier pick and sends a link without a comment to a joined room', async () => {
    const onClose = vi.fn()
    render(<ForwardMessageModal link={link} onClose={onClose} />)
    choose('emma')
    choose('des')
    // The chosen destination shows inside the dialog; the suggestion list is portalled outside it.
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.queryByText('Emma')).not.toBeInTheDocument()
    expect(dialog.getByText('Design')).toBeInTheDocument()
    send()
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(fixture.roomSend).toHaveBeenCalledExactlyOnceWith(roomJid, link, marked(''))
    expect(fixture.chatSend).not.toHaveBeenCalled()
  })

  it('keeps failed selections and comments, and prevents duplicate sends while pending', async () => {
    let reject!: (error: Error) => void
    fixture.chatSend.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const onClose = vi.fn()
    render(<ForwardMessageModal link={link} onClose={onClose} />)
    choose('emma')
    fireEvent.change(screen.getByLabelText('chat.forwardComment'), { target: { value: 'Please review' } })
    send()
    const pending = screen.getByRole('button', { name: 'chat.forwardSending' })
    expect(pending).toBeDisabled()
    fireEvent.click(pending)
    expect(fixture.chatSend).toHaveBeenCalledOnce()
    const acknowledged = vi.fn(async () => {})
    const settled = sendsSettled(acknowledged)
    expect(acknowledged).not.toHaveBeenCalled()
    await act(async () => {
      reject(new Error('Disconnected'))
      await settled
    })
    expect(acknowledged).toHaveBeenCalledOnce()
    await screen.findByRole('alert')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Emma')).toBeInTheDocument()
    expect(screen.getByLabelText('chat.forwardComment')).toHaveValue('Please review')
    send()
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(fixture.chatSend).toHaveBeenLastCalledWith('emma@fluux.chat', `Please review\n${link}`, marked('Please review\n'))
  })

  it('cancels without sending and offers no unjoined room, occupant chat or typed address', () => {
    fixture.rooms.set('engineering@conference.fluux.chat', { jid: 'engineering@conference.fluux.chat', name: 'Engineering', joined: false })
    fixture.conversations.set(`${roomJid}/Alice`, { id: `${roomJid}/Alice`, name: 'Alice', type: 'chat' })
    const onClose = vi.fn()
    render(<ForwardMessageModal link={link} onClose={onClose} />)
    fireEvent.focus(picker())
    expect(suggestions()).toHaveLength(3)
    for (const query of ['Engineering', 'Alice', 'stranger@example.org']) {
      choose(query)
      expect(suggestions()).toHaveLength(0)
      expect(screen.getByText('contacts.noContactsFound')).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'chat.forwardSend' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(fixture.chatSend).not.toHaveBeenCalled()
    expect(fixture.roomSend).not.toHaveBeenCalled()
  })

  it('does not reinterpret a departed room as a direct-chat destination', () => {
    const props = { link, onClose: vi.fn() }
    const { rerender } = render(<ForwardMessageModal {...props} />)
    choose('design')
    fixture.rooms = new Map([[roomJid, { jid: roomJid, joined: false }]])
    rerender(<ForwardMessageModal {...props} />)
    expect(screen.getByRole('button', { name: 'chat.forwardSend' })).toBeDisabled()
    expect(screen.getByText('chat.forwardUnavailable')).toBeInTheDocument()
    send()
    expect(fixture.roomSend).not.toHaveBeenCalled()
    expect(fixture.chatSend).not.toHaveBeenCalled()
  })

  it('keeps every dismissal from starting an exit while sending, and can dismiss after failure', async () => {
    vi.useFakeTimers()
    document.documentElement.setAttribute('data-motion', 'full')
    let reject!: (error: Error) => void
    fixture.chatSend.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const onClose = vi.fn()
    try {
      const { container } = render(<ForwardMessageModal link={link} onClose={onClose} />)
      choose('emma')
      send()
      fireEvent.keyDown(document.body, { key: 'Escape' })
      fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
      fireEvent.click(container.querySelector('button[aria-hidden="true"]')!)
      act(() => { vi.advanceTimersByTime(200) })
      expect(container.querySelector('.modal-panel-out')).toBeNull()
      expect(onClose).not.toHaveBeenCalled()
      await act(async () => { reject(new Error('Disconnected')) })
      expect(screen.getByRole('alert')).toHaveTextContent('chat.forwardFailed')
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(container.querySelector('.modal-panel-out')).not.toBeNull()
      act(() => { vi.advanceTimersByTime(150) })
      expect(onClose).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      document.documentElement.removeAttribute('data-motion')
    }
  })

  it('excludes a visitor room and rechecks speaking permission at the send boundary', async () => {
    fixture.rooms.set('engineering@conference.fluux.chat', {
      jid: 'engineering@conference.fluux.chat', name: 'Engineering', joined: true, selfOccupant: { role: 'visitor' },
    })
    fixture.conversations.set('engineering@conference.fluux.chat', {
      id: 'engineering@conference.fluux.chat', name: 'Engineering', type: 'chat',
    })
    render(<ForwardMessageModal link={link} onClose={vi.fn()} />)
    choose('engineering')
    expect(suggestions()).toHaveLength(0)
    choose('design')
    // Store changed, before the subscribed render catches up with the demotion.
    fixture.rooms = new Map([[roomJid, { jid: roomJid, joined: true, selfOccupant: { role: 'visitor' } }]])
    send()
    await screen.findByRole('alert')
    expect(fixture.roomSend).not.toHaveBeenCalled()
    expect(fixture.chatSend).not.toHaveBeenCalled()
    // The pick is kept, named by its address now that the room is no longer offered.
    expect(screen.getByText(roomJid)).toBeInTheDocument()
    expect(screen.getByText('chat.forwardUnavailable')).toBeInTheDocument()
  })

  it('retains selection and comment when the source row unmounts', () => {
    const view = (source: boolean, conversationId = roomJid) => (
      <ForwardMessageProvider conversationId={conversationId}>{source && <SourceRow />}</ForwardMessageProvider>
    )
    const { rerender } = render(view(true))
    fireEvent.click(screen.getByRole('button', { name: 'Forward source row' }))
    choose('emma')
    fireEvent.change(screen.getByLabelText('chat.forwardComment'), { target: { value: 'Please review' } })
    rerender(view(false))
    expect(screen.getByText('Emma')).toBeInTheDocument()
    expect(screen.getByLabelText('chat.forwardComment')).toHaveValue('Please review')
    rerender(view(false, 'team@conference.fluux.chat'))
    expect(screen.queryByLabelText('chat.forwardDestination')).not.toBeInTheDocument()
    rerender(view(false))
    expect(screen.queryByLabelText('chat.forwardDestination')).not.toBeInTheDocument()
  })

})
