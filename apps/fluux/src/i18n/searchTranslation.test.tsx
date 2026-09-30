import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { useSearch, type SearchResult } from '@fluux/sdk'
import { getMessages } from '@fluux/sdk/cache'
import { Sidebar } from '@/components/Sidebar'
import { SearchView } from '@/components/sidebar-components/SearchView'
import { SearchContextView } from '@/components/SearchContextView'
import en from './locales/en.json'
import fr from './locales/fr.json'

vi.unmock('@fluux/sdk/react')

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@fluux/sdk')>(),
  useSearch: vi.fn(),
  useXMPP: () => ({ client: { disconnect: vi.fn() } }),
  useRoomActions: () => ({ markAllRoomsRead: vi.fn() }),
}))

vi.mock('@fluux/sdk/cache', async (importOriginal) => ({
  ...await importOriginal<typeof import('@fluux/sdk/cache')>(),
  getMessages: vi.fn(),
}))

vi.mock('@/hooks', async () => ({
  ...await import('@/hooks/useListKeyboardNav'),
  ...await import('@/hooks/useTimeFormat'),
  useWindowDrag: () => ({ dragRegionProps: {} }),
  useMode: () => ({ resolvedMode: 'dark' }),
  useRouteSync: () => ({ sidebarView: 'search' }),
  useFollowUnarchivedActive: vi.fn(),
}))

const navigation = vi.hoisted(() => ({ navigateToConversation: vi.fn(), navigateToRoom: vi.fn() }))
vi.mock('@/hooks/useNavigateToTarget', () => ({ useNavigateToTarget: () => navigation }))

vi.mock('@/components/sidebar-components', async () => ({
  ...await import('@/components/sidebar-components/types'),
  ...await import('@/components/sidebar-components/IconRailNavLink'),
  ...await import('@/components/sidebar-components/SearchView'),
  IconRailButton: () => null,
  ConversationList: () => null,
  ArchiveList: () => null,
  ContactList: () => null,
  RoomsList: () => null,
  MessagesHeaderActions: () => null,
  ContactsHeaderActions: () => null,
  RoomsHeaderActions: () => null,
  StatusOrPresence: () => null,
  UserMenu: () => null,
}))
vi.mock('@/components/AdminDashboard', () => ({ AdminDashboard: () => null }))
vi.mock('@/components/BrowseRoomsModal', () => ({ BrowseRoomsModal: () => null }))
vi.mock('@/components/JoinRoomModal', () => ({ JoinRoomModal: () => null }))
vi.mock('@/components/AddContactModal', () => ({ AddContactModal: () => null }))
vi.mock('@/components/CreateRoomModal', () => ({ CreateRoomModal: () => null }))
vi.mock('@/components/CreateQuickChatModal', () => ({ CreateQuickChatModal: () => null }))
vi.mock('@/components/NewMessageModal', () => ({ NewMessageModal: () => null }))
vi.mock('@/components/settings-components', () => ({ SettingsSidebar: () => null, DEFAULT_SETTINGS_CATEGORY: 'profile' }))
vi.mock('@/components/Avatar', () => ({ Avatar: () => null }))
vi.mock('@/utils/performLogout', () => ({ performLogout: vi.fn() }))
vi.mock('@/components/conversation', () => ({
  MessageList: ({ isLoading, loadingState }: { isLoading?: boolean; loadingState?: ReactNode }) =>
    isLoading ? <>{loadingState}</> : null,
  MessageBubble: () => null,
  shouldShowAvatar: vi.fn(),
  buildReplyContext: vi.fn(),
}))

let testI18n: ReturnType<typeof createInstance>
let searchState: ReturnType<typeof useSearch>

const result: SearchResult = {
  indexId: 'local-hit',
  messageId: 'message-1',
  conversationId: 'alice@example.com',
  conversationName: 'Alice',
  from: 'alice@example.com',
  body: 'Bonjour Alice',
  timestamp: 1700000000000,
  isRoom: false,
  source: 'local',
  matchSnippet: { text: 'Bonjour Alice', matchStart: 0, matchEnd: 7 },
}

