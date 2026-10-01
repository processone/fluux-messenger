/** @vitest-environment jsdom */
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearAllMessages, saveMessages, saveRoomMessages, updateMessage } from '@fluux/sdk/cache'
import { roomStore, setSearchClient } from '@fluux/sdk/stores'
import { useSearch, messageRowRef, type Message, type SearchResult } from '@fluux/sdk'
import { roomMessageFixture } from '@/test-utils/roomMessages'
import { findMessageRowElement, messageTargetRowId } from './conversation/messageRowIdentity'
import { SearchContextView } from './SearchContextView'

const navigation = vi.hoisted(() => ({ navigateToRoom: vi.fn(), navigateToConversation: vi.fn() }))
vi.mock('@/hooks/useNavigateToTarget', () => ({ useNavigateToTarget: () => navigation }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))

beforeEach(async () => {
  await clearAllMessages()
  roomStore.setState({ messages: new Map(), pendingRetractions: new Map() })
  navigation.navigateToRoom.mockClear()
  navigation.navigateToConversation.mockClear()
  setSearchClient(null)
})

afterEach(() => vi.restoreAllMocks())

it.each((['stanzaId', 'originId'] as const).flatMap(tier =>
  (['local', 'mam'] as const).flatMap(source => [0, 1].map(target => ({ tier, source, target }))),
))('keeps chat twins in $source previews by $tier and highlights target $target', async ({ tier, source, target }) => {
  const first: Message = { type: 'chat', conversationId: 'alice@example.com', from: 'alice@example.com',
    id: 'shared', stanzaId: undefined, originId: undefined, [tier]: 'first', body: 'Earlier chat twin', timestamp: new Date(1000), isOutgoing: false }
  const second = { ...first, [tier]: 'second', body: 'Later chat twin', timestamp: new Date(2000) }
  if (source === 'local') await saveMessages([first, second])
  else setSearchClient({ messages: {
    fetchContextAround: vi.fn().mockResolvedValue({ messages: [first, second, first] }), catchUpTo: vi.fn().mockResolvedValue(undefined),
  } } as never)
  const selected = [first, second][target]
  const other = [first, second][1 - target]
  const previewResult: SearchResult = { indexId: 'selected', messageId: selected.id, isRoom: false, conversationId: selected.conversationId,
    conversationName: 'Alice', from: selected.from, stanzaId: selected.stanzaId, originId: selected.originId,
    body: selected.body, timestamp: +selected.timestamp, source, matchSnippet: null }
  const searchState = vi.mocked(useSearch).getMockImplementation()!()
  vi.mocked(useSearch).mockReturnValue({ ...searchState, previewResult, query: '', setPreviewResult: vi.fn() })
  render(<SearchContextView />)
  await screen.findByText(second.body)
  const targetRow = screen.getByText(selected.body).closest<HTMLElement>('[data-message-row-id]')!
  const otherRow = screen.getByText(other.body).closest<HTMLElement>('[data-message-row-id]')!
  expect(targetRow.dataset.messageRowId).not.toBe(otherRow.dataset.messageRowId)
  await waitFor(() => expect(targetRow).toHaveClass('message-highlight-persistent'))
  expect(otherRow).not.toHaveClass('message-highlight-persistent')
  fireEvent.click(screen.getByText(other.body))
  expect(navigation.navigateToConversation).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText(selected.body))
  expect(navigation.navigateToConversation).toHaveBeenCalledExactlyOnceWith(selected.conversationId, selected.id)
})

const identityChanges: { name: string; before: Partial<Message>; after: Partial<Message> }[] = [
  { name: 'client to origin', before: {}, after: { originId: 'origin' } },
  { name: 'client to stanza', before: {}, after: { stanzaId: 'archive' } },
  { name: 'origin to stanza', before: { originId: 'origin' }, after: { stanzaId: 'archive' } },
  { name: 'stanza to origin', before: { stanzaId: 'archive', originId: 'origin' }, after: { stanzaId: undefined } },
  { name: 'stanza to client', before: { stanzaId: 'archive' }, after: { stanzaId: undefined } },
  { name: 'origin to client', before: { originId: 'origin' }, after: { originId: undefined } },
  { name: 'client id replacement', before: { stanzaId: 'archive' }, after: { id: 'survivor' } },
]

