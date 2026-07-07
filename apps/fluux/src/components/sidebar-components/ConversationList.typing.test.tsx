import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Conversation } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('./SidebarListMenu', () => ({
  useSidebarListMenu: () => ({
    getItemMenuProps: () => ({}),
    isOpen: false,
    longPressTriggered: { current: false },
  }),
}))

vi.mock('./types', () => ({
  useSidebarZone: () => ({ current: null }),
  ContactTooltipContent: () => null,
}))

// Expose whether the avatar received a truthy typing overlay.
vi.mock('../Avatar', () => ({
  Avatar: ({ overlay }: { overlay?: unknown }) => (
    <div data-testid="avatar" data-has-overlay={overlay ? 'true' : 'false'} />
  ),
  TypingIndicator: () => <span data-testid="typing-dot" />,
}))

vi.mock('../Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string; densityMode: string }) => unknown) =>
    selector({ timeFormat: '24h', densityMode: 'comfortable' }),
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
      // The contact is composing to us.
      typingStates: new Map([['emma@fluux.chat', new Set(['emma@fluux.chat'])]]),
      drafts: new Map(),
    }),
  useRosterStore: (selector: (s: { contacts: Map<string, unknown> }) => unknown) =>
    selector({ contacts: new Map([['emma@fluux.chat', { presence: 'online' }]]) }),
  useRoomStore: (selector: (s: { getRoom: (jid: string) => undefined }) => unknown) =>
    selector({ getRoom: () => undefined }),
}))

import { ConversationItem } from './ConversationList'

const makeConversation = (over: Partial<Conversation> = {}): Conversation =>
  ({
    id: 'emma@fluux.chat',
    name: 'Emma',
    type: 'chat',
    unreadCount: 0,
    lastMessage: { id: 'm1', body: 'hi', timestamp: new Date(), isOutgoing: false },
    ...over,
  }) as Conversation

const renderItem = (isActive: boolean) => {
  h.conversation = makeConversation()
  return render(
    <ConversationItem conversationId="emma@fluux.chat" isActive={isActive} onClick={() => {}} />,
  )
}

describe('ConversationItem typing overlay suppression', () => {
  it('shows the typing overlay when the chat is not active', () => {
    renderItem(false)
    expect(screen.getByTestId('avatar').getAttribute('data-has-overlay')).toBe('true')
  })

  it('suppresses the typing overlay when the chat is active', () => {
    renderItem(true)
    expect(screen.getByTestId('avatar').getAttribute('data-has-overlay')).toBe('false')
  })
})
