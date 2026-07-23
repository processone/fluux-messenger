import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Room } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    isMessageFromIgnoredUser: () => false,
    roomActivityTone: () => 'neutral',
    generateConsistentColorHexSync: () => '#123456',
  }
})

const h = vi.hoisted(() => ({ room: null as Room | null }))

vi.mock('@fluux/sdk/react', () => ({
  useRoomStore: (selector: (s: {
    getRoom: (jid: string) => Room | null
    drafts: Map<string, string>
  }) => unknown) => selector({ getRoom: () => h.room, drafts: new Map() }),
  useChatStore: (selector: (s: unknown) => unknown) => selector({}),
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
  useListKeyboardNav: () => ({}),
  useRouteSync: () => ({}),
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string; densityMode: string }) => unknown) =>
    selector({ timeFormat: '24h', densityMode: 'comfortable' }),
}))

// Unlike the typing test's mock, this one RENDERS `content`. The assertions are
// about what RoomsList hands to Tooltip; hover/delay behaviour is Tooltip's own
// test's job. Rendering every instance also lets us count them, which is how we
// prove the activity dot no longer carries a tooltip of its own.
vi.mock('../Tooltip', () => ({
  Tooltip: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => (
    <>
      {children}
      <div data-testid="tooltip-content">{content}</div>
    </>
  ),
}))

// Import AFTER mocks so RoomItem picks them up.
import { RoomItem } from './RoomsList'

const makeRoom = (over: Partial<Room> = {}): Room =>
  ({
    jid: 'team@conference.fluux.chat',
    name: 'Team',
    joined: true,
    isJoining: false,
    nickname: 'me',
    nickToJidCache: new Map(),
    occupants: new Map([['alice', {}], ['bob', {}]]),
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set<string>(),
    lastMessage: null,
    avatar: undefined,
    subject: undefined,
    autojoin: false,
    isBookmarked: false,
    ...over,
  }) as unknown as Room

const noop = () => {}
const renderRoom = (room: Room) => {
  h.room = room
  return render(
    <RoomItem
      roomJid={room.jid}
      isActive={false}
      isSelected={false}
      isKeyboardNav={false}
      onSelect={noop}
      onActivate={noop}
      onJoin={noop}
      onLeave={noop}
      onEditBookmark={noop}
      onRemoveBookmark={noop}
      onToggleAutojoin={noop}
    />,
  )
}

describe('RoomItem tooltip', () => {
  it('puts the unread headline above the occupant detail line', () => {
    renderRoom(makeRoom({ unreadCount: 37 }))
    const tooltip = screen.getByTestId('tooltip-content')
    // t is mocked to echo the key, so the headline renders as the bare key.
    expect(tooltip.textContent).toContain('rooms.unreadMessages')
    expect(tooltip.textContent).toContain('2 rooms.users • me')
  })

  it('still shows the unread headline when the room also has mentions', () => {
    // The regression this feature exists to prevent: the old activity-dot
    // tooltip was gated on mentionsCount === 0, which hid the total unread
    // exactly when the room was busiest. Only a render test can catch a
    // reintroduced gate — roomTooltipParts cannot even see mentionsCount.
    renderRoom(makeRoom({ unreadCount: 37, mentionsCount: 3 }))
    expect(screen.getByTestId('tooltip-content').textContent).toContain('rooms.unreadMessages')
  })

  it('shows only the detail line when the room is fully read', () => {
    renderRoom(makeRoom({ unreadCount: 0 }))
    const tooltip = screen.getByTestId('tooltip-content')
    expect(tooltip.textContent).not.toContain('rooms.unreadMessages')
    expect(tooltip.textContent).toContain('2 rooms.users • me')
  })

  it('gives the activity dot no tooltip of its own', () => {
    // A room with unread and no mentions is precisely the state that used to
    // render a second, nested Tooltip around the dot.
    renderRoom(makeRoom({ unreadCount: 37, mentionsCount: 0 }))
    expect(screen.getAllByTestId('tooltip-content')).toHaveLength(1)
  })
})
