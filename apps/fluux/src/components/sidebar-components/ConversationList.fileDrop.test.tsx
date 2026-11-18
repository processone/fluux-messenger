import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
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

const renderItem = (onFileDrop?: (id: string, file: File) => void) => {
  const conversation = makeConversation()
  h.conversation = conversation
  const view = render(
    <ConversationItem
      conversationId={conversation.id}
      isActive={false}
      onClick={() => {}}
      onFileDrop={onFileDrop}
    />
  )
  return { ...view, row: view.container.querySelector('.sidebar-row') as HTMLElement, conversation }
}

const dataTransfer = (types: string[], files: File[] = []) => ({ types, files, dropEffect: 'none' })

// Intent: a file dropped on a sidebar conversation is offered to that conversation (FLM-196 option A).
describe('ConversationItem file drop', () => {
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })

  it('offers a file dragged in from outside the app to its conversation', () => {
    const onFileDrop = vi.fn()
    const { row, conversation } = renderItem(onFileDrop)

    fireEvent.dragEnter(row, { dataTransfer: dataTransfer(['Files']) })
    expect(row.className).toContain('ring-fluux-brand')
    fireEvent.drop(row, { dataTransfer: dataTransfer(['Files'], [file]) })

    expect(onFileDrop).toHaveBeenCalledExactlyOnceWith(conversation.id, file)
    expect(row.className).not.toContain('ring-fluux-brand')
  })

  it('ignores an image dragged out of a message', () => {
    const onFileDrop = vi.fn()
    const { row } = renderItem(onFileDrop)

    fireEvent.drop(row, { dataTransfer: dataTransfer(['Files', 'text/html'], [file]) })

    expect(onFileDrop).not.toHaveBeenCalled()
  })

  it('does not take a drop when the list gives it no handler', () => {
    const { row } = renderItem()
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.assign(event, { dataTransfer: dataTransfer(['Files'], [file]) })

    row.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })
})
