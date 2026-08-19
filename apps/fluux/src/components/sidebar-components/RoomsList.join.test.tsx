/**
 * Issue #1126: double-clicking a bookmarked, password-protected room in the
 * sidebar is the exact path the bug was reported on. It used to join with no
 * password, get refused, and (with the error swallowed) sit at "Joining…".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Room } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

const h = vi.hoisted(() => ({
  room: null as Room | null,
  joinRoom: vi.fn(),
  joinResult: vi.fn(),
  activateRoom: vi.fn(),
}))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    roomActivityTone: () => 'neutral',
    generateConsistentColorHexSync: () => '#123456',
    roomStore: {
      getState: () => ({
        activeRoomJid: null,
        getRoom: () => h.room,
        activateRoom: h.activateRoom,
      }),
    },
    useRoomActions: () => ({
      joinRoom: h.joinRoom,
      joinResult: h.joinResult,
      leaveRoom: vi.fn(),
      setBookmark: vi.fn(),
      removeBookmark: vi.fn(),
      setActiveRoom: vi.fn(),
    }),
  }
})

vi.mock('@fluux/sdk/react', () => ({
  useRoomStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      roomSidebarJids: () => [`bookmarked ${h.room?.jid ?? ''}`],
      activeRoomJid: null,
      getRoom: () => h.room,
      drafts: new Map(),
    }),
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setActiveConversation: vi.fn() }),
  useIgnoreStore: (selector: (s: { ignoredUsers: Record<string, unknown[]> }) => unknown) =>
    selector({ ignoredUsers: {} }),
}))

vi.mock('@/hooks', () => ({
  useContextMenu: () => ({
    isOpen: false,
    longPressTriggered: { current: false },
    handleContextMenu: () => {},
    handleTouchStart: () => {},
    handleTouchEnd: () => {},
    position: { x: 0, y: 0 },
    menuRef: { current: null },
    close: () => {},
  }),
  useListKeyboardNav: () => ({
    selectedIndex: -1,
    isKeyboardNav: false,
    getItemProps: () => ({}),
    getItemAttribute: () => ({}),
    getContainerProps: () => ({}),
  }),
  useRouteSync: () => ({ navigateToRooms: vi.fn() }),
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string; densityMode: string }) => unknown) =>
    selector({ timeFormat: '24h', densityMode: 'comfortable' }),
}))

vi.mock('../Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('./RoomInvitationsBanner', () => ({ RoomInvitationsBanner: () => null }))

// Imported AFTER the mocks so the component picks them up.
import { RoomsList } from './RoomsList'
import { RoomJoinError } from '@fluux/sdk'
import { useToastStore } from '@/stores/toastStore'

const ROOM_JID = 'board@conference.example.com'

const makeRoom = (over: Partial<Room> = {}): Room =>
  ({
    jid: ROOM_JID,
    name: 'Board',
    nickname: 'me',
    joined: false,
    isJoining: false,
    isBookmarked: true,
    autojoin: false,
    occupants: new Map(),
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set<string>(),
    lastMessage: null,
    ...over,
  }) as unknown as Room

describe('RoomsList join', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useToastStore.setState({ toasts: [] })
    h.room = makeRoom()
    h.joinRoom.mockResolvedValue(undefined)
    h.joinResult.mockResolvedValue(undefined)
  })

  it('asks for the password when the server refuses the join, then retries', async () => {
    h.joinResult
      .mockRejectedValueOnce(new RoomJoinError(ROOM_JID, 'not-authorized'))
      .mockResolvedValue(undefined)

    render(<RoomsList />)
    fireEvent.doubleClick(screen.getByText('Board'))

    const input = await screen.findByLabelText('rooms.roomPassword')
    fireEvent.change(input, { target: { value: 's3cret' } })
    fireEvent.submit(input)

    await waitFor(() =>
      expect(h.joinRoom).toHaveBeenLastCalledWith(ROOM_JID, 'me', { password: 's3cret' })
    )
    // Joined for real → the room is opened, and no error was surfaced.
    await waitFor(() => expect(h.activateRoom).toHaveBeenCalledWith(ROOM_JID))
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('does not open a room the user cancelled the password prompt for', async () => {
    h.joinResult.mockRejectedValue(new RoomJoinError(ROOM_JID, 'not-authorized'))

    render(<RoomsList />)
    fireEvent.doubleClick(screen.getByText('Board'))

    fireEvent.click(await screen.findByText('common.cancel'))

    await waitFor(() =>
      expect(screen.queryByLabelText('rooms.roomPassword')).not.toBeInTheDocument()
    )
    expect(h.activateRoom).not.toHaveBeenCalled()
    // Cancelling is not a failure - no error toast.
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('still toasts a failure a password cannot fix', async () => {
    h.joinResult.mockRejectedValue(new RoomJoinError(ROOM_JID, 'registration-required'))

    render(<RoomsList />)
    fireEvent.doubleClick(screen.getByText('Board'))

    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message === 'rooms.membersOnly')).toBe(true)
    )
    expect(screen.queryByLabelText('rooms.roomPassword')).not.toBeInTheDocument()
  })
})
