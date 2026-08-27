import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { RoomItem } from './RoomsList'
import { refreshCurrentDay } from '@/stores/currentDayStore'

const h = vi.hoisted(() => ({ room: null as Record<string, unknown> | null }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({ 'dates.yesterday': 'Yesterday' })[key] ?? key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@fluux/sdk', () => ({
  useRoomActions: () => ({}),
  roomStore: { getState: () => ({ activeRoomJid: null }) },
  roomActivityTone: () => 'neutral',
  generateConsistentColorHexSync: () => '#123456',
}))

vi.mock('@fluux/sdk/react', () => ({
  useRoomStore: (selector: (state: {
    getRoom: () => Record<string, unknown> | null
    drafts: Map<string, string>
  }) => unknown) => selector({ getRoom: () => h.room, drafts: new Map() }),
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) => selector({}),
  useIgnoreStore: (selector: (state: { ignoredUsers: Record<string, unknown[]> }) => unknown) =>
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

vi.mock('../Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('../conversation/TypingIndicator', () => ({ TypingIndicator: () => null }))
vi.mock('@/utils/roomTyping', () => ({ visibleRoomTypingNicks: () => [] }))
vi.mock('@/utils/roomTooltip', () => ({ roomTooltipParts: () => ({ headline: null, detail: '' }) }))
vi.mock('@/utils/messagePreviewText', () => ({ formatLocalizedPreview: () => 'Hello' }))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { timeFormat: string; densityMode: string }) => unknown) =>
    selector({ timeFormat: '24h', densityMode: 'comfortable' }),
}))

const noop = () => {}

describe('RoomItem relative date freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    refreshCurrentDay()
    h.room = null
  })

  it('updates its memoized timestamp after the local day changes', () => {
    vi.setSystemTime(new Date(2026, 1, 10, 23, 30))
    refreshCurrentDay()
    h.room = {
      jid: 'team@conference.example.com',
      name: 'Team',
      joined: true,
      isJoining: false,
      nickname: 'me',
      occupants: new Map(),
      unreadCount: 0,
      mentionsCount: 0,
      typingUsers: new Set(),
      lastMessage: {
        type: 'groupchat',
        id: 'message-1',
        roomJid: 'team@conference.example.com',
        from: 'team@conference.example.com/alice',
        body: 'Hello',
        timestamp: new Date(2026, 1, 10, 20, 0),
        isOutgoing: false,
        nick: 'alice',
      },
    }

    render(
      <RoomItem
        roomJid="team@conference.example.com"
        isActive={false}
        onSelect={noop}
        onActivate={noop}
        onJoin={noop}
        onLeave={noop}
        onEditBookmark={noop}
        onRemoveBookmark={noop}
        onToggleAutojoin={noop}
      />
    )
    expect(screen.getByText('20:00')).toBeInTheDocument()

    vi.setSystemTime(new Date(2026, 1, 11, 9, 0))
    act(() => {
      refreshCurrentDay()
    })

    expect(screen.getByText('Yesterday')).toBeInTheDocument()
  })
})
