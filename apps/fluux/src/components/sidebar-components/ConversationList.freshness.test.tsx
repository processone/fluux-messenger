import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ConversationItem } from './ConversationList'
import { refreshCurrentDay } from '@/stores/currentDayStore'

const h = vi.hoisted(() => ({ conversation: null as Record<string, unknown> | null }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({ 'dates.yesterday': 'Yesterday' })[key] ?? key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@fluux/sdk', () => ({
  chatStore: { getState: () => ({ activeConversationId: null }) },
  roomStore: { getState: () => ({ activateRoom: vi.fn() }) },
  isPreviewableMessage: () => true,
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: 'online' }),
  useChatStore: (selector: (state: {
    conversations: Map<string, Record<string, unknown>>
    typingStates: Map<string, Set<string>>
    drafts: Map<string, string>
  }) => unknown) =>
    selector({
      conversations: new Map(h.conversation ? [[h.conversation.id as string, h.conversation]] : []),
      typingStates: new Map(),
      drafts: new Map(),
    }),
  useRosterStore: (selector: (state: { contacts: Map<string, unknown> }) => unknown) =>
    selector({ contacts: new Map() }),
  useRoomStore: (selector: (state: { getRoom: () => undefined }) => unknown) =>
    selector({ getRoom: () => undefined }),
}))

vi.mock('./SidebarListMenu', () => ({
  useSidebarListMenu: () => ({
    getItemMenuProps: () => ({}),
    isOpen: false,
    longPressTriggered: { current: false },
    targetItem: null,
  }),
  SidebarListMenuProvider: ({ children }: { children: React.ReactNode }) => children,
  SidebarListMenuPortal: () => null,
  MenuButton: () => null,
}))

vi.mock('./types', () => ({
  useSidebarZone: () => ({ current: null }),
  ContactTooltipContent: () => null,
}))

vi.mock('../Avatar', () => ({
  Avatar: ({ name }: { name: string }) => <div>{name}</div>,
  TypingIndicator: () => null,
}))

vi.mock('../RoomAvatar', () => ({ RoomAvatar: () => null }))
vi.mock('../Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('@/utils/messagePreviewText', () => ({ formatLocalizedPreview: () => 'Hello' }))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { timeFormat: string; densityMode: string }) => unknown) =>
    selector({ timeFormat: '24h', densityMode: 'comfortable' }),
}))

describe('ConversationItem relative date freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    refreshCurrentDay()
    h.conversation = null
  })

  it('updates its memoized timestamp after the local day changes', () => {
    vi.setSystemTime(new Date(2026, 1, 10, 23, 30))
    refreshCurrentDay()
    h.conversation = {
      id: 'emma@example.com',
      name: 'Emma',
      type: 'chat',
      unreadCount: 0,
      lastMessage: {
        id: 'message-1',
        body: 'Hello',
        timestamp: new Date(2026, 1, 10, 20, 0),
        isOutgoing: false,
      },
    }

    render(
      <ConversationItem
        conversationId="emma@example.com"
        isActive={false}
        onClick={() => {}}
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
