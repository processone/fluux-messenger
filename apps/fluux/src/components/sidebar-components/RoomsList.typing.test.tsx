import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Room } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

// Real helper is fine (pure); stub the ignore predicate it calls.
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    isMessageFromIgnoredUser: (ignored: { nick?: string }[], msg: { nick?: string }) =>
      ignored.some((i) => i.nick === msg.nick),
    roomActivityTone: () => 'neutral',
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

describe('RoomItem sidebar typing', () => {
  it('shows the typing indicator when caught up and someone is typing', () => {
    renderRoom(makeRoom({ typingUsers: new Set(['Alice']) }))
    // chat.typing.one is the i18n key rendered by the compact TypingIndicator
    expect(screen.getByText('chat.typing.one')).toBeTruthy()
  })

  it('hides typing when there is unread activity', () => {
    renderRoom(makeRoom({ unreadCount: 2, typingUsers: new Set(['Alice']) }))
    expect(screen.queryByText('chat.typing.one')).toBeNull()
  })

  it('hides typing on the active room', () => {
    renderRoom(makeRoom({ typingUsers: new Set(['Alice']) }), true)
    expect(screen.queryByText('chat.typing.one')).toBeNull()
  })

  it('hides typing when the only typist is the user themselves', () => {
    renderRoom(makeRoom({ typingUsers: new Set(['me']) }))
    expect(screen.queryByText('chat.typing.one')).toBeNull()
  })

  it('hides typing when the only typist is an ignored user', () => {
    renderRoom(makeRoom({ typingUsers: new Set(['Troll']) }), false, {
      ignored: [{ nick: 'Troll' }],
    })
    expect(screen.queryByText('chat.typing.one')).toBeNull()
  })

  it('shows typing instead of the draft line when someone is typing', () => {
    renderRoom(makeRoom({ typingUsers: new Set(['Alice']) }), false, {
      draft: 'hello there',
    })
    expect(screen.getByText('chat.typing.one')).toBeTruthy()
    expect(screen.queryByText('conversations.draft', { exact: false })).toBeNull()
  })

  it('reverts to the draft line once typing stops', () => {
    renderRoom(makeRoom({ typingUsers: new Set() }), false, {
      draft: 'hello there',
    })
    expect(screen.queryByText('chat.typing.one')).toBeNull()
    expect(screen.getByText('conversations.draft', { exact: false })).toBeTruthy()
  })
})
