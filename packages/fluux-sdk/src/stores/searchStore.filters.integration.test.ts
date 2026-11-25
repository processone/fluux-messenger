import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { Message } from '../core/types'
import type { XMPPClient } from '../core/XMPPClient'
import { setStorageScopeJid } from '../utils/storageScope'
import * as cache from '../utils/messageCache'
import * as index from '../utils/searchIndex'
import { seedVersion5SearchHistory } from '../utils/fixtures/searchHistory'
import { connectionStore } from './connectionStore'
import { chatStore } from './chatStore'
import { searchStore, senderFilterTokens, setSearchClient } from './searchStore'
import { filterToken, roomSenderValue } from '../utils/searchFilters'

const scope = 'search@example.test'
const photo: Message = { type: 'chat', id: 'photo', originId: undefined, stanzaId: 'photo-archive', conversationId: 'alice@example.test',
  from: 'alice@example.test', body: 'https://upload.example.test/design.png', timestamp: new Date('2024-03-31T01:30:00Z'),
  isOutgoing: false, attachment: { url: 'https://upload.example.test/design.png', mediaType: 'image/png' } }

function waitForState(predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve()
  return new Promise(resolve => {
    const unsubscribe = searchStore.subscribe(() => {
      if (predicate()) { unsubscribe(); resolve() }
    })
  })
}

