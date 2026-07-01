/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mock ConversationList and ArchiveList before importing Sidebar
vi.mock('./sidebar-components/ConversationList', () => ({
  ConversationList: () => <div data-testid="active-list" />,
  ArchiveList: () => <div data-testid="archived-list" />,
}))

// Mock heavy sidebar sub-components
vi.mock('./sidebar-components', () => ({
  SidebarZoneContext: { Provider: ({ children }: { children: React.ReactNode }) => <>{children}</> },
  SIDEBAR_MIN_WIDTH: 200,
  SIDEBAR_MAX_WIDTH: 480,
  SIDEBAR_DEFAULT_WIDTH: 280,
  SIDEBAR_WIDTH_KEY: 'sidebar-width',
  IconRailNavLink: () => null,
  StatusOrPresence: () => null,
  ConversationList: () => <div data-testid="active-list" />,
  ArchiveList: () => <div data-testid="archived-list" />,
  ContactList: () => null,
  RoomsList: () => null,
  SearchView: () => null,
  UserMenu: () => null,
}))

vi.mock('./AdminDashboard', () => ({ AdminDashboard: () => null }))
vi.mock('./BrowseRoomsModal', () => ({ BrowseRoomsModal: () => null }))
vi.mock('./JoinRoomModal', () => ({ JoinRoomModal: () => null }))
vi.mock('./Avatar', () => ({ Avatar: () => null }))
vi.mock('./Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('./AddContactModal', () => ({ AddContactModal: () => null }))
vi.mock('./CreateRoomModal', () => ({ CreateRoomModal: () => null }))
vi.mock('./CreateQuickChatModal', () => ({ CreateQuickChatModal: () => null }))
vi.mock('./NewMessageModal', () => ({ NewMessageModal: () => null }))
vi.mock('./settings-components', () => ({
  SettingsSidebar: () => null,
  DEFAULT_SETTINGS_CATEGORY: 'profile',
}))
vi.mock('@/utils/performLogout', () => ({ performLogout: vi.fn() }))

// Mock SDK stores and hooks
vi.mock('@fluux/sdk', () => ({
  useXMPP: () => ({ client: { disconnect: vi.fn() } }),
}))
vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ jid: 'user@example.com', ownAvatar: null, ownNickname: 'User', status: 'online' }),
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      conversationMeta: new Map(),
      activeConversationId: null,
      typingStates: new Map(),
      drafts: new Map(),
      conversations: new Map(),
      conversationSidebarIds: () => [],
      archivedConversationSidebarIds: () => [],
    }),
  useRoomStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      totalMentionsCount: () => 0,
      totalNotifiableUnreadCount: () => 0,
    }),
  useEventsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ subscriptionRequests: [] }),
  useAdminStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ isAdmin: false }),
  useRosterStore: () => ({}),
}))

vi.mock('@/stores/modalStore', () => ({
  useModalStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      quickChat: false,
      addContact: false,
      newMessage: false,
      presenceMenu: false,
      open: vi.fn(),
      close: vi.fn(),
    }),
}))

vi.mock('@/hooks', () => ({
  useClickOutside: vi.fn(),
  useWindowDrag: () => ({ dragRegionProps: {} }),
  useRouteSync: () => ({
    sidebarView: 'messages',
    settingsCategory: null,
    navigateToSettings: vi.fn(),
    navigateToContacts: vi.fn(),
    navigateToMessages: vi.fn(),
  }),
}))

import React from 'react'
import { Sidebar } from './Sidebar'

describe('Sidebar archive toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    // Provide a matchMedia stub
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: query.includes('min-width: 768px'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    })
  })

  it('toggles between active and archived conversation lists from the Messages header', () => {
    render(
      <MemoryRouter initialEntries={['/messages']}>
        <Sidebar onViewChange={vi.fn()} />
      </MemoryRouter>
    )

    // Initially shows the active list
    expect(screen.getByTestId('active-list')).toBeInTheDocument()

    // Click the archive toggle button
    fireEvent.click(screen.getByLabelText('Show archived conversations'))
    expect(screen.getByTestId('archived-list')).toBeInTheDocument()

    // Click again to switch back to active
    fireEvent.click(screen.getByLabelText('Show active conversations'))
    expect(screen.getByTestId('active-list')).toBeInTheDocument()
  })
})
