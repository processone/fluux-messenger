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

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useEvents: () => ({ mucInvitations, acceptInvitation, declineInvitation }),
  useRoomActions: () => ({
    getRoomInfo,
    acknowledgeNonAnonymousRoom: acknowledgeNonAnon,
    isNonAnonymousRoomAcknowledged: isNonAnonAck,
    // useRoomPasswordPrompt sources its join actions here; the banner only uses
    // its withPasswordPrompt wrapper, which drives acceptInvitation instead.
    joinRoom: vi.fn(),
    joinResult: vi.fn(),
  }),
}))
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (sel: (s: { setActiveConversation: typeof setActiveConversation }) => unknown) => sel({ setActiveConversation }),
  useRoomStore: (sel: (s: { setActiveRoom: typeof setActiveRoom }) => unknown) => sel({ setActiveRoom }),
}))
const navigateToRooms = vi.fn()
vi.mock('@/hooks', () => ({ useRouteSync: () => ({ navigateToRooms }) }))

import { RoomInvitationsBanner } from './RoomInvitationsBanner'
import { RoomJoinError } from '@fluux/sdk'
import { useToastStore } from '@/stores/toastStore'

describe('RoomInvitationsBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mucInvitations = []
    acceptInvitation.mockResolvedValue(undefined)
    useToastStore.setState({ toasts: [] })
  })

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

  // Issue #1126: an invitation to a password-protected room carries no password
  // unless the inviter added one. Accepting used to fail silently AND drop the
  // invitation, leaving no way back into the room.
  describe('password-protected room', () => {
    const invite = () => {
      mucInvitations = [{ id: 'i1', roomJid: 'private@conf.example.com', from: 'friend@example.com' }]
      getRoomInfo.mockResolvedValue({ isNonAnonymous: false, isPrivate: true })
    }

    it('asks for the password when the join is refused, then retries with it', async () => {
      invite()
      acceptInvitation
        .mockRejectedValueOnce(new RoomJoinError('private@conf.example.com', 'not-authorized'))
        .mockResolvedValue(undefined)

      render(<RoomInvitationsBanner />)
      fireEvent.click(screen.getByText('events.join'))

      const input = await screen.findByLabelText('rooms.roomPassword')
      fireEvent.change(input, { target: { value: 's3cret' } })
      fireEvent.submit(input)

      await waitFor(() =>
        expect(acceptInvitation).toHaveBeenLastCalledWith('private@conf.example.com', 's3cret')
      )
      expect(setActiveRoom).toHaveBeenCalledWith('private@conf.example.com')
      expect(useToastStore.getState().toasts).toHaveLength(0)
    })

    it('does not open the room when the password prompt is cancelled', async () => {
      invite()
      acceptInvitation.mockRejectedValue(new RoomJoinError('private@conf.example.com', 'not-authorized'))

      render(<RoomInvitationsBanner />)
      fireEvent.click(screen.getByText('events.join'))

      fireEvent.click(await screen.findByText('common.cancel'))

      await waitFor(() =>
        expect(screen.queryByLabelText('rooms.roomPassword')).not.toBeInTheDocument()
      )
      expect(setActiveRoom).not.toHaveBeenCalled()
      expect(useToastStore.getState().toasts).toHaveLength(0)
    })

    it('toasts a refusal a password cannot fix, without opening the room', async () => {
      invite()
      acceptInvitation.mockRejectedValue(new RoomJoinError('private@conf.example.com', 'registration-required'))

      render(<RoomInvitationsBanner />)
      fireEvent.click(screen.getByText('events.join'))

      await waitFor(() =>
        expect(useToastStore.getState().toasts.some((t) => t.message === 'rooms.membersOnly')).toBe(true)
      )
      expect(setActiveRoom).not.toHaveBeenCalled()
      expect(screen.queryByLabelText('rooms.roomPassword')).not.toBeInTheDocument()
    })
  })
})
