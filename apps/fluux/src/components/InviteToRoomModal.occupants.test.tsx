import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { Contact, Room, RoomOccupant } from '@fluux/sdk'
import { InviteToRoomModal } from './InviteToRoomModal'

const contacts: Contact[] = [
  { jid: 'alice@example.com', name: 'Alice Smith', presence: 'online', subscription: 'both' },
  { jid: 'bob@example.com', name: 'Bob Jones', presence: 'away', subscription: 'both' },
]

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useRoster: () => ({ contacts }),
  useRoomActions: () => ({ inviteMultipleToRoom: vi.fn() }),
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

function occupant(nick: string, jid: string): [string, RoomOccupant] {
  return [nick, { nick, jid, affiliation: 'member', role: 'participant' }]
}

// XEP-0045 reports an occupant's real JID with the resource they joined from.
const room = {
  jid: 'team@conference.example.com',
  name: 'Team',
  nickname: 'me',
  joined: true,
  occupants: new Map([
    occupant('alice', 'alice@example.com/phone'),
    occupant('alice-laptop', 'alice@example.com/laptop'),
  ]),
  unreadCount: 0,
  mentionsCount: 0,
} as unknown as Room

function openPicker(query = '') {
  render(<InviteToRoomModal isOpen onClose={() => {}} room={room} />)
  const input = screen.getByPlaceholderText('rooms.searchContactsToInvite')
  fireEvent.focus(input)
  if (query) fireEvent.change(input, { target: { value: query } })
}

describe('InviteToRoomModal with occupants who joined from a resource', () => {
  it('hides a contact already in the room and keeps the others', () => {
    openPicker()

    expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
    expect(screen.getByText('Bob Jones')).toBeInTheDocument()
  })

  it.each([
    'alice@example.com',
    'alice@example.com/phone',
    'alice@example.com/laptop',
  ])('does not offer to add the typed occupant address %s', (address) => {
    openPicker(address)

    expect(screen.queryByText('contacts.pressEnterToAdd')).not.toBeInTheDocument()
  })

  it('still offers to add a typed address outside the room', () => {
    openPicker('carol@example.com')

    expect(screen.getByText('contacts.pressEnterToAdd')).toBeInTheDocument()
  })
})
