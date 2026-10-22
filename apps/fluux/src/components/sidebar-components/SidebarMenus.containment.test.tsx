import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Contact, Room } from '@fluux/sdk'
import { ContactList } from './ContactList'
import { RoomsList } from './RoomsList'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

const fixture = vi.hoisted(() => ({
  contact: { jid: 'mia@fluux.chat', name: 'Mia Thompson', presence: 'offline', subscription: 'both' } as Contact,
  room: {
    jid: 'team@conference.fluux.chat', name: 'Team Chat', nickname: 'me',
    joined: true, isBookmarked: true, autojoin: false, occupants: new Map(),
    unreadCount: 0, mentionsCount: 0, typingUsers: new Set(),
  } as Room,
  startChat: vi.fn(),
  leaveRoom: vi.fn(),
}))

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@fluux/sdk')>(),
  useContactIdentities: () => new Map([[fixture.contact.jid, fixture.contact]]),
  useRosterActions: () => ({ removeContact: vi.fn(), renameContact: vi.fn() }),
  useEvents: () => ({ subscriptionRequests: [] }),
  useBlocking: () => ({ blockJid: vi.fn() }),
  useAdminPermissions: () => ({ isAdmin: false, hasUserCommands: false, canManageUser: () => false }),
  useRoomActions: () => ({ leaveRoom: fixture.leaveRoom }),
  roomStore: { getState: () => ({ activeRoomJid: null, getRoom: () => fixture.room }) },
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (select: (s: unknown) => unknown) => select({ status: 'online' }),
  useRosterStore: (select: (s: unknown) => unknown) => select({
    contactSidebarEntries: () => [`offline ${fixture.contact.jid}`],
    contacts: new Map([[fixture.contact.jid, fixture.contact]]),
  }),
  useRoomStore: (select: (s: unknown) => unknown) => select({
    roomSidebarJids: () => [`joined ${fixture.room.jid}`], activeRoomJid: null,
    getRoom: () => fixture.room, drafts: new Map(),
  }),
  useChatStore: (select: (s: unknown) => unknown) => select({ setActiveConversation: vi.fn() }),
  useIgnoreStore: (select: (s: unknown) => unknown) => select({ ignoredUsers: {} }),
}))

// Exercise the real hold, ref, positioning and dismissal hooks, not an always-open mock.
vi.mock('@/hooks', async () => ({
  ...await import('@/hooks/useContextMenu'),
  useTypeToFocus: () => {},
  useRouteSync: () => ({ navigateToRooms: vi.fn() }),
  useListKeyboardNav: () => ({
    selectedIndex: -1, isKeyboardNav: false,
    getItemProps: () => ({}), getItemAttribute: () => ({}), getContainerProps: () => ({}),
  }),
}))
vi.mock('../Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('../Avatar', () => ({ Avatar: () => null }))
vi.mock('./types', () => ({ useSidebarZone: () => null, ContactTooltipContent: () => null }))
vi.mock('./RoomInvitationsBanner', () => ({ RoomInvitationsBanner: () => null }))

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('issue #1790 — every sidebar long-press menu escapes the scrolling list', () => {
  for (const kind of ['contact', 'room'] as const) {
    it(`${kind}: preserves containment, width, action and dismissal after a real hook-driven hold`, () => {
      vi.useFakeTimers()
      const isContact = kind === 'contact'
      const { unmount } = render(
        <div data-testid="scrolling-list" style={{ overflowY: 'auto', height: 518, marginTop: 78 }}>
          {isContact ? <ContactList onStartChat={fixture.startChat} /> : <RoomsList />}
        </div>,
      )
      const row = screen.getByText(isContact ? fixture.contact.name : fixture.room.name)
      const label = isContact ? 'contacts.startChat' : 'rooms.leaveRoom'
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
      const hold = () => {
        fireEvent.touchStart(row, { touches: [{ clientX: 215, clientY: 552 }] })
        act(() => vi.advanceTimersByTime(500))
        fireEvent.touchEnd(row)
      }
      hold()
      const action = screen.getByRole('button', { name: label })
      const menu = action.parentElement!
      // DOM hit-testing alone missed the iOS clipping; the native paint check owns that proof.
      expect(menu.parentElement).toBe(document.body)
      expect(screen.getByTestId('scrolling-list')).not.toContainElement(menu)
      expect(menu).toHaveClass(isContact ? 'min-w-40' : 'min-w-48')
      expect(menu).toHaveStyle({ left: '215px', top: '552px' })
      fireEvent.mouseDown(action)
      expect(action).toBeInTheDocument()
      fireEvent.click(action)
      expect(menu).not.toBeInTheDocument()
      if (isContact) expect(fixture.startChat).toHaveBeenCalledWith(fixture.contact)
      else expect(fixture.leaveRoom).toHaveBeenCalledWith(fixture.room.jid)
      hold()
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
      hold()
      fireEvent.scroll(screen.getByTestId('scrolling-list'))
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
      hold()
      unmount()
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
    })
  }
})
