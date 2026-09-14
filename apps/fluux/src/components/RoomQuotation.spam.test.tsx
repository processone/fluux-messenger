import 'fake-indexeddb/auto'
import { IDBIndex } from 'fake-indexeddb'
import { clearAllMessages, saveRoomMessage } from '@fluux/sdk/cache'
import { roomStore } from '@fluux/sdk/stores'
import type { Room, RoomMessage } from '@fluux/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { RoomMessageList } from './RoomView'
import { SearchContextMessageList } from './SearchContextView'
import { confirmedRoomMessage } from '@/test-utils/roomMessages'

vi.mock('@/utils/featureFlags', () => ({ isFeatureEnabled: () => false }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
vi.mock('./conversation', async importOriginal => ({
  ...await importOriginal<typeof import('./conversation')>(),
  MessageList: ({ messages, renderMessage }: { messages: RoomMessage[]; renderMessage: (message: RoomMessage, index: number, group: RoomMessage[], marker: boolean, onMediaLoad: () => void) => React.ReactNode }) =>
    <div>{messages.map((message, index) => <article key={message.id}>{renderMessage(message, index, messages, false, () => {})}</article>)}</div>,
}))

const roomJid = 'quotation@conference.example.com'
const original: RoomMessage = confirmedRoomMessage({
  type: 'groupchat', roomJid, id: 'original', stanzaId: 'original-archive', occupantId: 'alice',
  from: `${roomJid}/Alice`, nick: 'Alice', body: 'Original quotation', timestamp: new Date(), isOutgoing: false,
})
const reply: RoomMessage = {
  ...original, id: 'reply', stanzaId: 'reply-archive', occupantId: 'bob', from: `${roomJid}/Bob`, nick: 'Bob',
  body: 'Legitimate reply', replyTo: { id: original.stanzaId!, to: original.from, fallbackBody: 'Saved quotation fallback' },
}
const room: Room = {
  jid: roomJid, name: 'Room', nickname: 'Me', joined: true, isBookmarked: true,
  unreadCount: 0, mentionsCount: 0, typingUsers: new Set(), occupants: new Map(),
}

function Quotation({ view }: { view: 'timeline' | 'search' }) {
  const shared = { messages: [reply], scrollerRef: { current: null }, isAtBottomRef: { current: true }, contactsByJid: new Map() }
  return view === 'search'
    ? <SearchContextMessageList {...shared} conversationId="preview" messageConversationId={roomJid} isRoom highlightedMessage={reply} onHighlightedClick={vi.fn()} />
    : <RoomMessageList {...shared} room={room} onLiveEdgeMeasured={vi.fn()} sendReaction={vi.fn()} votePoll={vi.fn()} closePoll={vi.fn()}
        onReply={vi.fn()} onEdit={vi.fn()} lastOutgoingMessageId={null} lastMessageId={reply.id} typingUsers={[]}
        activeReactionPickerMessageId={null} onReactionPickerChange={vi.fn()} retractMessage={vi.fn()} moderateMessage={vi.fn()}
        selectedMessageId={null} hasKeyboardSelection={false} showToolbarForSelection={false} clearFirstNewMessageId={vi.fn()}
        isJoined isHistoryComplete setAffiliation={vi.fn()} />
}

beforeEach(async () => {
  await clearAllMessages()
  roomStore.setState({ messages: new Map([[roomJid, [reply]]]), pendingRetractions: new Map() })
})
afterEach(() => vi.restoreAllMocks())

describe.each(['timeline', 'search'] as const)('%s quotation parent', view => {
  it.each(['Spam', '  sPaM  '])('reacts to resident moderation with reason %s', async moderationReason => {
    roomStore.setState({ messages: new Map([[roomJid, [original, reply]]]) })
    const { container } = render(<Quotation view={view} />)
    expect(container.querySelector('.reply-quote-preview')).toHaveTextContent(original.body)
    act(() => roomStore.setState({ messages: new Map([[roomJid, [{ ...original,
      isRetracted: true, isModerated: true, moderationReason,
    }, reply]]]) }))
    expect(container.querySelector('.reply-quote-preview')).toBeNull()
    expect(screen.queryByText(reply.replyTo!.fallbackBody!)).not.toBeInTheDocument()
    expect(screen.getByText(reply.body)).toBeInTheDocument()
  })

  it.each(['spam', 'ordinary', 'missing'])('performs one cache resolution and preserves eligible fallback (%s)', async mode => {
    if (mode !== 'missing') await saveRoomMessage({ ...original, body: '', isRetracted: true, isModerated: true,
      moderationReason: mode === 'spam' ? 'Spam' : 'Off topic' })
    let completed = 0
    const getAll = IDBIndex.prototype.getAll
    const reads = vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args) {
      const request = getAll.apply(this, args)
      if (String(args[0]).includes(original.stanzaId!)) request.addEventListener('success', () => { completed++ })
      return request
    })
    const { container } = render(<Quotation view={view} />)
    expect(container.querySelector('.reply-quote-preview')).toBeNull()
    await waitFor(() => expect(completed).toBeGreaterThan(0))
    await act(async () => {})
    if (mode === 'spam') expect(container.querySelector('.reply-quote-preview')).toBeNull()
    else await waitFor(() => expect(container.querySelector('.reply-quote-preview')).toHaveTextContent(reply.replyTo!.fallbackBody!))
    expect(screen.getByText(reply.body)).toBeInTheDocument()
    if (mode !== 'missing') expect(reads.mock.calls.filter(([query]) => String(query).includes(original.stanzaId!))).toHaveLength(1)
  })
})
