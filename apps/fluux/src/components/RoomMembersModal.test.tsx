import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RoomMembersModal } from './RoomMembersModal'
import type { Room, RoomAffiliation } from '@fluux/sdk'

// ---- Mock SDK methods -----------------------------------------------

const mockSetAffiliation = vi.fn()
const mockQueryAffiliationList = vi.fn()

const mockContacts = [
  { jid: 'roster1@example.com', name: 'Roster One', presence: 'online', subscription: 'both' },
  { jid: 'roster2@example.com', name: 'Roster Two', presence: 'away', subscription: 'both' },
]

vi.mock('@fluux/sdk', () => ({
  useRoom: () => ({
    setAffiliation: mockSetAffiliation,
    queryAffiliationList: mockQueryAffiliationList,
  }),
  useRoster: () => ({
    contacts: mockContacts,
  }),
  useChat: () => ({
    conversations: [],
  }),
  getAvailableAffiliations: (selfAff: RoomAffiliation, _targetAff: RoomAffiliation) => {
    if (selfAff === 'owner') return ['owner', 'admin', 'member', 'none', 'outcast']
    return []
  },
  matchNameOrJid: (name: string, jid: string, query: string) => {
    const lowerQuery = query.toLowerCase()
    return name.toLowerCase().includes(lowerQuery) || jid.split('@')[0].toLowerCase().includes(lowerQuery)
  },
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: 'online' }),
  useContactTime: () => null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'rooms.manageMembership': 'Manage Membership',
        'rooms.owners': 'Owners',
        'rooms.admins': 'Admins',
        'rooms.members': 'Members',
        'rooms.banned': 'Banned',
        'rooms.searchMembers': 'Search members...',
        'rooms.jidPlaceholder': 'Add member...',
        'rooms.addMember': 'Add Member',
        'rooms.memberAdded': 'Member added',
        'rooms.affiliationError': 'Affiliation error',
        'rooms.affiliationChanged': 'Affiliation changed',
        'rooms.noMembersInList': 'No members',
        'rooms.affiliationOwner': 'Owner',
        'rooms.affiliationAdmin': 'Admin',
        'rooms.affiliationMember': 'Member',
        'rooms.affiliationOutcast': 'Outcast',
        'rooms.affiliationNone': 'None',
        'rooms.makeOwner': 'Make owner',
        'rooms.makeAdmin': 'Make admin',
        'rooms.makeMember': 'Make member',
        'rooms.removeAffiliation': 'Remove',
        'rooms.ban': 'Ban',
        'contacts.searchContacts': 'Search contacts...',
        'contacts.addMoreContacts': 'Add more...',
        'contacts.keyboardHint': 'Tab/↑↓ to navigate, Enter to select',
        'contacts.noContactsFound': 'No contacts found',
        'contacts.pressEnterToAdd': 'Press Enter to add',
      }
      return translations[key] || key
    },
  }),
}))

vi.mock('@/stores/toastStore', () => ({
  useToastStore: (selector: (state: { addToast: unknown }) => unknown) =>
    selector({ addToast: vi.fn() }),
}))

// ---- Helpers -----------------------------------------------

function createMockRoom(overrides?: Partial<Room>): Room {
  const occupants = new Map()
  occupants.set('self', {
    nick: 'self',
    jid: 'me@example.com',
    affiliation: 'owner' as RoomAffiliation,
    role: 'moderator',
  })
  occupants.set('occupant1', {
    nick: 'occupant1',
    jid: 'occupant1@example.com',
    affiliation: 'member' as RoomAffiliation,
    role: 'participant',
  })

  return {
    jid: 'room@conference.example.com',
    name: 'Test Room',
    nickname: 'self',
    occupants,
    joined: true,
    affiliatedMembers: [
      { jid: 'affiliated1@example.com', nick: 'Affiliated One', affiliation: 'member' as RoomAffiliation },
    ],
    unreadCount: 0,
    mentionsCount: 0,
    messages: [],
    typingUsers: [],
    ...overrides,
  } as Room
}

describe('RoomMembersModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQueryAffiliationList.mockResolvedValue([])
    mockSetAffiliation.mockResolvedValue(undefined)
  })

  it('should render ContactSelector in the add member form', () => {
    render(<RoomMembersModal room={createMockRoom()} onClose={vi.fn()} />)

    // ContactSelector renders an input with the placeholder
    expect(screen.getByPlaceholderText('Add member...')).toBeInTheDocument()
  })

  it('should show extra suggestions from room occupants when typing', () => {
    render(<RoomMembersModal room={createMockRoom()} onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('Add member...')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'occupant' } })

    // occupant1 should appear as an extra suggestion
    expect(screen.getByText('occupant1@example.com')).toBeInTheDocument()
  })

  it('should show extra suggestions from affiliated members when typing', () => {
    render(<RoomMembersModal room={createMockRoom()} onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('Add member...')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'affiliated' } })

    expect(screen.getByText('Affiliated One')).toBeInTheDocument()
  })

  it('should call setAffiliation when selecting a JID and clicking Add', async () => {
    render(<RoomMembersModal room={createMockRoom()} onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('Add member...')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'roster1' } })

    // Select from dropdown
    fireEvent.click(screen.getByText('Roster One'))

    // Click Add Member
    fireEvent.click(screen.getByText('Add Member'))

    await waitFor(() => {
      expect(mockSetAffiliation).toHaveBeenCalledWith(
        'room@conference.example.com',
        'roster1@example.com',
        'member'
      )
    })
  })

  it('should clear selection after successful add', async () => {
    render(<RoomMembersModal room={createMockRoom()} onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('Add member...')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'roster1' } })
    fireEvent.click(screen.getByText('Roster One'))

    // Chip should appear (rounded-full is unique to chips)
    expect(screen.getByText('Roster One').closest('.rounded-full')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Add Member'))

    await waitFor(() => {
      expect(mockSetAffiliation).toHaveBeenCalled()
    })

    // Selection chip should be gone after successful add
    await waitFor(() => {
      const rosterOneElements = screen.queryAllByText('Roster One')
      const chipElement = rosterOneElements.find(el => el.closest('.rounded-full'))
      expect(chipElement).toBeUndefined()
    })
  })

  it('should show roster contacts in dropdown', () => {
    render(<RoomMembersModal room={createMockRoom()} onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('Add member...')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'roster' } })

    expect(screen.getByText('Roster One')).toBeInTheDocument()
    expect(screen.getByText('Roster Two')).toBeInTheDocument()
  })
})
