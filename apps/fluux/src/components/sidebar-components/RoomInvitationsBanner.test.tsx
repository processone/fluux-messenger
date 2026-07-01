import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

const acceptInvitation = vi.fn().mockResolvedValue(undefined)
const declineInvitation = vi.fn()
const setActiveRoom = vi.fn()
const setActiveConversation = vi.fn()
const getRoomInfo = vi.fn()
const acknowledgeNonAnon = vi.fn()
const isNonAnonAck = vi.fn(() => false)
let mucInvitations: Array<{ id: string; roomJid: string; from: string; password?: string }> = []

vi.mock('@fluux/sdk', () => ({
  useEvents: () => ({ mucInvitations, acceptInvitation, declineInvitation }),
  useRoomActions: () => ({ getRoomInfo, acknowledgeNonAnonymousRoom: acknowledgeNonAnon, isNonAnonymousRoomAcknowledged: isNonAnonAck }),
}))
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (sel: (s: { setActiveConversation: typeof setActiveConversation }) => unknown) => sel({ setActiveConversation }),
  useRoomStore: (sel: (s: { setActiveRoom: typeof setActiveRoom }) => unknown) => sel({ setActiveRoom }),
}))
const navigateToRooms = vi.fn()
vi.mock('@/hooks', () => ({ useRouteSync: () => ({ navigateToRooms }) }))

import { RoomInvitationsBanner } from './RoomInvitationsBanner'

describe('RoomInvitationsBanner', () => {
  beforeEach(() => { vi.clearAllMocks(); mucInvitations = [] })

  it('renders nothing when there are no invitations', () => {
    const { container } = render(<RoomInvitationsBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('warns (issue #37) before joining a non-anonymous public room; joins only on confirm', async () => {
    mucInvitations = [{ id: 'i1', roomJid: 'room@conf.example.com', from: 'friend@example.com' }]
    getRoomInfo.mockResolvedValue({ isNonAnonymous: true, isPrivate: false })
    render(<RoomInvitationsBanner />)
    fireEvent.click(screen.getByText('events.join'))
    await waitFor(() => expect(screen.getByText('rooms.nonAnonWarningConfirm')).toBeInTheDocument())
    expect(acceptInvitation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('rooms.nonAnonWarningConfirm'))
    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledWith('room@conf.example.com', undefined))
    expect(setActiveRoom).toHaveBeenCalledWith('room@conf.example.com')
  })
})
