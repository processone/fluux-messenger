import { confirmedRoomMessage } from '@/test-utils/roomMessages'
import 'fake-indexeddb/auto'
import { clearAllMessages, saveRoomMessages } from '@fluux/sdk/cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { createRef, type ComponentProps } from 'react'
import { roomStore } from '@fluux/sdk/stores'
import { useSearch, type RoomMessage, type SearchResult } from '@fluux/sdk'
import { fireEvent } from '@testing-library/react'
import { messageRowId } from './conversation/messageRowIdentity'
import { SearchContextView, SearchContextMessageList } from './SearchContextView'

vi.mock('./conversation', async importOriginal => {
  const actual = await importOriginal<typeof import('./conversation')>()
  return {
    ...actual,
    MessageList: ({ messages, renderMessage }: { messages: RoomMessage[]; renderMessage: (message: RoomMessage, index: number, group: RoomMessage[], marker: boolean, onMediaLoad: () => void) => React.ReactNode }) =>
      <div>{messages.map((message, index) => <article key={messageRowId(message)} data-testid={`row-${message.id}`} data-archive-id={message.stanzaId}>
        {renderMessage(message, index, messages, false, () => {})}
      </article>)}</div>,
  }
})
vi.mock('@/hooks/useNavigateToTarget', () => ({ useNavigateToTarget: () => ({ navigateToRoom: vi.fn(), navigateToConversation: vi.fn() }) }))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))

const roomJid = 'context@conference.example.com'
const base: RoomMessage = confirmedRoomMessage({
  type: 'groupchat', roomJid, id: 'legitimate', stanzaId: 'legitimate-archive',
  from: `${roomJid}/Member`, nick: 'Member', body: 'Legitimate match', timestamp: new Date(), isOutgoing: false,
})
const props: Omit<ComponentProps<typeof SearchContextMessageList>, 'messages'> = {
  conversationId: 'preview', messageConversationId: roomJid, isRoom: true,
  highlightedMessage: base, onHighlightedClick: vi.fn(), contactsByJid: new Map(),
  scrollerRef: createRef(), isAtBottomRef: { current: false },
}

describe('Spam in search context messages', () => {
  it('hides Spam rows while retaining ordinary deletion placeholders and raw markers', () => {
    const spam = { ...base, id: 'spam', stanzaId: 'spam-archive', nick: 'Spammer', from: `${roomJid}/Spammer`,
      isRetracted: true, isModerated: true, moderationReason: 'Spam', body: 'Hidden spam' }
    const ordinary = { ...base, id: 'deleted', stanzaId: 'deleted-archive', isRetracted: true, body: 'Ordinary deleted text' }
    const messages = [spam, base, ordinary]
    render(<SearchContextMessageList {...props} messages={messages} />)
    expect(screen.queryByTestId('row-spam')).not.toBeInTheDocument()
    expect(screen.queryByText('Spammer')).not.toBeInTheDocument()
    expect(screen.getByTestId('row-legitimate')).toHaveTextContent('Legitimate match')
    expect(screen.getByTestId('row-deleted')).toHaveTextContent('chat.messageDeleted')
    expect(messages).toEqual([spam, base, ordinary])
    expect(messages[0].isRetracted).toBe(true)
  })
})


describe('moderation after opening full search context', () => {
  beforeEach(() => roomStore.setState({ messages: new Map(), pendingRetractions: new Map() }))

  it.each(['resident', 'pending'])('reacts to %s moderation without replacing the loaded snapshot', async source => {
    const ordinary = { ...base, id: 'deleted', stanzaId: 'deleted-archive', isRetracted: true, body: '' }
    const messages = [base, ordinary]
    render(<SearchContextMessageList {...props} messages={messages} />)
    expect(screen.getByText(base.body)).toBeInTheDocument()
    act(() => {
      if (source === 'resident') roomStore.setState({ messages: new Map([[roomJid, [{ ...base,
        isRetracted: true, isModerated: true, moderationReason: 'Spam',
      }]]]) })
      else roomStore.setState({ pendingRetractions: new Map([[roomJid, [{
        targetId: base.stanzaId!, actorJid: roomJid, retractedAt: Date.now(),
        moderation: { isModerated: true, moderationReason: 'Spam' },
      }]]]) })
    })
    await waitFor(() => expect(screen.queryByTestId('row-legitimate')).not.toBeInTheDocument())
    expect(screen.getByTestId('row-deleted')).toHaveTextContent('chat.messageDeleted')
    expect(messages).toEqual([base, ordinary])
  })

  it.each(['client-id', 'room', 'occupant'])('keeps a row when moderation only matches another %s identity', async kind => {
    const message = { ...base, occupantId: 'original' }
    render(<SearchContextMessageList {...props} messages={[message]} />)
    act(() => roomStore.setState({ messages: new Map([[kind === 'room' ? 'other@conference.example.com' : roomJid, [{
      ...message, ...(kind === 'occupant' ? { occupantId: 'other' } : { stanzaId: 'other-archive' }),
      isRetracted: true, isModerated: true, moderationReason: 'Spam',
    }]]]) }))
    await act(async () => {})
    expect(screen.getByText(base.body)).toBeInTheDocument()
  })
})


it('turns late ordinary moderation into a deletion placeholder without changing the raw snapshot', async () => {
  roomStore.setState({ messages: new Map(), pendingRetractions: new Map() })
  const messages = [base]
  render(<SearchContextMessageList {...props} messages={messages} />)
  expect(screen.getByText(base.body)).toBeInTheDocument()
  act(() => roomStore.setState({ pendingRetractions: new Map([[roomJid, [{
    targetId: base.stanzaId!, actorJid: roomJid, retractedAt: Date.now(),
    moderation: { isModerated: true, moderationReason: 'Off topic' },
  }]]]) }))
  await waitFor(() => expect(screen.getByTestId('row-legitimate')).toHaveTextContent('chat.messageDeleted'))
  expect(messages).toEqual([base])
})