describe('filter store with the persisted index', () => {
  let writes: Promise<void>[]
  beforeEach(() => {
    writes = []
    const write = index.indexMessages
    vi.spyOn(index, 'indexMessages').mockImplementation((...args) => {
      const pending = write(...args)
      writes.push(pending)
      return pending
    })
    globalThis.indexedDB = new IDBFactory()
    index._resetDBForTesting()
    cache._resetDBForTesting()
    setStorageScopeJid(scope)
    searchStore.getState().clearSearch()
    searchStore.getState().setSearchScope(null)
    chatStore.setState({ messages: new Map(), pendingRetractions: new Map() })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(async () => {
    searchStore.getState().clearSearch()
    setSearchClient(null)
    for (const pending of writes) await pending
    await index.closeSearchIndex()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reruns the active filtered query when background preparation completes', async () => {
    await seedVersion5SearchHistory(scope, [photo])
    await cache.saveMessages('chat', [photo])
    searchStore.getState().search('has:image')
    await vi.advanceTimersByTimeAsync(300)
    await waitForState(() => searchStore.getState().filtersBuilding)
    const finished = waitForState(() => !searchStore.getState().filtersBuilding)
    vi.useRealTimers()
    await index.migrateSearchFilters()
    await finished
    expect(searchStore.getState().results.map(row => row.messageId)).toEqual(['photo'])
    expect(searchStore.getState().query).toBe('has:image')
  })

  it('indexes the archive message attachment instead of losing it in the display projection', async () => {
    await index.initSearchIndex(scope)
    const write = vi.spyOn(index, 'indexMessages')
    const client = { messages: { searchMessages: vi.fn().mockResolvedValue({ messages: [photo], complete: true, page: {} }) } }
    setSearchClient(client as unknown as XMPPClient)
    connectionStore.getState().setMAMFulltextSearch(true)
    searchStore.setState({ query: 'has:image image' })
    searchStore.getState().searchMAM()
    await waitForState(() => !searchStore.getState().isSearchingMAM)
    expect(write).toHaveBeenCalledTimes(1)
    await write.mock.results[0].value
    expect((await index.search('', { filterGroups: [[filterToken.has('image')]] })).map(row => row.messageId)).toEqual(['photo'])
    expect((await index.search('', { filterGroups: [[filterToken.has('link')]] })).map(row => row.messageId)).toEqual([])
  })

  it('rejects inverted dates before making any archive request', async () => {
    const request = vi.fn()
    setSearchClient({ messages: { searchMessages: request } } as unknown as XMPPClient)
    connectionStore.getState().setMAMFulltextSearch(true)
    searchStore.setState({ query: 'timetable after:2026-08-02 before:2026-08-01' })
    searchStore.getState().searchMAM()
    expect(searchStore.getState().mamError).toBe('Invalid search filters')
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps a picked Images filter active without placing syntax in the query', async () => {
    await index.initSearchIndex(scope)
    await index.indexMessages([photo])
    searchStore.getState().setPickedFilters(['has:image'])
    await vi.advanceTimersByTimeAsync(300)
    await waitForState(() => !searchStore.getState().isSearching)
    expect(searchStore.getState().query).toBe('')
    expect(searchStore.getState().results.map(row => row.messageId)).toEqual(['photo'])
  })

  it('does not match a nickname reused by another stable occupant', async () => {
    await index.initSearchIndex(scope)
    const room = 'team@conference.example.test'
    await index.indexMessages([
      { ...photo, type: 'groupchat', roomJid: room, nick: 'Bob', occupantId: 'departed', from: `${room}/Bob` },
      { ...photo, type: 'groupchat', roomJid: room, id: 'current', stanzaId: 'current-archive', nick: 'Bob', occupantId: 'current', from: `${room}/Bob` },
      { ...photo, type: 'groupchat', roomJid: room, id: 'renamed', stanzaId: 'renamed-archive', nick: 'Robert', occupantId: 'current', from: `${room}/Robert` },
      { ...photo, type: 'groupchat', roomJid: 'other@conference.example.test', id: 'other-room', stanzaId: 'other-archive', nick: 'Bob', occupantId: 'current', from: 'other@conference.example.test/Bob' },
    ])
    const groups = [senderFilterTokens(roomSenderValue(room, 'current', 'Bob'), null)]
    expect((await index.search('', { filterGroups: groups })).map(row => row.messageId)).toEqual(['current', 'renamed'])
    expect(senderFilterTokens('unknown person', null)).not.toEqual([])
  })
  it('keeps Load more after an empty filtered page and resumes its older cursor', async () => {
    await index.initSearchIndex(scope)
    const request = vi.fn()
      .mockResolvedValueOnce({ messages: [], complete: false, page: { first: 'older-page' } })
      .mockResolvedValueOnce({ messages: [photo], complete: true, page: { first: 'archive-start' } })
    setSearchClient({ messages: { searchConversationHistory: request } } as unknown as XMPPClient)
    connectionStore.getState().setMAMFulltextSearch(false)
    searchStore.setState({ query: 'has:image on:2024-03', searchScope: photo.conversationId })
    searchStore.getState().searchMAM()
    await waitForState(() => !searchStore.getState().isSearchingMAM)
    expect(searchStore.getState().mamResults).toEqual([])
    expect(searchStore.getState().hasMoreMAMResults).toBe(true)
    expect(searchStore.getState().mamSearched).toBe(true)
    searchStore.getState().loadMoreMAMResults()
    await waitForState(() => !searchStore.getState().isSearchingMAM)
    expect(searchStore.getState().mamResults.map(row => row.messageId)).toEqual(['photo'])
    expect(searchStore.getState().hasMoreMAMResults).toBe(false)
    const initial = request.mock.calls[0][0]
    expect(initial).toMatchObject({ maxPages: 20, maxResults: 100 })
    expect(request.mock.calls[1][0]).toMatchObject({ before: 'older-page', maxPages: 20, start: initial.start, end: initial.end })
  })

  it('cancels archive loading when the reader begins another scope prefix', async () => {
    let finish!: (value: { messages: Message[]; complete: boolean; page: { first: string } }) => void
    const response = new Promise<{ messages: Message[]; complete: boolean; page: { first: string } }>(resolve => { finish = resolve })
    const request = vi.fn().mockReturnValue(response)
    setSearchClient({ messages: { searchConversationHistory: request } } as unknown as XMPPClient)
    connectionStore.getState().setMAMFulltextSearch(false)
    searchStore.setState({ query: 'has:image', searchScope: photo.conversationId })
    searchStore.getState().searchMAM()
    expect(searchStore.getState().isSearchingMAM).toBe(true)
    searchStore.getState().search('in:alice')
    expect(request.mock.calls[0][1].aborted).toBe(true)
    expect(searchStore.getState().isSearchingMAM).toBe(false)
    finish({ messages: [], complete: false, page: { first: 'stale' } })
    await vi.runAllTimersAsync()
    expect(searchStore.getState()).toMatchObject({ query: 'in:alice', isInPrefixActive: true, hasMoreMAMResults: false, isSearchingMAM: false, mamResults: [] })
  })

  it('drops the prior account’s scope and picked filters when the account changes', () => {
    connectionStore.getState().setJid(scope)
    searchStore.setState({ query: 'design', searchScope: photo.conversationId, pickedFilters: ['has:image'] })
    connectionStore.getState().setJid('next@example.test')
    expect(searchStore.getState()).toMatchObject({ query: '', searchScope: null, pickedFilters: [], results: [], mamResults: [] })
  })

  it('warns about unknown content only when content conditions are used', async () => {
    await seedVersion5SearchHistory(scope, [photo])
    vi.useRealTimers()
    await index.migrateSearchFilters()
    expect(await index.getFilterIndexState()).toEqual({ status: 'incomplete' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    searchStore.getState().search(`from:${photo.from}`)
    await vi.advanceTimersByTimeAsync(300)
    await waitForState(() => !searchStore.getState().isSearching)
    expect(searchStore.getState().results.map(row => row.messageId)).toEqual(['photo'])
    expect(searchStore.getState().filtersIncomplete).toBe(false)
    searchStore.getState().search('has:image')
    await vi.advanceTimersByTimeAsync(300)
    await waitForState(() => !searchStore.getState().isSearching)
    expect(searchStore.getState().filtersIncomplete).toBe(true)
  })

  it('keeps picked conditions active when a typed scope is selected', async () => {
    await index.initSearchIndex(scope)
    await index.indexMessages([photo])
    chatStore.setState({ conversationEntities: new Map([[photo.conversationId, { id: photo.conversationId, name: 'Alice', type: 'chat' as const }]]) })
    searchStore.getState().setPickedFilters(['has:image'])
    searchStore.getState().search('in:alice')
    const suggestion = searchStore.getState().inPrefixSuggestions[0]
    expect(suggestion.id).toBe(photo.conversationId)
    searchStore.getState().selectInPrefixSuggestion(suggestion)
    await waitForState(() => !searchStore.getState().isSearching)
    expect(searchStore.getState().query).toBe('')
    expect(searchStore.getState().pickedFilters).toEqual(['has:image'])
    expect(searchStore.getState().results.map(row => row.messageId)).toEqual(['photo'])
  })

})
