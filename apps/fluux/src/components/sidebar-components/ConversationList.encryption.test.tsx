import { afterEach, describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { chatStore, type Message } from '@fluux/sdk'
import { useStore } from 'zustand'

vi.unmock('@fluux/sdk')

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

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (s: { status: string }) => unknown) => selector({ status: 'online' }),
  useChatStore: (selector: (state: ReturnType<typeof chatStore.getState>) => unknown) => useStore(chatStore, selector),
  useRosterStore: (selector: (s: { contacts: Map<string, unknown> }) => unknown) =>
    selector({ contacts: new Map([['emma@fluux.chat', { presence: 'online' }]]) }),
  useRoomStore: (selector: (s: { getRoom: (jid: string) => undefined }) => unknown) =>
    selector({ getRoom: () => undefined }),
}))

import { ConversationItem } from './ConversationList'

describe('ConversationItem encrypted preview recovery', () => {
  afterEach(() => { act(() => chatStore.getState().reset()) })

  it('updates the mounted row when a MAM preview resolves at the same timestamp', () => {
    const id = 'preview@example.test'
    const encrypted: Message = {
      type: 'chat', id: 'm1', stanzaId: undefined, originId: undefined,
      conversationId: id, from: id, body: '[Encrypted message: could not decrypt]',
      timestamp: new Date(), isOutgoing: false, encryptedPayload: '<openpgp/>',
    }
    chatStore.getState().addConversation({ id, name: 'Preview fixture', type: 'chat', unreadCount: 0, lastMessage: encrypted })
    render(<ConversationItem conversationId={id} isActive={false} onClick={() => {}} />)
    expect(screen.getByText('chat.encryption.couldNotDecryptUnreadable')).toBeInTheDocument()
    expect(screen.queryByText(encrypted.body)).not.toBeInTheDocument()

    act(() => chatStore.getState().updateLastMessagePreview(id, { ...encrypted, body: 'Recovered content', encryptedPayload: undefined }))
    expect(screen.getByText('Recovered content')).toBeInTheDocument()
    expect(screen.queryByText('chat.encryption.couldNotDecryptUnreadable')).not.toBeInTheDocument()
  })
})
