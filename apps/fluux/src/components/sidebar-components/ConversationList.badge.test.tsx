import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ConversationItem } from './ConversationList'
import type { Conversation } from '@fluux/sdk'

// UX_REVIEW §3.1 — the unread badge must overlay the avatar instead of
// occupying its own flex column, so it no longer steals width from the
// name/preview column (root cause of "Emma Wi…" truncation).

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

vi.mock('../Avatar', () => ({
  Avatar: ({ name }: { name: string }) => <div data-testid="avatar">{name}</div>,
  TypingIndicator: () => null,
}))

vi.mock('../Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string }) => unknown) =>
    selector({ timeFormat: '24h' }),
}))

// ConversationItem self-subscribes to its conversation / contact / room by id, so
// the mock returns the conversation under test via conversations.get(id).
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
  unreadCount: 3,
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

describe('ConversationItem unread badge placement', () => {
  it('anchors the unread badge to the avatar as an absolute overlay', () => {
    renderItem(makeConversation())

    const badge = screen.getByText('3')
    // Overlay, not a flex sibling competing with the name column
    expect(badge.className).toContain('absolute')
    // Anchored inside the same wrapper as the avatar
    const wrapper = badge.parentElement as HTMLElement
    expect(within(wrapper).getByTestId('avatar')).toBeTruthy()
  })

  it('anchors the badge to the room icon for group chats too', () => {
    renderItem(makeConversation({ id: 'team@conference.fluux.chat', name: 'Team Chat', type: 'groupchat', unreadCount: 7 }))

    const badge = screen.getByText('7')
    expect(badge.className).toContain('absolute')
    // Anchored inside the same wrapper as the avatar
    const wrapper = badge.parentElement as HTMLElement
    expect(within(wrapper).getByTestId('avatar')).toBeTruthy()
  })

  it('renders no badge when there are no unread messages', () => {
    renderItem(makeConversation({ unreadCount: 0 }))
    expect(screen.queryByText('0')).toBeNull()
  })
})