it.each(identityChanges.flatMap(change => (['local', 'mam'] as const).map(source => ({ ...change, source }))))(
  'resolves a $source preview after $name before scrolling and highlighting', async ({ before, after, source }) => {
    const snapshot: Message = { stanzaId: undefined, originId: undefined, type: 'chat', conversationId: 'alice@example.com', from: 'alice@example.com',
      id: 'shared', body: 'Selected chat result', timestamp: new Date(2000), isOutgoing: false, ...before }
    await saveMessages([snapshot])
    const previewResult: SearchResult = { indexId: 'selected', messageId: snapshot.id, isRoom: false,
      conversationId: snapshot.conversationId, conversationName: 'Alice', from: snapshot.from,
      stanzaId: snapshot.stanzaId, originId: snapshot.originId, body: snapshot.body,
      timestamp: +snapshot.timestamp, source, matchSnippet: null }
    await updateMessage(snapshot.conversationId, snapshot.id, after, snapshot.from)
    const current = { ...snapshot, ...after }
    const twin = current.stanzaId || current.originId ? { ...current, id: snapshot.id,
      stanzaId: current.stanzaId ? 'other-archive' : undefined, originId: current.originId ? 'other-origin' : undefined,
      body: 'Earlier unrelated twin', timestamp: new Date(1000) } : undefined
    if (twin) await saveMessages([twin])
    if (source === 'mam') setSearchClient({ messages: {
      fetchContextAround: vi.fn().mockResolvedValue({ messages: twin ? [twin, current] : [current] }),
      catchUpTo: vi.fn().mockResolvedValue(undefined),
    } } as never)
    const searchState = vi.mocked(useSearch).getMockImplementation()!()
    vi.mocked(useSearch).mockReturnValue({ ...searchState, previewResult, query: '', setPreviewResult: vi.fn() })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const scroller = this.closest<HTMLElement>('[data-message-list]')
      const top = this.hasAttribute('data-message-row-id') ? 500 - (scroller?.scrollTop ?? 0) : 0
      return { top, bottom: top + 40, left: 0, right: 800, width: 800, height: 40, x: 0, y: top } as DOMRect
    })

    render(<SearchContextView />)

    const targetRow = (await screen.findByText(current.body)).closest<HTMLElement>('[data-message-row-id]')!
    const scroller = targetRow.closest<HTMLElement>('[data-message-list]')!
    await waitFor(() => {
      expect(targetRow).toHaveClass('message-highlight-persistent')
      expect(scroller.scrollTop).toBe(400)
    })
    if (twin) {
      const otherRow = screen.getByText(twin.body).closest<HTMLElement>('[data-message-row-id]')!
      expect(otherRow).not.toHaveClass('message-highlight-persistent')
      fireEvent.click(screen.getByText(twin.body))
      expect(navigation.navigateToConversation).not.toHaveBeenCalled()
    }
    fireEvent.click(screen.getByText(current.body))
    expect(navigation.navigateToConversation).toHaveBeenCalledExactlyOnceWith(current.conversationId, current.id)
    navigation.navigateToConversation.mockClear()
    fireEvent.click(screen.getByText('search.goToMessage'))
    expect(navigation.navigateToConversation).toHaveBeenCalledExactlyOnceWith(current.conversationId, current.id)
  },
)

