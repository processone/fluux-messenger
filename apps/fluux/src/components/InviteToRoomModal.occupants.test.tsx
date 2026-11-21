import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { Contact, Room, RoomOccupant } from '@fluux/sdk'
import { InviteToRoomModal } from './InviteToRoomModal'

const { inviteMultipleToRoom } = vi.hoisted(() => ({ inviteMultipleToRoom: vi.fn() }))

const contacts: Contact[] = [
  { jid: 'alice@example.com', name: 'Alice Smith', presence: 'online', subscription: 'both' },
  { jid: 'bob@example.com', name: 'Bob Jones', presence: 'away', subscription: 'both' },
  { jid: 'carol@example.com', name: 'Carol White', presence: 'online', subscription: 'both' },
]

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useRoster: () => ({ contacts }),
  useRoomActions: () => ({ inviteMultipleToRoom }),
}))

vi.mock('@fluux/sdk/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk/react')>()),
  useConnectionStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: 'online' }),
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))

const NOTE = 'rooms.alreadyInRoom'

function occupant(nick: string, jid?: string): [string, RoomOccupant] {
  return [nick, { nick, jid, affiliation: 'member', role: 'participant' }]
}

// XEP-0045 reports an occupant's real JID with the resource they joined from.
function roomWith(...occupants: Array<[string, RoomOccupant]>): Room {
  return {
    jid: 'team@conference.example.com',
    name: 'Team',
    nickname: 'me',
    joined: true,
    occupants: new Map(occupants),
    unreadCount: 0,
    mentionsCount: 0,
  } as unknown as Room
}

const aliceOnTwoDevices = () => roomWith(
  occupant('alice', 'alice@example.com/phone'),
  occupant('alice-laptop', 'alice@example.com/laptop'),
)

const input = () => screen.getByPlaceholderText('rooms.searchContactsToInvite')
const sendButton = () => screen.getByRole('button', { name: 'rooms.sendInvitations' })
const rows = () => within(screen.getByTestId('contact-suggestions')).getAllByRole('button')

function openPicker(room: Room, query = '') {
  const view = render(<InviteToRoomModal isOpen onClose={() => {}} room={room} />)
  fireEvent.focus(input())
  if (query) fireEvent.change(input(), { target: { value: query } })
  return view
}

describe('InviteToRoomModal with people already in the room', () => {
  beforeEach(() => inviteMultipleToRoom.mockClear())

  it('lists someone in the room once, last, with the note, whichever resources they joined from', () => {
    openPicker(aliceOnTwoDevices())

    const listed = rows()
    expect(listed).toHaveLength(3)
    expect(listed[2]).toHaveTextContent('Alice Smith')
    expect(listed[2]).toHaveTextContent(NOTE)
    expect(listed[2]).toHaveAttribute('aria-disabled', 'true')
    expect(listed[0]).not.toHaveTextContent(NOTE)
    expect(listed[1]).not.toHaveTextContent(NOTE)
  })

  it('does not mark a contact whose nickname matches an anonymous occupant', () => {
    openPicker(roomWith(occupant('Bob Jones')))

    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it.each([
    'alice@example.com',
    'alice@example.com/phone',
    'alice@example.com/tablet',
    'ALICE@example.com',
  ])('shows why the typed address %s cannot be added', (address) => {
    openPicker(aliceOnTwoDevices(), address)

    expect(screen.getByText(NOTE)).toBeInTheDocument()
    expect(screen.queryByText('contacts.pressEnterToAdd')).not.toBeInTheDocument()

    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(sendButton()).toBeDisabled()
  })

  it('sends nothing when someone in the room is clicked or chosen with Enter', () => {
    openPicker(aliceOnTwoDevices(), 'alice')

    fireEvent.click(rows()[0])
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(rows()[0]).toHaveTextContent('Alice Smith')
    expect(sendButton()).toBeDisabled()

    fireEvent.click(sendButton())
    expect(inviteMultipleToRoom).not.toHaveBeenCalled()
  })

  it('still invites a contact outside the room', () => {
    openPicker(aliceOnTwoDevices(), 'bob')

    fireEvent.keyDown(input(), { key: 'Enter' })
    fireEvent.click(sendButton())

    expect(inviteMultipleToRoom).toHaveBeenCalledWith(
      'team@conference.example.com', ['bob@example.com'], undefined,
    )
  })

  it('stops inviting a chosen contact who joins while the window is open', () => {
    const { rerender } = openPicker(aliceOnTwoDevices(), 'bob')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(sendButton()).toBeEnabled()

    const joined = roomWith(
      occupant('alice', 'alice@example.com/phone'),
      occupant('bob', 'bob@example.com/desktop'),
    )
    rerender(<InviteToRoomModal isOpen onClose={() => {}} room={joined} />)

    expect(sendButton()).toBeDisabled()
    fireEvent.click(sendButton())
    expect(inviteMultipleToRoom).not.toHaveBeenCalled()
  })
})
