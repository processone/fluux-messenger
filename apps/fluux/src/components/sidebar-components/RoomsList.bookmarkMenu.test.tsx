/**
 * The sidebar room menu's bookmark writes (Auto-join toggle, Remove bookmark)
 * close the menu on click, so a failure must be reported in a toast instead of
 * being dropped as an unhandled promise rejection with nothing shown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Room } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

const h = vi.hoisted(() => ({
  room: null as Room | null,
  setBookmark: vi.fn(),
  removeBookmark: vi.fn(),
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
        activateRoom: vi.fn(),
      }),
    },
    useRoomActions: () => ({
      joinRoom: vi.fn(),
      joinResult: vi.fn(),
      leaveRoom: vi.fn(),
      setBookmark: h.setBookmark,
      removeBookmark: h.removeBookmark,
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

// The room's context menu is open, as after a right-click on its row.
vi.mock('@/hooks', () => ({
  useContextMenu: () => ({
    isOpen: true,
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
import { useToastStore } from '@/stores/toastStore'

const ROOM_JID = 'team@conference.example.com'

const makeRoom = (over: Partial<Room> = {}): Room =>
  ({
    jid: ROOM_JID,
    name: 'Team',
    nickname: 'me',
    joined: true,
    isJoining: false,
    isBookmarked: true,
    autojoin: true,
    occupants: new Map(),
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set<string>(),
    lastMessage: null,
    ...over,
  }) as unknown as Room

/** The rejection the SDK passes on when the server answers a bookmark write with an error. */
const serverRefusal = (condition: string) =>
  Object.assign(new Error(condition), { name: 'StanzaError', condition })

const errorToasts = () =>
  useToastStore.getState().toasts.filter((t) => t.type === 'error').map((t) => t.message)

// Promise rejections nothing handled while a test runs.
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
/** Node reports an unhandled rejection once the microtasks after it have run. */
const afterRejectionsReported = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('RoomsList sidebar bookmark menu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useToastStore.setState({ toasts: [] })
    h.room = makeRoom()
    unhandled.length = 0
    process.on('unhandledRejection', onUnhandled)
  })

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
  })

  it('shows an error when the Auto-join save fails', async () => {
    h.setBookmark.mockRejectedValue(serverRefusal('conflict'))

    render(<RoomsList />)
    fireEvent.click(screen.getByText('rooms.autojoinOn'))

    expect(h.setBookmark).toHaveBeenCalledWith(ROOM_JID, { name: 'Team', nick: 'me', autojoin: false })
    await waitFor(() => expect(errorToasts()).toEqual(['rooms.failedToSaveBookmark']))
    await afterRejectionsReported()
    expect(unhandled).toEqual([])
  })

  it('shows an error when removing the bookmark fails', async () => {
    h.removeBookmark.mockRejectedValue(serverRefusal('item-not-found'))

    render(<RoomsList />)
    fireEvent.click(screen.getByText('rooms.removeBookmark'))

    expect(h.removeBookmark).toHaveBeenCalledWith(ROOM_JID)
    await waitFor(() => expect(errorToasts()).toEqual(['rooms.failedToRemoveBookmark']))
    await afterRejectionsReported()
    expect(unhandled).toEqual([])
  })

  it('shows no error when the Auto-join save succeeds', async () => {
    h.setBookmark.mockResolvedValue(undefined)

    render(<RoomsList />)
    fireEvent.click(screen.getByText('rooms.autojoinOn'))
    // The menu's own handlers on the save run before this await resumes.
    await h.setBookmark.mock.results[0].value

    expect(useToastStore.getState().toasts).toEqual([])
  })
})
