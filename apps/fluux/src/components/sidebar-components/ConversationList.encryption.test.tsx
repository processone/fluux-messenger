import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
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

vi.mock('../RoomAvatar', () => ({ RoomAvatar: () => <div data-testid="room-avatar" /> }))

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

import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { beginDecryptionActivity } from '../../../../../packages/fluux-sdk/src/core/e2ee/decryptionActivity'

vi.mock('@/hooks/useWebKeyLocked', () => ({ useWebKeyLocked: () => false }))

import { ConversationItem } from './ConversationList'

describe('ConversationItem encrypted preview recovery', () => {
  beforeEach(() => { useEncryptionSettingsStore.setState({ openpgpEnabled: true, pluginRegisteredAt: 0 }) })
  afterEach(() => { act(() => chatStore.getState().reset()) })

  it.each(['chat', 'groupchat'] as const)('updates the shared archived %s row when a MAM preview resolves at the same timestamp', (type) => {
    const id = 'preview@example.test'
    const encrypted: Message = {
      type: 'chat', id: 'm1', stanzaId: undefined, originId: undefined,
      conversationId: id, from: id, body: '[Encrypted message: could not decrypt]',
      timestamp: new Date(), isOutgoing: false, encryptedPayload: '<openpgp/>',
    }
    chatStore.getState().addConversation({ id, name: 'Preview fixture', type, unreadCount: 0, lastMessage: encrypted })
    chatStore.getState().archiveConversation(id)
    render(<ConversationItem conversationId={id} isActive={false} onClick={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent('chat.encryption.previewWaiting')
    act(() => useEncryptionSettingsStore.setState({ pluginRegisteredAt: 1 }))
    expect(screen.getByRole('status')).toHaveTextContent('chat.encryption.previewWaiting')
    let finish!: () => void
    act(() => { finish = beginDecryptionActivity(id, encrypted) })
    expect(screen.getByRole('status')).toHaveTextContent('chat.encryption.previewDecrypting')
    act(() => finish())
    expect(screen.getByRole('status')).toHaveTextContent('chat.encryption.previewWaiting')
    expect(screen.queryByText(encrypted.body)).not.toBeInTheDocument()

    act(() => chatStore.getState().updateLastMessagePreview(id, { ...encrypted, body: 'Recovered content', encryptedPayload: undefined }))
    expect(screen.getByText('Recovered content')).toBeInTheDocument()
    expect(screen.queryByText('chat.encryption.couldNotDecryptUnreadable')).not.toBeInTheDocument()
  })

  it('keeps the draft ahead of an active encrypted preview', () => {
    const id = 'draft@example.test'
    const message: Message = { type: 'chat', id: 'draft-preview', stanzaId: undefined, originId: undefined,
      conversationId: id, from: id, body: '[dummy-plaintext payload]', timestamp: new Date(),
      isOutgoing: false, encryptedPayload: '<plain xmlns="urn:fluux:e2ee-dummy:0">aGVsbG8=</plain>' }
    chatStore.getState().addConversation({ id, name: 'Draft fixture', type: 'chat', unreadCount: 2, lastMessage: message })
    chatStore.getState().setDraft(id, 'Message draft')
    const finish = beginDecryptionActivity(id, message)
    render(<ConversationItem conversationId={id} isActive={false} onClick={() => {}} />)
    expect(screen.getByText('conversations.draft: Message draft')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    act(() => finish())
    expect(chatStore.getState().conversations.get(id)?.unreadCount).toBe(2)
  })
})
