import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { Room } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { displayCount?: string; count?: number }) => key === 'rooms.unreadMessages' ? `${options?.displayCount} unread messages` : key === 'rooms.mentionsCount' ? `Mentions: ${options?.count}` : key, i18n: { language: 'en' } }),
}))

// Real helper is fine (pure); stub the ignore predicate it calls.
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    isMessageFromIgnoredUser: (ignored: { nick?: string }[], msg: { nick?: string }) =>
      ignored.some((i) => i.nick === msg.nick),
    generateConsistentColorHexSync: () => '#123456',
  }
})

const h = vi.hoisted(() => ({
  room: null as Room | null,
  ignored: [] as unknown[],
  draft: undefined as string | undefined,
}))

vi.mock('@fluux/sdk/react', () => ({
  useRoomStore: (selector: (s: {
    getRoom: (jid: string) => Room | null
    drafts: Map<string, string>
  }) => unknown) =>
    selector({
      getRoom: () => h.room,
      drafts: h.draft === undefined ? new Map() : new Map([[h.room?.jid ?? '', h.draft]]),
    }),
  useChatStore: (selector: (s: unknown) => unknown) => selector({}),
  useIgnoreStore: (selector: (s: { ignoredUsers: Record<string, unknown[]> }) => unknown) =>
    selector({ ignoredUsers: { 'team@conference.fluux.chat': h.ignored } }),
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
  // Imported at module scope by RoomsList() (the parent list), never called in
  // this test since only RoomItem is rendered — stubbed so the import resolves.
  useListKeyboardNav: () => ({}),
  useRouteSync: () => ({}),
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string; densityMode: string }) => unknown) =>
    selector({ timeFormat: '24h', densityMode: 'comfortable' }),
}))

vi.mock('../Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
    occupants: new Map(),
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
const renderRoom = (
  room: Room,
  isActive = false,
  { ignored = [], draft }: { ignored?: unknown[]; draft?: string } = {},
) => {
  h.room = room
  h.ignored = ignored
  h.draft = draft
  return render(
    <RoomItem
      roomJid={room.jid}
      isActive={isActive}
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

describe('RoomItem unread avatar badge', () => {
  it('shows no numeric badge when caught up', () => {
    renderRoom(makeRoom())
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.queryByLabelText(/unread messages/)).toBeNull()
  })

  it.each([[7, '7'], [100, '100'], [998, '998'], [999, '999+'], [1000, '999+']])(
    'renders %i unread as %s over the room avatar', (count, display) => {
      renderRoom(makeRoom({ unreadCount: count }))
      const badge = screen.getByText(display)
      expect(badge).toHaveClass('absolute', '-top-1', '-end-1')
      expect(badge).toHaveAccessibleName(`${display} unread messages`)
      expect(badge.parentElement).toHaveClass('relative')
      expect(badge.parentElement?.querySelector('svg')).toBeTruthy()
    },
  )

  it('keeps plain unread muted for mentions-only rooms', () => {
    renderRoom(makeRoom({ unreadCount: 7, notifyAll: false }))
    expect(screen.getByText('7')).toHaveClass('bg-fluux-gray')
  })

  it.each([{ notifyAll: true }, { notifyAllPersistent: true }])(
    'uses the attention colour for notify-all rooms: %s', (settings) => {
      renderRoom(makeRoom({ unreadCount: 7, ...settings }))
      expect(screen.getByText('7')).toHaveClass('bg-fluux-badge-strong')
    },
  )

  it('shows total unread alongside a distinct accessible mention marker', () => {
    renderRoom(makeRoom({ unreadCount: 37, mentionsCount: 3 }))
    expect(screen.getByText('37')).toHaveClass('bg-fluux-badge-strong')
    const mentions = screen.getByText('@3')
    expect(mentions).toHaveAccessibleName('Mentions: 3')
    expect(within(screen.getByText('37').parentElement!).queryByText('@3')).toBeNull()
  })

  it('keeps a muted room quiet while displaying its unread count', () => {
    renderRoom(makeRoom({ unreadCount: 7, notifyAll: true, muted: true }))
    expect(screen.getByText('7')).toHaveClass('bg-fluux-gray')
  })

  it('preserves unread display on an active room and suppresses typing', () => {
    renderRoom(makeRoom({ unreadCount: 7, typingUsers: new Set(['Alice']) }), true)
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.queryByText('chat.typing.one')).toBeNull()
  })

  it.each([{ joined: false }, { isJoining: true }])(
    'does not overlay unread while the room is unavailable: %s', (state) => {
      renderRoom(makeRoom({ unreadCount: 7, ...state }))
      expect(screen.queryByText('7')).toBeNull()
    },
  )
})
