import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConversationList } from './ConversationList'

// TDD Step 1: rendering ConversationList with zero conversations still shows the empty copy key.
// After migration, the key is rendered via ListEmpty, not raw inline markup — but the text is unchanged.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('./SidebarListMenu', () => ({
  useSidebarListMenu: () => ({
    getItemMenuProps: () => ({}),
    isOpen: false,
    longPressTriggered: { current: false },
    targetItem: null,
    close: vi.fn(),
  }),
  SidebarListMenuProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarListMenuPortal: () => null,
  MenuButton: () => null,
}))

vi.mock('./types', () => ({
  useSidebarZone: () => ({ current: null }),
  ContactTooltipContent: () => null,
}))

vi.mock('../Avatar', () => ({
  Avatar: ({ name }: { name: string }) => <div data-testid="avatar">{name}</div>,
  TypingIndicator: () => null,
}))

vi.mock('../Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string; densityMode: string }) => unknown) =>
    selector({ timeFormat: '24h', densityMode: 'normal' }),
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (s: { status: string }) => unknown) =>
    selector({ status: 'online' }),
  useChatStore: (selector: (s: {
    conversationSidebarIds: () => string[]
    activeConversationId: null
    deleteConversation: () => void
    archiveConversation: () => void
    conversations: Map<string, unknown>
    typingStates: Map<string, Set<string>>
    drafts: Map<string, string>
  }) => unknown) =>
    selector({
      conversationSidebarIds: () => [],
      activeConversationId: null,
      deleteConversation: vi.fn(),
      archiveConversation: vi.fn(),
      conversations: new Map(),
      typingStates: new Map(),
      drafts: new Map(),
    }),
  useRosterStore: (selector: (s: { contacts: Map<string, unknown> }) => unknown) =>
    selector({ contacts: new Map() }),
  useRoomStore: (selector: (s: { getRoom: (jid: string) => undefined }) => unknown) =>
    selector({ getRoom: () => undefined }),
}))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    chatStore: { getState: () => ({ activeConversationId: null }) },
    roomStore: { getState: () => ({ activateRoom: vi.fn() }) },
    generateConsistentColorHexSync: () => '#888',
    isPreviewableMessage: () => true,
  }
})

vi.mock('@/utils/renderLoopDetector', () => ({
  detectRenderLoop: vi.fn(),
  trackSelectorChange: vi.fn(),
}))

vi.mock('@/hooks', () => ({
  useListKeyboardNav: () => ({
    selectedIndex: -1,
    isKeyboardNav: false,
    getItemProps: () => ({}),
    getItemAttribute: () => ({}),
    getContainerProps: () => ({}),
  }),
  useRouteSync: () => ({
    navigateToMessages: vi.fn(),
    navigateToArchive: vi.fn(),
  }),
}))

describe('ConversationList empty state', () => {
  it('shows the noConversations key when list is empty', () => {
    render(<ConversationList />)
    expect(screen.getByText('conversations.noConversations')).toBeInTheDocument()
  })
})
