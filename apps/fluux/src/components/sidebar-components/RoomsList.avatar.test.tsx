import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
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

// FLM-195: a room picture whose address no longer loads must show the shared # tile
describe('RoomItem dead room picture', () => {
  it('draws the # tile, not a broken image, when the picture address fails to load', () => {
    const { container } = renderRoom(makeRoom({ name: 'XSF', avatar: 'blob:tauri://localhost/00070c26-dead' }))
    const img = container.querySelector('img')!
    expect(img).toHaveAttribute('src', 'blob:tauri://localhost/00070c26-dead')
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg.lucide-hash')).toBeTruthy()
  })
})
