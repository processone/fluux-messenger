/**
 * The rooms list's retracted-message preview.
 *
 * The notice text comes from the shared `formatLocalizedPreview`, but the
 * ITALIC styling is chosen here, from `lastMessage.isRetracted`. Both halves
 * need guarding: the notice must appear exactly once — a caller that also
 * substitutes it would double it — and it must stay italic.
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
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

const lastMessage = (over: Record<string, unknown>) =>
  ({ id: 'm1', nick: 'Alice', timestamp: new Date(), isOutgoing: false, body: '', ...over }) as never

/** The row wraps sender + preview in one span, so match on containment. */
const previewLine = (container: HTMLElement) =>
  [...container.querySelectorAll('span')].find((el) =>
    el.textContent?.includes('chat.messageDeleted'),
  ) ?? null

describe('RoomItem retracted preview', () => {
  it('shows the deleted notice once, never the preserved body', () => {
    const { container } = renderRoom(
      makeRoom({ lastMessage: lastMessage({ body: 'the secret', isRetracted: true }) }),
    )
    expect(container.textContent).not.toContain('the secret')
    expect(container.textContent?.match(/chat\.messageDeleted/g)).toHaveLength(1)
  })

  it('keeps the notice italic', () => {
    const { container } = renderRoom(
      makeRoom({ lastMessage: lastMessage({ body: 'the secret', isRetracted: true }) }),
    )
    expect(previewLine(container)?.className).toContain('italic')
  })

  it('shows the notice for a bodiless retraction rather than a blank line', () => {
    const { container } = renderRoom(makeRoom({ lastMessage: lastMessage({ isRetracted: true }) }))
    expect(container.textContent).toContain('chat.messageDeleted')
  })

  it('keeps the sender prefix on a retraction, as for any message', () => {
    const { container } = renderRoom(
      makeRoom({ lastMessage: lastMessage({ body: 'the secret', isRetracted: true }) }),
    )
    expect(container.textContent).toContain('Alice: ')
  })

  it('leaves an ordinary message preview unchanged and not italic', () => {
    const { container } = renderRoom(makeRoom({ lastMessage: lastMessage({ body: 'hi there' }) }))
    expect(container.textContent).toContain('hi there')
    expect(container.textContent).not.toContain('chat.messageDeleted')
    expect(container.querySelector('span.italic')).toBeNull()
  })

  it('leaves a poll preview unchanged', () => {
    const { container } = renderRoom(
      makeRoom({ lastMessage: lastMessage({ poll: { title: 'Lunch?', options: [], settings: { allowMultiple: false, hideResultsBeforeVote: false } } }) }),
    )
    expect(container.textContent).toContain('\u{1F4CA} Lunch?')
    expect(container.textContent).not.toContain('chat.messageDeleted')
  })
})
