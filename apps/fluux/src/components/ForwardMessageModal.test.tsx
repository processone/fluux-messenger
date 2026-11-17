import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ForwardMessageModal } from './ForwardMessageModal'

const fixture = vi.hoisted(() => ({
  chatSend: vi.fn(), roomSend: vi.fn(),
  rooms: new Map(), conversations: new Map(),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@fluux/sdk', () => ({
  useRoster: () => ({ contacts: [{ jid: 'emma@fluux.chat', name: 'Emma' }] }),
  useChatActions: () => ({ sendMessage: fixture.chatSend }),
  useRoomActions: () => ({ sendMessage: fixture.roomSend }),
}))
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({ conversations: fixture.conversations }),
  useRoomStore: (selector: (state: unknown) => unknown) => selector({ rooms: fixture.rooms }),
}))
vi.mock('./ModalShell', () => ({ ModalShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))

// The room-link forwarding specification owns these transitions: one destination, optional
// comment, no source copy; pending/failure/cancel must not produce extra sends.
// Identities follow the existing demo contact and room fixtures.
const link = 'xmpp:design@conference.fluux.chat?join;msg=1731490000123456'
const roomJid = 'design@conference.fluux.chat'
const choose = (value: string) => fireEvent.change(screen.getByLabelText('chat.forwardDestination'), { target: { value } })
const send = () => fireEvent.click(screen.getByRole('button', { name: 'chat.forwardSend' }))

beforeEach(() => {
  vi.resetAllMocks()
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
    reject(new Error('Disconnected'))
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
})
