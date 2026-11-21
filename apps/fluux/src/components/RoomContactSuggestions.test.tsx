import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import type { Room, RoomOccupant } from '@fluux/sdk'
import { DEMO_CONTACTS } from '@/demo/contacts'
import { RoomMembersModal } from './RoomMembersModal'
import { RoomHatsModal } from './RoomHatsModal'

const { setAffiliation, queryAffiliationList, listHats, listHatAssignments, assignHat, unassignHat } = vi.hoisted(() => ({
  setAffiliation: vi.fn(),
  queryAffiliationList: vi.fn(),
  listHats: vi.fn(),
  listHatAssignments: vi.fn(),
  assignHat: vi.fn(),
  unassignHat: vi.fn(),
}))

// Keep the real selectors and address utilities; only the service hooks are stand-ins.
vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useRoster: () => ({ contacts: DEMO_CONTACTS.filter(c => c.jid !== 'james@fluux.chat') }),
  useRoomModeration: () => ({ setAffiliation, queryAffiliationList, listHats, listHatAssignments, assignHat, unassignHat }),
}))

const roomJid = 'team@conference.fluux.chat'
const jamesJid = 'james@fluux.chat'
const emma = DEMO_CONTACTS.find(c => c.jid === 'emma@fluux.chat')!
const speaker = { uri: 'urn:hat:speaker', title: 'Speaker' }

// Mirrors the demo room presences, including the device addresses parsed by MUC.
function room(mixedCase = false): Room {
  const occupants: RoomOccupant[] = [
    { nick: 'You', jid: 'you@fluux.chat/desktop', affiliation: 'owner', role: 'moderator' },
    { nick: 'Emma', jid: `${mixedCase ? 'Emma' : 'emma'}@fluux.chat/phone`, affiliation: 'none', role: 'participant' },
    { nick: 'James', jid: `${mixedCase ? 'James@fluux.chat' : jamesJid}/desktop`, affiliation: 'none', role: 'participant' },
    { nick: 'James on tablet', jid: `${jamesJid}/tablet`, affiliation: 'none', role: 'participant' },
    { nick: 'Sophia', jid: 'sophia@fluux.chat', affiliation: 'none', role: 'participant' },
    { nick: 'Liam Brooks', affiliation: 'none', role: 'participant' },
  ]
  return {
    jid: roomJid,
    name: 'Team Chat',
    nickname: 'You',
    joined: true,
    isBookmarked: true,
    typingUsers: new Set(),
    occupants: new Map(occupants.map(o => [o.nick, o])),
    unreadCount: 0,
    mentionsCount: 0,
  }
}

async function openPicker(kind: 'members' | 'hats', fixture = room()) {
  if (kind === 'members') {
    render(<RoomMembersModal room={fixture} onClose={() => {}} />)
    await waitFor(() => expect(queryAffiliationList).toHaveBeenCalled())
  } else {
    render(<RoomHatsModal room={fixture} onClose={() => {}} />)
    await screen.findByText(speaker.title)
    fireEvent.click(screen.getByRole('button', { name: /rooms.hatsAssignments/ }))
    await waitFor(() => expect(listHatAssignments).toHaveBeenCalled())
  }
  const placeholder = kind === 'members' ? 'rooms.jidPlaceholder' : 'rooms.hatJidPlaceholder'
  const input = screen.getAllByPlaceholderText(placeholder).at(-1)!
  fireEvent.focus(input)
  return input
}

function rows() {
  return within(screen.getByTestId('contact-suggestions')).queryAllByRole('button')
}

// Membership and hat assignments identify accounts, not individual connections.
// Both pickers must preserve that identity through selection and submission.
describe.each(['members', 'hats'] as const)('%s occupant suggestions', (kind) => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryAffiliationList.mockResolvedValue([])
    setAffiliation.mockResolvedValue(undefined)
    listHats.mockResolvedValue([speaker])
    listHatAssignments.mockResolvedValue([])
    assignHat.mockResolvedValue(undefined)
    unassignHat.mockResolvedValue(undefined)
  })

  it.each([false, true])('merges a resource occupant with their roster row (mixed case: %s)', async (mixedCase) => {
    const input = await openPicker(kind, room(mixedCase))
    fireEvent.change(input, { target: { value: 'emma' } })

    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toHaveTextContent(emma.name)
    expect(rows()[0]).toHaveTextContent(emma.jid)
    expect(rows()[0]).not.toHaveTextContent('/phone')
  })

  it.each([false, true])('chooses a non-roster occupant once and acts on their bare address (mixed case: %s)', async (mixedCase) => {
    const input = await openPicker(kind, room(mixedCase))
    fireEvent.change(input, { target: { value: 'james' } })

    expect(rows()).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: kind === 'members' ? 'rooms.addMember' : 'rooms.assignHat' }))

    const action = kind === 'members' ? setAffiliation : assignHat
    await waitFor(() => expect(action).toHaveBeenCalledExactlyOnceWith(
      roomJid, jamesJid, kind === 'members' ? 'member' : speaker.uri,
    ))
  })

  it.each([false, true])('excludes every device for existing membership or the selected hat (stored variant: %s)', async (storedVariant) => {
    const memberJid = storedVariant ? 'James@fluux.chat' : jamesJid
    const assignedJid = storedVariant ? 'James@fluux.chat/desktop' : jamesJid
    queryAffiliationList.mockResolvedValue([{ jid: memberJid, affiliation: 'member' }])
    listHatAssignments.mockResolvedValue([{ jid: assignedJid, ...speaker }])
    const input = await openPicker(kind)
    // Wait for the loaded entry, not just the request's start.
    await screen.findByText(kind === 'members' ? memberJid : assignedJid)
    fireEvent.change(input, { target: { value: 'james' } })

    expect(rows()).toHaveLength(0)
    if (kind === 'hats') {
      fireEvent.click(screen.getByRole('button', { name: 'rooms.unassignHat' }))
      await waitFor(() => expect(unassignHat).toHaveBeenCalledExactlyOnceWith(roomJid, assignedJid, speaker.uri))
    }
  })

  it('keeps a bare-address contact and does not turn an anonymous nickname into another suggestion', async () => {
    const input = await openPicker(kind)
    fireEvent.change(input, { target: { value: 'sophia' } })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toHaveTextContent('sophia@fluux.chat')

    fireEvent.change(input, { target: { value: 'Liam Brooks' } })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toHaveTextContent('liam@fluux.chat')
  })
})
