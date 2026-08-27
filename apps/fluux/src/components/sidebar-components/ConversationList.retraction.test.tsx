/**
 * The sidebar's retracted-message preview.
 *
 * The notice text comes from the shared `formatLocalizedPreview`, but the
 * ITALIC styling is chosen here, from `lastMessage.isRetracted`. Both halves
 * need guarding: the notice must appear exactly once — a caller that also
 * substitutes it would double it — and it must stay italic.
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
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

vi.mock('../Avatar', () => ({
  Avatar: () => <div data-testid="avatar" />,
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
  useConnectionStore: (selector: (s: { status: string }) => unknown) => selector({ status: 'online' }),
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
    selector({ contacts: new Map([['emma@fluux.chat', { presence: 'online' }]]) }),
  useRoomStore: (selector: (s: { getRoom: (jid: string) => undefined }) => unknown) =>
    selector({ getRoom: () => undefined }),
}))

import { ConversationItem } from './ConversationList'

const renderWithLastMessage = (lastMessage: Record<string, unknown>) => {
  h.conversation = {
    id: 'emma@fluux.chat',
    name: 'Emma',
    type: 'chat',
    unreadCount: 0,
    lastMessage: { id: 'm1', timestamp: new Date(), isOutgoing: false, ...lastMessage },
  } as unknown as Conversation
  return render(
    <ConversationItem conversationId="emma@fluux.chat" isActive={false} onClick={() => {}} />,
  )
}

const previewLine = () =>
  [...document.querySelectorAll('p')].find((p) => p.textContent?.includes('chat.messageDeleted')) ?? null

describe('ConversationItem retracted preview', () => {
  it('shows the deleted notice once, never the preserved body', () => {
    const { container } = renderWithLastMessage({ body: 'the secret', isRetracted: true })
    expect(container.textContent).not.toContain('the secret')
    expect(container.textContent?.match(/chat\.messageDeleted/g)).toHaveLength(1)
  })

  it('keeps the notice italic', () => {
    renderWithLastMessage({ body: 'the secret', isRetracted: true })
    expect(previewLine()?.className).toContain('italic')
  })

  it('shows the notice for a bodiless retraction rather than a blank line', () => {
    const { container } = renderWithLastMessage({ body: '', isRetracted: true })
    expect(container.textContent).toContain('chat.messageDeleted')
  })

  it('prefixes an outgoing retraction with the "me" label, as for any message', () => {
    const { container } = renderWithLastMessage({ body: 'the secret', isRetracted: true, isOutgoing: true })
    expect(container.textContent).toContain('chat.me')
    expect(container.textContent).toContain('chat.messageDeleted')
  })

  it('leaves an ordinary message preview unchanged and not italic', () => {
    const { container } = renderWithLastMessage({ body: 'hi there' })
    expect(container.textContent).toContain('hi there')
    expect(container.textContent).not.toContain('chat.messageDeleted')
    const line = [...container.querySelectorAll('p')].find((p) => p.textContent?.includes('hi there'))
    expect(line?.className).not.toContain('italic')
  })

  it('leaves a poll preview unchanged', () => {
    const { container } = renderWithLastMessage({ body: '', poll: { title: 'Lunch?', options: [], settings: { allowMultiple: false, hideResultsBeforeVote: false } } })
    expect(container.textContent).toContain('📊 Lunch?')
    expect(container.textContent).not.toContain('chat.messageDeleted')
  })
})