describe('search context quotation authority', () => {
  beforeEach(async () => {
    await clearAllMessages()
    roomStore.setState({ messages: new Map(), pendingRetractions: new Map() })
  })

  it.each(['snapshot', 'cache'])('retains a legitimate quotation owned by the %s archive identity', async source => {
    const legitimate = { ...base, occupantId: 'original-author' }
    const collision = { ...base, id: base.stanzaId!, stanzaId: 'collision-archive', occupantId: 'later-author',
      body: 'Unrelated spam', isRetracted: true, isModerated: true, moderationReason: 'Spam' }
    const reply = { ...base, id: 'reply', stanzaId: 'reply-archive', body: 'Reply text',
      replyTo: { id: base.stanzaId!, to: base.from, fallbackBody: 'Ordinary fallback' } }
    await saveRoomMessages([legitimate, collision])
    roomStore.setState({ messages: new Map([[roomJid, [collision]]]) })
    render(<SearchContextMessageList {...props} messages={source === 'snapshot' ? [legitimate, collision, reply] : [collision, reply]} />)
    await waitFor(() => expect(screen.getByTestId('row-reply').querySelector('.reply-quote-preview')).toHaveTextContent(base.body))
    expect(screen.queryByText('Unrelated spam')).not.toBeInTheDocument()
  })

  it('hides the quotation of a cached Spam archive owner despite a legitimate resident alias', async () => {
    const original = { ...base, occupantId: 'original-author', isRetracted: true, isModerated: true, moderationReason: 'Spam' }
    const collision = { ...base, id: base.stanzaId!, stanzaId: 'collision-archive', occupantId: 'later-author', body: 'Unrelated legitimate message' }
    const reply = { ...base, id: 'reply', stanzaId: 'reply-archive', body: 'Reply text',
      replyTo: { id: base.stanzaId!, to: base.from, fallbackBody: 'Hidden fallback' } }
    await saveRoomMessages([original, collision])
    roomStore.setState({ messages: new Map([[roomJid, [collision]]]) })
    render(<SearchContextMessageList {...props} messages={[collision, reply]} />)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    expect(screen.getByTestId('row-reply').querySelector('.reply-quote-preview')).toBeNull()
    expect(screen.getByTestId('row-reply')).toHaveTextContent('Reply text')
    expect(screen.getByText('Unrelated legitimate message')).toBeInTheDocument()
  })
})


describe('full context archive identity', () => {
  beforeEach(async () => {
    await clearAllMessages()
    roomStore.setState({ messages: new Map(), pendingRetractions: new Map() })
  })

  it('loads both colliding archive rows, switches context, and hides only the moderated row', async () => {
    const first = confirmedRoomMessage({ ...base, id: 'shared', occupantId: 'author', stanzaId: 'archive-a',
      body: 'First archive result', timestamp: new Date(1000) })
    const second = confirmedRoomMessage({ ...first, stanzaId: 'archive-b', body: 'Second archive result', timestamp: new Date(2000) })
    await saveRoomMessages([first, second])
    const preview = (message: RoomMessage): SearchResult => ({
      indexId: message.stanzaId!, messageId: message.id, conversationId: roomJid, conversationName: 'Room',
      isRoom: true, from: message.from, occupantId: message.occupantId, stanzaId: message.stanzaId,
      stanzaIdAuthority: message.stanzaIdAuthority, body: message.body, timestamp: +message.timestamp,
      source: 'local', matchSnippet: null,
    })
    const setPreviewResult = vi.fn()
    const searchState = vi.mocked(useSearch).getMockImplementation()!()
    vi.mocked(useSearch).mockReturnValue({ ...searchState, previewResult: preview(first), query: 'unmatched-search-term', setPreviewResult })
    const { rerender, container } = render(<SearchContextView />)
    await waitFor(() => expect(screen.getByText(first.body)).toBeInTheDocument())
    expect(screen.getByText(second.body)).toBeInTheDocument()
    expect(container.querySelector('[data-archive-id="archive-a"] > .cursor-pointer')).toBeTruthy()
    expect(container.querySelector('[data-archive-id="archive-b"] > .cursor-pointer')).toBeNull()
    const fresh = confirmedRoomMessage({ ...second, id: 'new-context', stanzaId: 'new-context', body: 'Freshly loaded context', timestamp: new Date(3000) })
    await saveRoomMessages([fresh])
    vi.mocked(useSearch).mockReturnValue({ ...searchState, previewResult: preview(second), query: 'unmatched-search-term', setPreviewResult })
    rerender(<SearchContextView />)
    await waitFor(() => expect(screen.getByText(fresh.body)).toBeInTheDocument())
    expect(container.querySelector('[data-archive-id="archive-a"] > .cursor-pointer')).toBeNull()
    expect(container.querySelector('[data-archive-id="archive-b"] > .cursor-pointer')).toBeTruthy()
    act(() => roomStore.setState({ pendingRetractions: new Map([[roomJid, [{ targetId: first.stanzaId!, actorJid: roomJid,
      retractedAt: Date.now(), moderation: { isModerated: true, moderationReason: 'Spam' } }]]]) }))
    await waitFor(() => expect(screen.queryByText(first.body)).not.toBeInTheDocument())
    expect(screen.getByText(second.body)).toBeInTheDocument()
    fireEvent.click(screen.getByText(second.body))
    expect(setPreviewResult).toHaveBeenCalledWith(null)
  })
})