it.each(['local', 'mam'] as const)('keeps both room first deliveries in a %s preview', async source => {
  const first = roomMessageFixture({ stanzaId: undefined, originId: undefined, occupantId: undefined, type: 'groupchat' as const, roomJid: 'search@conference.example.com',
    from: 'search@conference.example.com/Peer', nick: 'Peer', id: 'shared', body: 'First room delivery',
    timestamp: new Date(1000), receivedAt: new Date(1000), isOutgoing: false, isDelayed: false })
  const second = { ...first, body: 'Second room delivery', timestamp: new Date(2000), receivedAt: new Date(2000) }
  if (source === 'local') await saveRoomMessages([first, second])
  else setSearchClient({ messages: {
    fetchContextAround: vi.fn().mockResolvedValue({ messages: [first, second] }), catchUpTo: vi.fn().mockResolvedValue(undefined),
  } } as never)
  const previewResult: SearchResult = { indexId: 'selected', messageId: second.id, isRoom: true,
    conversationId: second.roomJid, conversationName: 'Search room', from: second.from, body: second.body,
    timestamp: +second.timestamp, source, matchSnippet: null }
  const searchState = vi.mocked(useSearch).getMockImplementation()!()
  vi.mocked(useSearch).mockReturnValue({ ...searchState, previewResult, query: '', setPreviewResult: vi.fn() })

  render(<SearchContextView />)

  const secondRow = (await screen.findByText(second.body)).closest('[data-message-row-id]')
  const firstRow = screen.getByText(first.body).closest('[data-message-row-id]')
  expect(firstRow).not.toBeNull()
  expect(secondRow).not.toBeNull()
  expect(firstRow).not.toBe(secondRow)
})

it('loads and highlights only confirmed B and navigates to its exact rendered row', async () => {
  const legacy = { type: 'groupchat' as const, roomJid: 'search@conference.example.com', from: 'search@conference.example.com/Peer',
    nick: 'Peer', id: 'shared', originId: undefined, occupantId: 'peer', stanzaId: 'same', body: 'Earlier uncertain A', timestamp: new Date(1000), isOutgoing: false }
  const confirmed = roomMessageFixture({ ...legacy, stanzaId: 'later-archive', body: 'Later confirmed B', timestamp: new Date(2000) })
  await saveRoomMessages([legacy, confirmed])
  const previewResult: SearchResult = { indexId: 'confirmed', messageId: confirmed.id, isRoom: true, conversationId: confirmed.roomJid,
    conversationName: 'Search room', from: confirmed.from, stanzaId: confirmed.stanzaId, occupantId: confirmed.occupantId,
     body: confirmed.body, timestamp: +confirmed.timestamp, source: 'local', matchSnippet: null }
  const setPreviewResult = vi.fn()
  const searchState = vi.mocked(useSearch).getMockImplementation()!()
  vi.mocked(useSearch).mockReturnValue({ ...searchState, previewResult, query: 'unmatched', setPreviewResult })
  const { container } = render(<SearchContextView />)
  await screen.findByText(confirmed.body)
  const first = screen.getByText(legacy.body).closest<HTMLElement>('[data-message-row-id]')!
  const second = screen.getByText(confirmed.body).closest<HTMLElement>('[data-message-row-id]')!
  expect(first).not.toBe(second)
  await waitFor(() => expect(second).toHaveClass('message-highlight-persistent'))
  expect(first).not.toHaveClass('message-highlight-persistent')
  fireEvent.click(screen.getByText(legacy.body))
  expect(navigation.navigateToRoom).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText(confirmed.body))
  expect(navigation.navigateToRoom).toHaveBeenCalledOnce()
  let handle = navigation.navigateToRoom.mock.calls[0][1]
  expect(handle).toEqual(messageRowRef(confirmed))
  expect(findMessageRowElement(container, messageTargetRowId(handle))).toBe(second)
  navigation.navigateToRoom.mockClear()
  fireEvent.click(screen.getByText('search.goToMessage'))
  handle = navigation.navigateToRoom.mock.calls[0][1]
  expect(findMessageRowElement(container, messageTargetRowId(handle))).toBe(second)
})
