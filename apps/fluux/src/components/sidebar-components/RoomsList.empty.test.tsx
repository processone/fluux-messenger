import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useRoomActions: () => ({
      joinRoom: vi.fn(),
      joinResult: vi.fn(),
      leaveRoom: vi.fn(),
      setBookmark: vi.fn(),
      removeBookmark: vi.fn(),
      setActiveRoom: vi.fn(),
    }),
  }
})

vi.mock('@fluux/sdk/react', () => ({
  useRoomStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ roomSidebarJids: () => [], activeRoomJid: null, getRoom: () => null, drafts: new Map() }),
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setActiveConversation: vi.fn() }),
  useIgnoreStore: (selector: (s: { ignoredUsers: Record<string, unknown[]> }) => unknown) =>
    selector({ ignoredUsers: {} }),
}))

vi.mock('@/hooks', () => ({
  useContextMenu: () => ({}),
  useListKeyboardNav: () => ({
    selectedIndex: -1,
    isKeyboardNav: false,
    getItemProps: () => ({}),
    getItemAttribute: () => ({}),
    getContainerProps: () => ({}),
  }),
  useRouteSync: () => ({ navigateToRooms: vi.fn() }),
}))

vi.mock('./RoomInvitationsBanner', () => ({
  RoomInvitationsBanner: () => <div data-testid="room-invitations" />,
}))

import { RoomsList } from './RoomsList'

describe('RoomsList without rooms', () => {
  it('still shows pending invitations above the empty state', () => {
    render(<RoomsList />)
    expect(screen.getByTestId('room-invitations')).toBeInTheDocument()
    expect(screen.getByText('rooms.noRooms')).toBeInTheDocument()
  })
})
