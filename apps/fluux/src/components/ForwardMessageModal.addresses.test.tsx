import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Contact, Conversation, Room } from '@fluux/sdk'
import { ForwardMessageModal } from './ForwardMessageModal'

const fixture = vi.hoisted(() => ({
  contacts: [] as Contact[],
  conversations: new Map<string, Conversation>(),
  rooms: new Map<string, Room>(),
  chatSend: vi.fn(),
  roomSend: vi.fn(),
}))

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useRoster: () => ({ contacts: fixture.contacts }),
  useChatActions: () => ({ sendMessage: fixture.chatSend }),
  useRoomActions: () => ({ sendMessage: fixture.roomSend }),
  roomStore: { getState: () => ({ rooms: fixture.rooms }) },
  chatStore: { getState: () => ({ conversations: fixture.conversations }) },
}))
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (state: { conversations: Map<string, Conversation> }) => unknown) => selector({ conversations: fixture.conversations }),
  useRoomStore: (selector: (state: { rooms: Map<string, Room> }) => unknown) => selector({ rooms: fixture.rooms }),
  useConnectionStore: (selector: (state: { status: string }) => unknown) => selector({ status: 'online' }),
}))

// Forward resolves exact stored addresses, unlike the account-level room-management pickers.
// Demo contact/room identities with case variants reproduce the shared-picker regression.
describe('Forward destination address spelling', () => {
  beforeEach(() => {
    fixture.contacts = []
    fixture.conversations.clear()
    fixture.rooms.clear()
    fixture.chatSend.mockReset().mockResolvedValue('sent-chat-message')
    fixture.roomSend.mockReset().mockResolvedValue('sent-room-message')
  })

  it.each(['chat', 'room'] as const)('retains the existing %s destination beside a case-variant roster entry', async (kind) => {
    const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
    const name = kind === 'chat' ? 'Emma' : 'Team Chat'
    fixture.contacts = [{
      jid: kind === 'chat' ? 'Emma@fluux.chat' : 'Team@conference.fluux.chat',
      name: kind === 'chat' ? 'Emma Wilson' : 'Team',
      presence: 'online', subscription: 'both',
    }]
    if (kind === 'chat') {
      fixture.conversations.set(jid, { id: jid, name, type: 'chat', unreadCount: 0 })
    } else {
      fixture.rooms.set(jid, {
        jid, name, joined: true, nickname: 'You', occupants: new Map(), typingUsers: new Set(),
        isBookmarked: true, unreadCount: 0, mentionsCount: 0,
      })
    }
    const onClose = vi.fn()
    render(<ForwardMessageModal link="xmpp:design@conference.fluux.chat?join;msg=1731490000123456" onClose={onClose} />)
    const input = screen.getByLabelText('chat.forwardDestination')
    fireEvent.focus(input)
    const list = within(screen.getByTestId('contact-suggestions'))
    expect(list.getAllByRole('button')).toHaveLength(2)
    fireEvent.click(list.getByText(jid, { exact: true }))
    // A case-variant roster entry must not replace the chosen destination's label.
    expect(screen.getByText(name, { exact: true })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'chat.forwardSend' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const action = kind === 'chat' ? fixture.chatSend : fixture.roomSend
    const otherAction = kind === 'chat' ? fixture.roomSend : fixture.chatSend
    expect(action).toHaveBeenCalledExactlyOnceWith(jid, expect.any(String), expect.any(Object))
    expect(otherAction).not.toHaveBeenCalled()
  })
})
