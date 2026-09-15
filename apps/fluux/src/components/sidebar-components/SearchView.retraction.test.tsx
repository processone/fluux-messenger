import 'fake-indexeddb/auto'
import { clearAllMessages, saveRoomMessages } from '@fluux/sdk/cache'
import { roomMessageFixture } from '@/test-utils/roomMessages'
/**
 * Retracted neighbours in a search result's context lines.
 *
 * A known retraction is excluded when search results are projected, but it CAN
 * still appear as context: `fetchResultContexts` reads the surrounding messages
 * straight from the cache, which deliberately preserves `body` through a
 * retraction so the bubble can be replaced in place. Rendering that body would
 * resurface text the sender deleted, so the line must show the localized
 * "message deleted" notice instead — and, like the sidebar, in italic.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { roomStore } from '@fluux/sdk/stores'
import { SearchView } from './SearchView'
import { messageRowRef, findMessageRowIndex } from '@fluux/sdk'
import type { SearchResult, SearchResultContext } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@/hooks', async () => import('@/hooks/useListKeyboardNav'))

const navigation = vi.hoisted(() => ({ navigateToConversation: vi.fn(), navigateToRoom: vi.fn() }))
vi.mock('@/hooks/useNavigateToTarget', () => ({ useNavigateToTarget: () => navigation }))

vi.mock('../Avatar', () => ({ Avatar: () => <div data-testid="avatar" /> }))
vi.mock('../ui/TextInput', () => ({ TextInput: () => <input data-testid="search" /> }))
vi.mock('@/utils/dateFormat', () => ({ formatConversationTime: () => '12:00' }))
vi.mock('@/utils/renderLoopDetector', () => ({ detectRenderLoop: () => {} }))
vi.mock('./types', () => ({ useSidebarZone: () => ({ current: null }) }))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string }) => unknown) => selector({ timeFormat: '24h' }),
}))

const { emptyStore } = vi.hoisted(() => ({
  emptyStore: { getState: () => ({ rooms: new Map(), contacts: new Map() }), subscribe: () => () => {} },
}))

vi.mock('@fluux/sdk/react', () => ({
  useRoomStore: () => undefined,
  useRosterStore: () => undefined,
}))

let mockSearch: ReturnType<typeof baseSearch>
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  const { useState } = await import('react')
  return {
    ...actual,
    useSearch: () => {
      const [previewResult, setPreview] = useState(mockSearch.previewResult)
      return { ...mockSearch, previewResult, setPreviewResult: (result: SearchResult | null) => {
        mockSearch.setPreviewResult(result)
        setPreview(result)
      } }
    },
    chatStore: { getState: () => ({ conversationEntities: new Map() }) },
    roomStore: emptyStore,
    rosterStore: emptyStore,
    getLocalPart: (jid: string) => jid.split('@')[0],
  }
})

const RESULT: SearchResult = {
  indexId: '1',
  conversationId: 'alice@example.com',
  conversationName: 'alice',
  messageId: 'm-1',
  isRoom: false,
  from: 'alice@example.com',
  timestamp: 1700000000000,
  source: 'local',
  body: 'hello world',
  matchSnippet: { text: 'hello world', matchStart: 0, matchEnd: 5 },
} as unknown as SearchResult

function baseSearch(resultContext: Map<string, SearchResultContext>) {
  return {
    query: 'hello', results: [RESULT], isSearching: false, error: null,
    search: vi.fn(), clearSearch: vi.fn(), previewResult: null as SearchResult | null, setPreviewResult: vi.fn(),
    isSearchingMAM: false, mamResults: [] as SearchResult[], hasMoreMAMResults: false, mamError: null,
    searchScope: null, searchMAM: vi.fn(), loadMoreMAMResults: vi.fn(), setSearchScope: vi.fn(),
    resultContext, searchFilter: 'all', setSearchFilter: vi.fn(),
    inPrefixSuggestions: [], isInPrefixActive: false, selectInPrefixSuggestion: vi.fn(),
  }
}

const contextWith = (before: Partial<SearchResultContext['before'][number]>[]) =>
  new Map<string, SearchResultContext>([
    ['1', { before: before as SearchResultContext['before'], after: [] }],
  ])

beforeEach(async () => { await clearAllMessages() })

function confirmedHitMessage(hit: SearchResult) {
  return roomMessageFixture({ type: 'groupchat', roomJid: hit.conversationId, id: hit.messageId,
    stanzaId: hit.stanzaId, occupantId: hit.occupantId, from: hit.from, nick: hit.nick ?? 'Author',
    body: hit.body, timestamp: new Date(hit.timestamp), isOutgoing: false })
}

describe('SearchView context lines and retraction', () => {
  it('shows the deleted notice instead of the body a retracted neighbour kept', () => {
    mockSearch = baseSearch(
      contextWith([{ body: 'the secret', from: 'bob@example.com', timestamp: 1, isRetracted: true }]),
    )
    const { container } = render(<SearchView />)

    expect(container.textContent).toContain('chat.messageDeleted')
    expect(container.textContent).not.toContain('the secret')
  })

  it('italicises the notice, matching the sidebar', () => {
    mockSearch = baseSearch(
      contextWith([{ body: 'the secret', from: 'bob@example.com', timestamp: 1, isRetracted: true }]),
    )
    const { container } = render(<SearchView />)

    const notice = [...container.querySelectorAll('span.italic')].find(
      (el) => el.textContent === 'chat.messageDeleted',
    )
    expect(notice).toBeTruthy()
  })

  it('still renders a bodiless retraction rather than dropping the line', () => {
    mockSearch = baseSearch(contextWith([{ body: '', from: 'bob@example.com', timestamp: 1, isRetracted: true }]))
    const { container } = render(<SearchView />)

    expect(container.textContent).toContain('chat.messageDeleted')
  })

  it('leaves an ordinary context line unchanged', () => {
    mockSearch = baseSearch(contextWith([{ body: 'good morning', from: 'bob@example.com', timestamp: 1 }]))
    const { container } = render(<SearchView />)

    expect(container.textContent).toContain('good morning')
    expect(container.textContent).not.toContain('chat.messageDeleted')
  })

  it('still drops a context line that has no body and is not retracted', () => {
    mockSearch = baseSearch(contextWith([{ body: '', from: 'bob@example.com', timestamp: 1 }]))
    const { container } = render(<SearchView />)

    expect(container.textContent).not.toContain('bob')
  })
})


it('hides Spam neighbours on both sides while keeping ordinary deletion notices', () => {
  mockSearch = baseSearch(new Map([['1', {
    before: [{ body: 'spam before', nick: 'Spammer before', from: 'room@example.com/Spammer before', timestamp: 1, isRetracted: true, isModerated: true, moderationReason: 'Spam' }],
    after: [
      { body: 'spam after', nick: 'Spammer after', from: 'room@example.com/Spammer after', timestamp: 3, isRetracted: true, isModerated: true, moderationReason: '  SPAM ' },
      { body: 'ordinary deleted', nick: 'Ordinary', from: 'room@example.com/Ordinary', timestamp: 4, isRetracted: true },
    ],
  }]]))
  mockSearch.results = [{ ...RESULT, isRoom: true }]
  const { container } = render(<SearchView />)
  expect(container.textContent).not.toContain('Spammer')
  expect(container.textContent).not.toContain('spam before')
  expect(container.textContent).not.toContain('spam after')
  expect(container.textContent).toContain('Ordinary')
  expect(container.textContent).toContain('chat.messageDeleted')
  expect(container.textContent).toContain('hello world')
})


describe('moderation after opening sidebar search context', () => {
  beforeEach(() => roomStore.setState({ messages: new Map(), pendingRetractions: new Map() }))

  it.each(['resident', 'pending'])('refreshes both neighbours from %s moderation', async source => {
    const roomJid = 'room@conference.example.com'
    const before = roomMessageFixture({ type: 'groupchat' as const, roomJid, id: 'before', stanzaId: 'archive-before',
      from: `${roomJid}/Before`, nick: 'Before', occupantId: 'before-author', body: 'visible before', timestamp: new Date(1), isOutgoing: false })
    const after = roomMessageFixture({ ...before, id: 'after', stanzaId: 'archive-after', body: 'visible after' })
    const project = (message: typeof before) => ({ ...message, timestamp: message.timestamp.getTime(), roomMessage: message })
    mockSearch = baseSearch(contextWith([project(before)]))
    mockSearch.results = [{ ...RESULT, isRoom: true, conversationId: roomJid }]
    mockSearch.resultContext.get('1')!.after = [project(after), { body: '', from: `${roomJid}/Deleted`, timestamp: 3, isRetracted: true }]
    const { container } = render(<SearchView />)
    expect(container.textContent).toContain('visible before')
    expect(container.textContent).toContain('visible after')
    act(() => {
      if (source === 'resident') roomStore.setState({ messages: new Map([[roomJid, [before, after].map(message => ({
        ...message, isRetracted: true, isModerated: true, moderationReason: 'Spam',
      }))]]) })
      else roomStore.setState({ pendingRetractions: new Map([[roomJid, [before, after].map(message => ({
        targetId: message.stanzaId, actorJid: roomJid, retractedAt: Date.now(),
        moderation: { isModerated: true, moderationReason: 'Spam' },
      }))]]) })
    })
    await waitFor(() => {
      expect(container.textContent).not.toContain('visible before')
      expect(container.textContent).not.toContain('visible after')
    })
    expect(container.textContent).toContain('chat.messageDeleted')
    expect(container.textContent).toContain('hello world')
  })
})


it.each(['client-id', 'occupant', 'room'])('preserves sidebar context with a colliding %s identity', async kind => {
  roomStore.setState({ messages: new Map(), pendingRetractions: new Map() })
  const roomJid = 'room@conference.example.com'
  const original = { type: 'groupchat' as const, roomJid, id: 'neighbour', stanzaId: 'archive',
    from: `${roomJid}/Alice`, nick: 'Alice', occupantId: 'alice', body: 'retained neighbour', timestamp: new Date(1), isOutgoing: false }
  mockSearch = baseSearch(contextWith([{ ...original, timestamp: 1, roomMessage: original }]))
  mockSearch.results = [{ ...RESULT, isRoom: true, conversationId: roomJid }]
  const { container } = render(<SearchView />)
  act(() => roomStore.setState({ messages: new Map([[kind === 'room' ? 'other@conference.example.com' : roomJid, [{
    ...original, ...(kind === 'occupant' ? { occupantId: 'other' } : { stanzaId: 'other-archive' }),
    isRetracted: true, isModerated: true, moderationReason: 'Spam',
  }]]]) }))
  await act(async () => {})
  expect(container.textContent).toContain(original.body)
})


it.each(['resident', 'pending'])('retains search-hit authority without an occupant ID during %s moderation', async source => {
  roomStore.setState({ messages: new Map(), pendingRetractions: new Map() })
  const roomJid = 'hit@conference.example.com'
  const target = { ...RESULT, isRoom: true, conversationId: roomJid, stanzaId: 'hit-archive', from: `${roomJid}/Author` }
  const confirmed = confirmedHitMessage(target)
  const legacy = { ...target, stanzaId: 'legacy-archive', indexId: 'legacy', messageId: 'legacy-client', body: 'Preserved legacy result',
    matchSnippet: { text: 'Preserved legacy result', matchStart: 0, matchEnd: 9 } }
  mockSearch = baseSearch(new Map())
  mockSearch.results = [{ ...target }, legacy]
  const { container } = render(<SearchView />)
  expect(container.textContent).toContain(target.body)
  expect(container.textContent).toContain(legacy.body)
  act(() => {
    if (source === 'resident') roomStore.setState({ messages: new Map([[roomJid, [{ ...confirmed,
      body: '', isRetracted: true, isModerated: true, moderationReason: 'Spam',
    }]]]) })
    else roomStore.setState({ pendingRetractions: new Map([[roomJid, [{ targetId: target.stanzaId, actorJid: roomJid,
      retractedAt: Date.now(), moderation: { isModerated: true, moderationReason: 'Spam' },
    }]]]) })
  })
  await waitFor(() => expect(container.textContent).not.toContain(target.body))
  expect(container.textContent).toContain(legacy.body)
})

describe('moderation of an already displayed search hit', () => {
  beforeEach(() => roomStore.setState({ messages: new Map(), pendingRetractions: new Map() }))

  it.each(['resident', 'pending', 'uncached'])('handles %s moderation knowledge for a displayed search hit', async source => {
    const roomJid = 'hit@conference.example.com'
    const hit = { ...RESULT, isRoom: true, conversationId: roomJid, stanzaId: 'hit-archive', occupantId: 'author', from: `${roomJid}/Author` }
    mockSearch = baseSearch(new Map())
    mockSearch.results = [hit, { ...hit, indexId: 'control', messageId: 'control', stanzaId: 'control-archive', body: 'Unrelated result',
      matchSnippet: { text: 'Unrelated result', matchStart: 0, matchEnd: 9 } }]
    if (source === 'pending') await saveRoomMessages([confirmedHitMessage(hit)])
    const { container } = render(<SearchView />)
    expect(container.textContent).toContain('hello world')
    act(() => {
      if (source === 'resident') roomStore.setState({ messages: new Map([[roomJid, [{ type: 'groupchat', roomJid,
        id: hit.messageId, stanzaId: hit.stanzaId, occupantId: hit.occupantId, from: hit.from, nick: 'Author', body: hit.body,
        timestamp: new Date(hit.timestamp), isOutgoing: false, isRetracted: true, isModerated: true, moderationReason: '  sPaM  ',
      }]]]) })
      else roomStore.setState({ pendingRetractions: new Map([[roomJid, [{ targetId: hit.stanzaId, actorJid: roomJid,
        retractedAt: Date.now(), moderation: { isModerated: true, moderationReason: 'Spam' },
      }]]]) })
    })
    await waitFor(() => expect(container.textContent).not.toContain('hello world'))
    expect(container.textContent).toContain('Unrelated result')
  })

  it.each(['ordinary', 'other-room', 'other-occupant'])('preserves a matched result for %s moderation', async kind => {
    const roomJid = 'hit@conference.example.com'
    const hit = { ...RESULT, isRoom: true, conversationId: roomJid, stanzaId: 'hit-archive', occupantId: 'author', from: `${roomJid}/Author` }
    mockSearch = baseSearch(new Map())
    mockSearch.results = [hit]
    const { container } = render(<SearchView />)
    act(() => roomStore.setState({ messages: new Map([[kind === 'other-room' ? 'other@conference.example.com' : roomJid, [{
      type: 'groupchat', roomJid, id: hit.messageId, stanzaId: hit.stanzaId, occupantId: kind === 'other-occupant' ? 'other' : hit.occupantId,
      from: hit.from, nick: 'Author', body: '', timestamp: new Date(hit.timestamp), isOutgoing: false,
      isRetracted: true, isModerated: true, moderationReason: kind === 'ordinary' ? 'Off topic' : 'Spam',
    }]]]) }))
    await act(async () => {})
    expect(container.textContent).toContain('hello world')
  })
})


it.each(['hidden', 'remaining'])('keeps keyboard selection and preview consistent when the %s hit was selected', async selected => {
  roomStore.setState({ messages: new Map(), pendingRetractions: new Map() })
  const roomJid = 'keyboard@conference.example.com'
  const hit: SearchResult = { ...RESULT, isRoom: true, conversationId: roomJid, stanzaId: 'hit-archive',
    occupantId: 'author', from: `${roomJid}/Author` }
  const otherRoom = 'other@conference.example.com'
  const remaining: SearchResult = { ...hit, indexId: 'remaining', conversationId: otherRoom, from: `${otherRoom}/Author`,
    body: 'Other room hit', source: 'mam', matchSnippet: { text: 'Other room hit', matchStart: 0, matchEnd: 5 } }
  mockSearch = baseSearch(new Map())
  mockSearch.results = [hit]
  mockSearch.mamResults = [remaining]
  await saveRoomMessages([confirmedHitMessage(hit)])
  const { container } = render(<SearchView />)
  fireEvent.keyDown(document.body, { key: 'ArrowDown' })
  if (selected === 'remaining') fireEvent.keyDown(document.body, { key: 'ArrowDown' })
  fireEvent.keyDown(document.body, { key: 'Enter' })
  expect(mockSearch.setPreviewResult).toHaveBeenLastCalledWith(selected === 'hidden' ? hit : remaining)
  mockSearch.setPreviewResult.mockClear()
  act(() => roomStore.setState({ pendingRetractions: new Map([[roomJid, [{
    targetId: hit.stanzaId!, actorJid: roomJid, retractedAt: Date.now(),
    moderation: { isModerated: true, moderationReason: 'Spam' },
  }]]]) }))
  await waitFor(() => expect(container.querySelector(`[data-search-result-id="${hit.indexId}"]`)).toBeNull())
  if (selected === 'hidden') {
    expect(mockSearch.setPreviewResult).toHaveBeenCalledExactlyOnceWith(null)
    await waitFor(() => expect(container.querySelector('[data-selected="true"]')).toBeNull())
    mockSearch.setPreviewResult.mockClear()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(mockSearch.setPreviewResult).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
  }
  await waitFor(() => expect(container.querySelector('[data-selected="true"]')).toHaveAttribute('data-search-result-id', remaining.indexId))
  fireEvent.keyDown(document.body, { key: 'Enter' })
  expect(mockSearch.setPreviewResult).toHaveBeenLastCalledWith(remaining)
  expect(container.textContent).toContain(remaining.body)
  await act(async () => {})
  expect(mockSearch.setPreviewResult).toHaveBeenCalledTimes(1)
})


it('keeps a legitimate colliding archive result selected when its sibling becomes Spam', async () => {
  const roomJid = 'collision@conference.example.com'
  const first: SearchResult = { ...RESULT, isRoom: true, conversationId: roomJid, from: `${roomJid}/Author`,
    occupantId: 'same-author', messageId: 'shared', stanzaId: 'archive-a', indexId: 'room-a', body: 'First result',
    matchSnippet: null, source: 'mam' }
  const second: SearchResult = { ...first, stanzaId: 'archive-b', indexId: 'room-b', body: 'Second result' }
  first.matchSnippet = { text: first.body, matchStart: 0, matchEnd: first.body.length }
  second.matchSnippet = { text: second.body, matchStart: 0, matchEnd: second.body.length }
  mockSearch = baseSearch(new Map())
  mockSearch.results = []
  mockSearch.mamResults = [first, second]
  mockSearch.previewResult = second
  roomStore.setState({ messages: new Map([[roomJid, [confirmedHitMessage(first), confirmedHitMessage(second)]]]), pendingRetractions: new Map() })
  const { container, getByText } = render(<SearchView />)
  expect(getByText(first.body)).toBeInTheDocument()
  expect(getByText(second.body)).toBeInTheDocument()
  act(() => roomStore.setState({ pendingRetractions: new Map([[roomJid, [{ targetId: first.stanzaId!, actorJid: roomJid,
    retractedAt: Date.now(), moderation: { isModerated: true, moderationReason: 'Spam' } }]]]) }))
  await waitFor(() => expect(container.textContent).not.toContain(first.body))
  expect(getByText(second.body)).toBeInTheDocument()
  expect(mockSearch.setPreviewResult).not.toHaveBeenCalledWith(null)
  fireEvent.click(getByText(second.body))
  expect(mockSearch.setPreviewResult).toHaveBeenCalledWith(expect.objectContaining({ stanzaId: second.stanzaId }))
})

it.each(['local', 'mam'] as const)('navigates from a %s result to the complete confirmed room reference', async source => {
  navigation.navigateToRoom.mockClear()
  const hit: SearchResult = { ...RESULT, indexId: 'confirmed-hit', isRoom: true, conversationId: 'room@example.com',
    from: 'room@example.com/Peer', occupantId: 'peer', stanzaId: 'shared-archive', source }
  const confirmed = confirmedHitMessage(hit)
  const legacy = { ...confirmed, stanzaId: 'earlier-archive', body: 'Uncertain earlier row', timestamp: new Date(1000) }
  await saveRoomMessages([legacy, confirmed])
  roomStore.setState({ messages: new Map([[hit.conversationId, [legacy, confirmed]]]), pendingRetractions: new Map() })
  mockSearch = { ...baseSearch(new Map()), results: source === 'local' ? [hit] : [], mamResults: source === 'mam' ? [hit] : [] }
  const { container } = render(<SearchView />)
  fireEvent.click(container.querySelector('[title="Go to message"]')!)
  expect(navigation.navigateToRoom).toHaveBeenCalledOnce()
  const [roomJid, handle] = navigation.navigateToRoom.mock.calls[0]
  expect(roomJid).toBe(hit.conversationId)
  expect(handle).toEqual(messageRowRef(confirmed))
  expect(findMessageRowIndex([legacy, confirmed], handle)).toBe(1)
})
