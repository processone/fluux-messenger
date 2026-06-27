import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConversationItem } from './ConversationList'
import type { Conversation } from '@fluux/sdk'
import type { DensityMode } from '@/stores/settingsStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('./SidebarListMenu', () => ({
  useSidebarListMenu: () => ({
    getItemMenuProps: () => ({}),
    isOpen: false,
    longPressTriggered: { current: false },
  }),
  SidebarListMenuProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarListMenuPortal: () => null,
  MenuButton: () => null,
}))

vi.mock('./types', () => ({
  useSidebarZone: () => ({ current: null }),
  ContactTooltipContent: () => null,
}))

// Avatar mock that exposes the size prop via data-size for assertions
vi.mock('../Avatar', () => ({
  Avatar: ({ name, size }: { name: string; size?: string }) => (
    <div data-testid="avatar" data-size={size ?? 'sm'}>{name}</div>
  ),
  TypingIndicator: () => null,
}))

vi.mock('../Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mutable density so tests can override it
const settings = { timeFormat: '24h', densityMode: 'comfortable' as DensityMode }

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: typeof settings) => unknown) => selector(settings),
}))

const h = vi.hoisted(() => ({ conversation: null as Conversation | null }))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (s: { status: string }) => unknown) =>
    selector({ status: 'online' }),
  useChatStore: (selector: (s: {
    conversations: Map<string, Conversation>
    typingStates: Map<string, Set<string>>
    drafts: Map<string, string>
  }) => unknown) =>
    selector({
      conversations: new Map(h.conversation ? [[h.conversation.id, h.conversation]] : []),
      typingStates: new Map(),
      drafts: new Map(),
    }),
  useRosterStore: (selector: (s: { contacts: Map<string, unknown> }) => unknown) =>
    selector({ contacts: new Map() }),
  useRoomStore: (selector: (s: { getRoom: (jid: string) => undefined }) => unknown) =>
    selector({ getRoom: () => undefined }),
}))

const makeConversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'emma@fluux.chat',
  name: 'Emma Wilson',
  type: 'chat',
  unreadCount: 0,
  lastMessage: {
    id: 'm1',
    body: 'See you at 4pm',
    timestamp: new Date(),
    isOutgoing: false,
  },
  ...over,
}) as Conversation

const renderItem = (conversation: Conversation) => {
  h.conversation = conversation
  return render(
    <ConversationItem
      conversationId={conversation.id}
      isActive={false}
      onClick={() => {}}
    />
  )
}

beforeEach(() => {
  settings.densityMode = 'comfortable'
})

describe('ConversationItem density and unread emphasis', () => {
  it('emphasizes the name font-semibold when the conversation is unread', () => {
    const { container } = renderItem(makeConversation({ unreadCount: 5 }))
    const nameEl = container.querySelector('p[dir="auto"]') as HTMLElement
    expect(nameEl.className).toContain('font-semibold')
    expect(nameEl.className).toContain('text-fluux-text')
  })

  it('uses font-medium for a read conversation name', () => {
    const { container } = renderItem(makeConversation({ unreadCount: 0 }))
    const nameEl = container.querySelector('p[dir="auto"]') as HTMLElement
    expect(nameEl.className).toContain('font-medium')
    expect(nameEl.className).not.toContain('font-semibold')
  })

  it('uses avatar size md in comfortable density', () => {
    settings.densityMode = 'comfortable'
    renderItem(makeConversation())
    const avatar = screen.getByTestId('avatar')
    expect(avatar.getAttribute('data-size')).toBe('md')
  })

  it('uses avatar size sm in compact density', () => {
    settings.densityMode = 'compact'
    renderItem(makeConversation())
    const avatar = screen.getByTestId('avatar')
    expect(avatar.getAttribute('data-size')).toBe('sm')
  })

  it('adds sidebar-row class to the row container', () => {
    const { container } = renderItem(makeConversation())
    const row = container.querySelector('.sidebar-row') as HTMLElement
    expect(row).not.toBeNull()
  })
})
