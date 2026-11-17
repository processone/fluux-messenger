import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ForwardMessageModal } from './ForwardMessageModal'
import { sendsSettled } from '@/utils/pendingSends'
import { ForwardMessageProvider, useForwardMessage } from './conversation/forwardMessageContext'

const fixture = vi.hoisted(() => ({
  chatSend: vi.fn(), roomSend: vi.fn(),
  rooms: new Map(), conversations: new Map(),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@fluux/sdk', () => ({
  useRoster: () => ({ contacts: [{ jid: 'emma@fluux.chat', name: 'Emma' }] }),
  useChatActions: () => ({ sendMessage: fixture.chatSend }),
  useRoomActions: () => ({ sendMessage: fixture.roomSend }),
  roomStore: { getState: () => ({ rooms: fixture.rooms }) },
}))
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({ conversations: fixture.conversations }),
  useRoomStore: (selector: (state: unknown) => unknown) => selector({ rooms: fixture.rooms }),
}))
// Keep the real ModalShell/ModalOverlay: pending-dismissal regressions occur
// before the caller's onClose, in the exit transition and focus handling.

// The room-link forwarding specification owns these transitions: one destination, optional
// comment, no source copy; pending/failure/cancel must not produce extra sends.
// Identities follow the existing demo contact and room fixtures.
const link = 'xmpp:design@conference.fluux.chat?join;msg=1731490000123456'
const roomJid = 'design@conference.fluux.chat'
const choose = (value: string) => fireEvent.change(screen.getByLabelText('chat.forwardDestination'), { target: { value } })
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
  it('requires a selection and sends one link with the optional comment to a contact', async () => {
    const onClose = vi.fn()
    render(<ForwardMessageModal link={link} onClose={onClose} />)
    expect(screen.getByRole('button', { name: 'chat.forwardSend' })).toBeDisabled()
    choose('chat:emma@fluux.chat')
    fireEvent.change(screen.getByLabelText('chat.forwardComment'), { target: { value: 'Please review' } })
    send()
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(fixture.chatSend).toHaveBeenCalledExactlyOnceWith('emma@fluux.chat', `Please review\n${link}`)
    expect(fixture.roomSend).not.toHaveBeenCalled()
  })

  it('sends a link without a comment to a joined room', async () => {
    const onClose = vi.fn()
    render(<ForwardMessageModal link={link} onClose={onClose} />)
    choose(`room:${roomJid}`)
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
    choose('chat:emma@fluux.chat')
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
    expect(screen.getByLabelText('chat.forwardDestination')).toHaveValue('chat:emma@fluux.chat')
    expect(screen.getByLabelText('chat.forwardComment')).toHaveValue('Please review')
  })

  it('cancels without sending and excludes unjoined rooms and private occupant conversations', () => {
    fixture.rooms.set('engineering@conference.fluux.chat', { jid: 'engineering@conference.fluux.chat', joined: false })
    fixture.conversations.set(`${roomJid}/Alice`, { id: `${roomJid}/Alice`, name: 'Alice', type: 'chat' })
    const onClose = vi.fn()
    render(<ForwardMessageModal link={link} onClose={onClose} />)
    expect(screen.queryByRole('option', { name: 'Alice' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(fixture.chatSend).not.toHaveBeenCalled()
    expect(fixture.roomSend).not.toHaveBeenCalled()
  })

  it('does not reinterpret a departed room as a direct-chat destination', () => {
    const props = { link, onClose: vi.fn() }
    const { rerender } = render(<ForwardMessageModal {...props} />)
    choose(`room:${roomJid}`)
    fixture.rooms = new Map([[roomJid, { jid: roomJid, joined: false }]])
    rerender(<ForwardMessageModal {...props} />)
    expect(screen.getByRole('button', { name: 'chat.forwardSend' })).toBeDisabled()
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
      choose('chat:emma@fluux.chat')
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
    expect(screen.queryByRole('option', { name: /Engineering/ })).not.toBeInTheDocument()
    choose(`room:${roomJid}`)
    // Store changed, before the subscribed render catches up with the demotion.
    fixture.rooms = new Map([[roomJid, { jid: roomJid, joined: true, selfOccupant: { role: 'visitor' } }]])
    send()
    await screen.findByRole('alert')
    expect(fixture.roomSend).not.toHaveBeenCalled()
    expect(fixture.chatSend).not.toHaveBeenCalled()
    expect(screen.getByLabelText('chat.forwardDestination')).toHaveValue(`room:${roomJid}`)
  })

  it('retains selection and comment when the source row unmounts', () => {
    const view = (source: boolean, conversationId = roomJid) => (
      <ForwardMessageProvider conversationId={conversationId}>{source && <SourceRow />}</ForwardMessageProvider>
    )
    const { rerender } = render(view(true))
    fireEvent.click(screen.getByRole('button', { name: 'Forward source row' }))
    choose('chat:emma@fluux.chat')
    fireEvent.change(screen.getByLabelText('chat.forwardComment'), { target: { value: 'Please review' } })
    rerender(view(false))
    expect(screen.getByLabelText('chat.forwardDestination')).toHaveValue('chat:emma@fluux.chat')
    expect(screen.getByLabelText('chat.forwardComment')).toHaveValue('Please review')
    rerender(view(false, 'team@conference.fluux.chat'))
    expect(screen.queryByLabelText('chat.forwardDestination')).not.toBeInTheDocument()
    rerender(view(false))
    expect(screen.queryByLabelText('chat.forwardDestination')).not.toBeInTheDocument()
  })

})