beforeEach(async () => {
  vi.clearAllMocks()
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    resources: { en: { translation: en }, fr: { translation: fr } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
  searchState = {
    query: '', results: [], isSearching: false, error: null,
    search: vi.fn(), clearSearch: vi.fn(), previewResult: null, setPreviewResult: vi.fn(),
    isSearchingMAM: false, mamResults: [], hasMoreMAMResults: false, mamError: null,
    searchScope: null, searchMAM: vi.fn(), loadMoreMAMResults: vi.fn(), setSearchScope: vi.fn(),
    resultContext: new Map(), searchFilter: 'all', setSearchFilter: vi.fn(),
    inPrefixSuggestions: [], isInPrefixActive: false, selectInPrefixSuggestion: vi.fn(),
  }
  vi.mocked(useSearch).mockImplementation(() => searchState)
  vi.mocked(getMessages).mockResolvedValue([])
})

function renderTranslated(children: ReactNode) {
  return render(
    <I18nextProvider i18n={testI18n}>
      <MemoryRouter initialEntries={['/search']}>{children}</MemoryRouter>
    </I18nextProvider>,
  )
}

async function changeLanguage(language: string) {
  await act(async () => { await testI18n.changeLanguage(language) })
}

describe('search tab translation', () => {
  it('updates the sidebar title, navigation, input and hint without remounting', async () => {
    renderTranslated(<Sidebar onViewChange={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Search' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Search' })).toBeVisible()
    const input = screen.getByPlaceholderText('Search messages…')
    expect(screen.getByText('Type to search across all messages')).toBeVisible()

    await changeLanguage('fr')
    expect(screen.getByRole('heading', { name: 'Recherche' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Recherche' })).toBeVisible()
    expect(screen.getByPlaceholderText('Rechercher des messages…')).toBe(input)
    expect(screen.getByText('Saisissez du texte pour rechercher dans tous les messages')).toBeVisible()

    await changeLanguage('en')
    expect(input).toHaveAttribute('placeholder', 'Search messages…')
    expect(screen.getByRole('heading', { name: 'Search' })).toBeVisible()
  })

  it('translates filters, scope interpolation and search controls', async () => {
    searchState.query = 'bonjour'
    searchState.searchScope = 'support@example.com'
    renderTranslated(<SearchView />)
    expect(screen.getByText('Searching in support@example.com')).toBeVisible()
    for (const name of ['All', 'Chats', 'Rooms', 'Search all conversations', 'Search server archive']) {
      expect(screen.getByRole('button', { name })).toBeVisible()
    }

    await changeLanguage('fr')
    expect(screen.getByText('Recherche dans support@example.com')).toBeVisible()
    for (const name of ['Tout', 'Discussions', 'Salons', 'Rechercher dans toutes les conversations', "Rechercher dans l'archive du serveur"]) {
      expect(screen.getByRole('button', { name })).toBeVisible()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Salons' }))
    expect(searchState.setSearchFilter).toHaveBeenCalledWith('rooms')
    fireEvent.click(screen.getByRole('button', { name: 'Rechercher dans toutes les conversations' }))
    expect(searchState.setSearchScope).toHaveBeenCalledWith(null)
    fireEvent.click(screen.getByRole('button', { name: "Rechercher dans l'archive du serveur" }))
    expect(searchState.searchMAM).toHaveBeenCalledOnce()
  })

  it.each([
    { state: {}, english: 'No messages found', french: 'Aucun message trouvé' },
    { state: { isSearching: true }, english: 'Searching…', french: 'Recherche en cours…' },
    { state: { isSearchingMAM: true }, english: 'Searching server archive…', french: "Recherche dans l'archive du serveur…" },
  ])('updates the $english state when the language changes', async ({ state, english, french }) => {
    Object.assign(searchState, { query: 'bonjour' }, state)
    renderTranslated(<SearchView />)
    expect(screen.getByText(english)).toBeVisible()
    await changeLanguage('fr')
    expect(screen.getByText(french)).toBeVisible()
    expect(screen.queryByText(english)).not.toBeInTheDocument()
  })

  it('translates both result actions and archive pagination without translating message content', async () => {
    Object.assign(searchState, {
      query: 'bonjour', results: [result],
      mamResults: [{ ...result, indexId: 'archive-hit', source: 'mam' }], hasMoreMAMResults: true,
    })
    renderTranslated(<SearchView />)
    expect(screen.getAllByTitle('Go to message')).toHaveLength(2)
    expect(screen.getByText('Server archive')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Load more from server' })).toBeVisible()

    await changeLanguage('fr')
    expect(screen.getAllByTitle('Aller au message')).toHaveLength(2)
    expect(screen.getByText('Archive du serveur')).toBeVisible()
    expect(screen.getAllByText('Alice', { selector: 'span' })).toHaveLength(2)
    expect(screen.getAllByText('Bonjour', { selector: 'mark' })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Charger plus depuis le serveur' }))
    expect(searchState.loadMoreMAMResults).toHaveBeenCalledOnce()
    fireEvent.click(screen.getAllByTitle('Aller au message')[0])
    expect(navigation.navigateToConversation).toHaveBeenCalledWith(result.conversationId, result.messageId)
  })

  describe.each(['error', 'mamError'] as const)('%s presentation', field => {
    it.each([
      ['Search failed', 'Search failed', 'Échec de la recherche'],
      ['Server does not support archive search for rooms', 'Server does not support archive search for rooms', "Le serveur ne prend pas en charge la recherche dans l'archive des salons"],
      ['Server does not support archive search. Try searching within a conversation.', 'Server does not support archive search. Try searching within a conversation.', "Le serveur ne prend pas en charge la recherche dans l'archive. Essayez de rechercher dans une conversation."],
      ['Server search failed', 'Server search failed', 'Échec de la recherche sur le serveur'],
      ['Not connected', 'Search failed', 'Échec de la recherche'],
      ['IndexedDB unavailable', 'Search failed', 'Échec de la recherche'],
      ['toString', 'Search failed', 'Échec de la recherche'],
    ])('localizes %s, including failures without a dedicated translation', async (message, english, french) => {
      searchState.query = 'bonjour'
      searchState[field] = message
      renderTranslated(<SearchView />)
      expect(screen.getByText(english)).toBeVisible()
      await changeLanguage('fr')
      expect(screen.getByText(french)).toBeVisible()
      expect(screen.queryByText(message)).not.toBeInTheDocument()
    })
  })

  it('updates the preview header, loading state and navigation action', async () => {
    searchState.previewResult = result
    let finishLoading!: (messages: Awaited<ReturnType<typeof getMessages>>) => void
    vi.mocked(getMessages).mockReturnValue(new Promise(resolve => { finishLoading = resolve }))
    renderTranslated(<SearchContextView />)
    expect(screen.getByText('Search result')).toBeVisible()
    expect(screen.getByText('Loading messages…')).toBeVisible()
    expect(screen.getByText('You are viewing a search result preview')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Go to message' })).toBeVisible()

    await changeLanguage('fr')
    expect(screen.getByText('Résultat de recherche')).toBeVisible()
    expect(screen.getByText('Chargement des messages…')).toBeVisible()
    expect(screen.getByText("Vous consultez un aperçu d'un résultat de recherche")).toBeVisible()
    const goToMessage = screen.getByRole('button', { name: 'Aller au message' })
    expect(goToMessage).toBeVisible()
    await act(async () => { finishLoading([]) })
    await waitFor(() => expect(screen.queryByText('Chargement des messages…')).not.toBeInTheDocument())
    fireEvent.click(goToMessage)
    expect(searchState.setPreviewResult).toHaveBeenCalledWith(null)
    expect(navigation.navigateToConversation).toHaveBeenCalledWith(result.conversationId, result.messageId)
  })
})
