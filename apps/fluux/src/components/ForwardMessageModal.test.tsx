import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ForwardMessageModal } from './ForwardMessageModal'
import { sendsSettled } from '@/utils/pendingSends'
import { ForwardMessageProvider, useForwardMessage } from './conversation/forwardMessageContext'

const fixture = vi.hoisted(() => ({
  chatSend: vi.fn(), roomSend: vi.fn(),
  rooms: new Map(), conversations: new Map(),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@fluux/sdk', async () => ({
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
const roomJid = 'design@conference.fluux.chat'
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
  return <button type="button" onClick={() => open?.(link)}>Forward source row</button>
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
    fireEvent.change(screen.getByLabelText('chat.forwardComment'), { target: { value: 'Please review' } })
    send()
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(fixture.chatSend).toHaveBeenCalledExactlyOnceWith('emma@fluux.chat', `Please review\n${link}`)
    expect(fixture.roomSend).not.toHaveBeenCalled()
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
    expect(fixture.roomSend).toHaveBeenCalledExactlyOnceWith(roomJid, link)
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
    expect(fixture.chatSend).toHaveBeenLastCalledWith('emma@fluux.chat', `Please review\n${link}`)
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
