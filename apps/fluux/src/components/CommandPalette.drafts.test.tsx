import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import { XMPPProvider } from '@fluux/sdk'
import { XMPPClient } from '@fluux/sdk/core'
import { chatStore, roomStore, rosterStore } from '@fluux/sdk/stores'
import en from '@/i18n/locales/en.json'
import { CommandPalette } from './CommandPalette'

vi.unmock('@fluux/sdk')
vi.unmock('@fluux/sdk/stores')
vi.unmock('@fluux/sdk/react')

const client = new XMPPClient()

function openPalette() {
  return render(<XMPPProvider client={client}>
    <CommandPalette isOpen onClose={vi.fn()} onSidebarViewChange={vi.fn()}
      onOpenSettings={vi.fn()} onToggleConsole={vi.fn()} onToggleShortcutHelp={vi.fn()}
      onCreateQuickChat={vi.fn()} onAddContact={vi.fn()} onStartConversation={vi.fn()} />
  </XMPPProvider>)
}

beforeEach(() => {
  i18n.addResourceBundle('en', 'translation', en, true, true)
  chatStore.getState().reset()
  roomStore.getState().reset()
  rosterStore.getState().reset()
  Element.prototype.scrollIntoView = vi.fn()
  chatStore.getState().addConversation({ id: 'emma@example.test', name: 'Emma', type: 'chat', unreadCount: 0 })
  chatStore.getState().addConversation({ id: 'oliver@example.test', name: 'Oliver', type: 'chat', unreadCount: 0 })
  roomStore.getState().addRoom({ jid: 'design@conference.example.test', name: 'Design', joined: true, nickname: 'You', isBookmarked: true, unreadCount: 0, mentionsCount: 0, typingUsers: new Set(), occupants: new Map() })
})

describe('accepted local draft finder scope', () => {
  it('owns eligibility and names-only matching, including the open chat and room', () => {
    chatStore.getState().setDraft('emma@example.test', 'Bring the revised drawings')
    chatStore.getState().setDraft('oliver@example.test', ' \n ')
    chatStore.getState().setDraft('missing@example.test', 'No conversation')
    chatStore.getState().setActiveConversation('emma@example.test')
    roomStore.getState().setDraft('design@conference.example.test', 'Review on Thursday')
    roomStore.getState().setActiveRoom('design@conference.example.test')
    roomStore.getState().addRoom({ jid: 'left@conference.example.test', name: 'Left room', joined: false, nickname: 'You', isBookmarked: true, unreadCount: 0, mentionsCount: 0, typingUsers: new Set(), occupants: new Map() })
    roomStore.getState().setDraft('left@conference.example.test', 'Do not list')
    chatStore.getState().addConversation({ id: 'archived@example.test', name: 'Archived', type: 'chat', unreadCount: 0 })
    chatStore.getState().setDraft('archived@example.test', 'Do not list')
    chatStore.getState().archiveConversation('archived@example.test')
    chatStore.getState().addConversation({ id: 'private@example.test', name: 'Private room chat', type: 'groupchat', unreadCount: 0 })
    chatStore.getState().setDraft('private@example.test', 'Do not list')
    openPalette()
    fireEvent.click(screen.getByRole('button', { name: /^Drafts/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: /Emma emma/ })).toBeVisible()
    expect(within(dialog).getByRole('button', { name: /Design design/ })).toBeVisible()
    expect(within(dialog).queryByText(/Oliver|Archived|Left room|Private room chat/)).not.toBeInTheDocument()
    expect(dialog).not.toHaveTextContent('Bring the revised drawings')
    expect(dialog).not.toHaveTextContent('Review on Thursday')
    const input = within(dialog).getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Thursday' } })
    expect(within(dialog).getByText('No results found')).toBeVisible()
    expect(within(dialog).queryByText(/Search messages/)).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'DES' } })
    expect(within(dialog).getByRole('button', { name: /Design design/ })).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: /Emma emma/ })).not.toBeInTheDocument()
  })

  it('owns reactive last-draft removal and account-scoped replacement while open', () => {
    chatStore.getState().setDraft('emma@example.test', 'Continue later')
    openPalette()
    fireEvent.click(screen.getByRole('button', { name: /^Drafts/ }))
    act(() => chatStore.getState().clearDraft('emma@example.test'))
    expect(screen.getByText('No results found')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.queryByRole('button', { name: /^Drafts/ })).not.toBeInTheDocument()
    act(() => roomStore.getState().setDraft('design@conference.example.test', 'Next design review'))
    expect(screen.getByRole('button', { name: /^Drafts/ })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /^Drafts/ }))
    localStorage.setItem('xmpp-chat-storage:second@example.test', JSON.stringify({ state: {
      conversations: [['new@example.test', { id: 'new@example.test', name: 'New account colleague', type: 'chat', unreadCount: 0 }]],
      archivedConversations: [],
      drafts: [['new@example.test', 'A different account draft']],
    } }))
    act(() => {
      chatStore.getState().switchAccount('second@example.test')
      roomStore.getState().switchAccount('second@example.test')
    })
    expect(screen.queryByRole('button', { name: /Design design/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Emma emma/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /New account colleague/ })).toBeVisible()
  })
})
