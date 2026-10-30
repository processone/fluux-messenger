// Intent: review E1 — the destination draft must survive the parent's delayed
// edit-clear render, in both real input callers, without any failed send.
import 'fake-indexeddb/auto'
import { createRef, type ComponentProps } from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@fluux/sdk'
import { chatStore, roomStore } from '@fluux/sdk/stores'
import { roomMessageFixture } from '@/test-utils/roomMessages'
import { MessageInput } from './ChatView'
import { RoomMessageInput } from './RoomView'
import type { MessageComposerHandle } from './MessageComposer'

vi.mock('@fluux/sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@fluux/sdk')>(),
  useRoomActions: () => ({ joinRoom: vi.fn(), joinResult: vi.fn(), leaveRoom: vi.fn() }),
  useRoomModeration: () => ({ setRole: vi.fn(), setAffiliation: vi.fn() }),
  useRoomManagement: () => ({ setSubject: vi.fn(), inviteToRoom: vi.fn() }),
}))
vi.unmock('@fluux/sdk/react')

const source = 'emma@fluux.chat'
const destination = 'oliver@fluux.chat'
const destinationDraft = 'Another ordinary draft'
const edited: Message = {
  id: 'earlier-message', conversationId: source, from: 'you@fluux.chat',
  body: 'Good catch.', timestamp: new Date('2024-01-15T10:00:00Z'),
  isOutgoing: true, type: 'chat',
}

beforeEach(() => {
  chatStore.setState({ drafts: new Map([[source, 'Source draft'], [destination, destinationDraft]]) })
  roomStore.setState({ drafts: new Map([
    ['team@conference.fluux.chat', 'Source room draft'],
    ['design@conference.fluux.chat', destinationDraft],
  ]) })
})

describe('destination draft while the parent still holds the old edit', () => {
  it('restores the chat draft one render before the old edit clears', () => {
    const props: ComponentProps<typeof MessageInput> = {
      composerRef: createRef<MessageComposerHandle>(), conversationId: source,
      conversationName: 'Emma Wilson', type: 'chat', replyingTo: null,
      onCancelReply: vi.fn(), editingMessage: null, onCancelEdit: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue('sent'), sendCorrection: vi.fn(),
      retractMessage: vi.fn(), sendChatState: vi.fn(), isArchived: () => false,
      unarchiveConversation: vi.fn(), clearFirstNewMessageId: vi.fn(),
      getDraft: chatStore.getState().getDraft, setDraft: chatStore.getState().setDraft,
      clearDraft: chatStore.getState().clearDraft, contactsByJid: new Map(),
      sendEasterEgg: vi.fn(), isConnected: true, encryptionState: { kind: 'disabled' },
    }
    const view = render(<MessageInput {...props} />)
    view.rerender(<MessageInput {...props} editingMessage={edited} />)
    expect(screen.getByRole('combobox')).toHaveValue(edited.body)
    view.rerender(<MessageInput {...props} conversationId={destination} editingMessage={edited} />)
    expect(screen.getByRole('combobox')).toHaveValue(destinationDraft)
    view.rerender(<MessageInput {...props} conversationId={destination} editingMessage={null} />)
    expect(screen.getByRole('combobox')).toHaveValue(destinationDraft)
    expect(chatStore.getState().getDraft(destination)).toBe(destinationDraft)
  })

  it('restores a keyed room draft before the previous room edit clears', () => {
    const room = 'team@conference.fluux.chat'
    const next = 'design@conference.fluux.chat'
    const oldEdit = roomMessageFixture({
      roomJid: room, id: 'earlier-room-message', from: `${room}/You`,
      nick: 'You', body: 'Good catch.', isOutgoing: true,
    })
    const props: ComponentProps<typeof RoomMessageInput> = {
      roomJid: room, roomName: 'Team Chat', sendMessage: vi.fn(),
      sendCorrection: vi.fn(), retractMessage: vi.fn(), sendChatState: vi.fn(),
      sendWhisperChatState: vi.fn(), sendEasterEgg: vi.fn(), sendPoll: vi.fn(),
      replyingTo: null, onCancelReply: vi.fn(), editingMessage: null,
      onCancelEdit: vi.fn(), isConnected: true, sendWhisper: vi.fn(), whisperTarget: null,
    }
    const view = render(<RoomMessageInput {...props} key={room} />)
    view.rerender(<RoomMessageInput {...props} editingMessage={oldEdit} key={room} />)
    expect(screen.getByRole('combobox')).toHaveTextContent(oldEdit.body)
    view.rerender(<RoomMessageInput {...props} roomJid={next} editingMessage={oldEdit} key={next} />)
    expect(screen.getByRole('combobox')).toHaveTextContent(destinationDraft)
    view.rerender(<RoomMessageInput {...props} roomJid={next} editingMessage={null} key={next} />)
    expect(screen.getByRole('combobox')).toHaveTextContent(destinationDraft)
    expect(roomStore.getState().getDraft(next)).toBe(destinationDraft)
  })
})
