import { useRef, useEffect, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearch, chatStore, roomStore, rosterStore, getLocalPart } from '@fluux/sdk'
import type { SearchResult, SearchResultContext, SearchFilterType } from '@fluux/sdk'
import { Avatar } from '../Avatar'
import { useNavigateToTarget } from '@/hooks/useNavigateToTarget'
import { useListKeyboardNav } from '@/hooks'
import { formatConversationTime } from '@/utils/dateFormat'
import { useSettingsStore, type TimeFormat } from '@/stores/settingsStore'
import { useSidebarZone } from './types'
import { Search, X, Loader2, ExternalLink, Cloud, Users, MessageSquare, Hash } from 'lucide-react'
import { TextInput } from '../ui/TextInput'

function getConversationName(conversationId: string): string {
  const room = roomStore.getState().rooms.get(conversationId)
  if (room) return room.name || conversationId
  const entity = chatStore.getState().conversationEntities.get(conversationId)
  return entity?.name || conversationId
}

export function SearchView() {
  const { t, i18n } = useTranslation()
  const {
    query, results, isSearching, error, search, clearSearch, previewResult, setPreviewResult,
    isSearchingMAM, mamResults, hasMoreMAMResults, mamError, searchScope,
    searchMAM, loadMoreMAMResults, setSearchScope, resultContext,
    searchFilter, setSearchFilter,
    inPrefixSuggestions, isInPrefixActive, selectInPrefixSuggestion,
  } = useSearch()
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [inPrefixHighlight, setInPrefixHighlight] = useState(-1)
  const currentLang = i18n.language.split('-')[0]
  const timeFormat = useSettingsStore((s) => s.timeFormat)
  const zoneRef = useSidebarZone()

  // Auto-focus search input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSelect = useCallback(
    (result: SearchResult) => {
      setPreviewResult(result)
    },
    [setPreviewResult]
  )

  const allResults = [...results, ...mamResults]

  const { selectedIndex, isKeyboardNav, getItemProps, getItemAttribute, getContainerProps } = useListKeyboardNav({
    items: allResults,
    onSelect: handleSelect,
    listRef,
    searchInputRef: inputRef,
    getItemId: (result) => result.indexId,
    itemAttribute: 'data-search-result-id',
    zoneRef,
    activateOnAltNav: true,
  })

  const handleGoToMessage = useCallback(
    (e: React.MouseEvent, result: SearchResult) => {
      e.stopPropagation()
      setPreviewResult(null)
      if (result.isRoom) {
        navigateToRoom(result.conversationId, result.messageId)
      } else {
        navigateToConversation(result.conversationId, result.messageId)
      }
    },
    [navigateToConversation, navigateToRoom, setPreviewResult]
  )

  // Reset highlight when suggestions change
  useEffect(() => {
    setInPrefixHighlight(-1)
  }, [inPrefixSuggestions])

  const handleInPrefixKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isInPrefixActive || inPrefixSuggestions.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setInPrefixHighlight((prev) => Math.min(prev + 1, inPrefixSuggestions.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setInPrefixHighlight((prev) => Math.max(prev - 1, -1))
      } else if (e.key === 'Enter' && inPrefixHighlight >= 0) {
        e.preventDefault()
        selectInPrefixSuggestion(inPrefixSuggestions[inPrefixHighlight])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        clearSearch()
      }
    },
    [isInPrefixActive, inPrefixSuggestions, inPrefixHighlight, selectInPrefixSuggestion, clearSearch]
  )

  const filterOptions: { key: SearchFilterType; label: string; icon: typeof Users }[] = [
    { key: 'all', label: t('search.filter.all', 'All'), icon: Search },
    { key: 'conversations', label: t('search.filter.conversations', 'Chats'), icon: MessageSquare },
    { key: 'rooms', label: t('search.filter.rooms', 'Rooms'), icon: Hash },
  ]

  return (
    <div className="flex flex-col h-full">
      {/* Search input */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-fluux-muted pointer-events-none" />
          <TextInput
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => search(e.target.value)}
            onKeyDown={handleInPrefixKeyDown}
            placeholder={t('search.placeholder', 'Search messages…')}
            className="w-full ps-8 pe-8 py-1.5 text-sm bg-fluux-input border border-fluux-border rounded-md
                       text-fluux-text placeholder-fluux-muted
                       focus:outline-none focus:ring-1 focus:ring-fluux-brand focus:border-fluux-brand"
          />
          {query && (
            <button
              onClick={clearSearch}
              className="absolute end-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-fluux-hover text-fluux-muted"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          {/* in: prefix autocomplete dropdown */}
          {isInPrefixActive && inPrefixSuggestions.length > 0 && (
            <div className="absolute inset-x-0 top-full mt-1 bg-fluux-surface border border-fluux-border rounded-md shadow-lg z-50 max-h-48 overflow-y-auto">
              {inPrefixSuggestions.map((s, i) => (
                <button
                  key={s.id}
                  onClick={() => selectInPrefixSuggestion(s)}
                  className={`w-full px-3 py-1.5 text-start text-sm flex items-center gap-2 transition-colors
                    ${i === inPrefixHighlight ? 'bg-fluux-hover text-fluux-text' : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text'}`}
                >
                  <Avatar identifier={s.id} name={s.name} size="xs" />
                  <span className="truncate flex-1">{s.name}</span>
                  {s.isRoom ? (
                    <Hash className="w-3 h-3 text-fluux-muted flex-shrink-0" />
                  ) : (
                    <MessageSquare className="w-3 h-3 text-fluux-muted flex-shrink-0" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Scope chip */}
      {searchScope && (
        <div className="flex items-center gap-1 px-3 pb-1">
          <span className="text-xs bg-fluux-hover rounded px-2 py-0.5 text-fluux-muted truncate">
            {t('search.scopeLabel', 'Searching in')} {getConversationName(searchScope)}
          </span>
          <button
            onClick={() => setSearchScope(null)}
            className="p-0.5 rounded hover:bg-fluux-hover text-fluux-muted flex-shrink-0"
            title={t('search.clearScope', 'Search all conversations')}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Type filter pills */}
      {query && !isInPrefixActive && (
        <div className="flex items-center gap-1 px-3 pb-1">
          {filterOptions.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setSearchFilter(key)}
              className={`text-xs rounded-full px-2.5 py-0.5 transition-colors flex items-center gap-1 ${
                searchFilter === key
                  ? 'bg-fluux-brand text-fluux-text-on-accent'
                  : 'bg-fluux-hover text-fluux-muted hover:text-fluux-text'
              }`}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Results area */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-1" {...getContainerProps()}>
        {isSearching && (
          <div className="flex items-center justify-center gap-2 py-8 text-fluux-muted text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('search.searching', 'Searching…')}
          </div>
        )}

        {!isSearching && !isInPrefixActive && query && results.length === 0 && mamResults.length === 0 && !isSearchingMAM && (
          <div className="text-center py-8 text-fluux-muted text-sm">
            {t('search.noResults', 'No messages found')}
          </div>
        )}

        {error && (
          <div className="text-center py-4 text-red-400 text-sm">{error}</div>
        )}

        {/* Local results */}
        {!isSearching && results.length > 0 && (
          <div className="space-y-0.5">
            {results.map((result, index) => (
              <SearchResultItem
                key={result.indexId}
                result={result}
                context={resultContext.get(result.indexId)}
                isActive={previewResult?.indexId === result.indexId}
                isSelected={selectedIndex === index}
                isKeyboardNav={isKeyboardNav}
                onClick={() => handleSelect(result)}
                onGoToMessage={(e) => handleGoToMessage(e, result)}
                itemProps={getItemProps(index)}
                itemAttribute={getItemAttribute(index)}
                currentLang={currentLang}
                timeFormat={timeFormat}
                t={t}
              />
            ))}
          </div>
        )}

        {/* MAM search button */}
        {!isSearching && !isInPrefixActive && query && !isSearchingMAM && mamResults.length === 0 && (
          <div className="px-2 py-3">
            <button
              onClick={searchMAM}
              className="w-full flex items-center justify-center gap-2 py-2 text-sm text-fluux-muted
                         hover:text-fluux-text hover:bg-fluux-hover rounded-md transition-colors"
            >
              <Cloud className="w-4 h-4" />
              {t('search.searchServer', 'Search server archive')}
            </button>
          </div>
        )}

        {/* MAM search loading */}
        {isSearchingMAM && (
          <div className="flex items-center justify-center gap-2 py-4 text-fluux-muted text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('search.searchingServer', 'Searching server archive…')}
          </div>
        )}

        {/* MAM results */}
        {mamResults.length > 0 && (
          <div className="space-y-0.5">
            <div className="px-2 pt-2 pb-1">
              <span className="text-xs text-fluux-muted font-medium flex items-center gap-1">
                <Cloud className="w-3 h-3" />
                {t('search.serverResults', 'Server archive')}
              </span>
            </div>
            {mamResults.map((result, i) => {
              const globalIndex = results.length + i
              return (
                <SearchResultItem
                  key={result.indexId}
                  result={result}
                  context={resultContext.get(result.indexId)}
                  isActive={previewResult?.indexId === result.indexId}
                  isSelected={selectedIndex === globalIndex}
                  isKeyboardNav={isKeyboardNav}
                  onClick={() => handleSelect(result)}
                  onGoToMessage={(e) => handleGoToMessage(e, result)}
                  itemProps={getItemProps(globalIndex)}
                  itemAttribute={getItemAttribute(globalIndex)}
                  currentLang={currentLang}
                  timeFormat={timeFormat}
                  t={t}
                />
              )
            })}
          </div>
        )}

        {/* Load more MAM results */}
        {hasMoreMAMResults && !isSearchingMAM && (
          <div className="px-2 py-2">
            <button
              onClick={loadMoreMAMResults}
              className="w-full flex items-center justify-center gap-2 py-1.5 text-xs text-fluux-muted
                         hover:text-fluux-text hover:bg-fluux-hover rounded-md transition-colors"
            >
              {t('search.loadMore', 'Load more from server')}
            </button>
          </div>
        )}

        {/* MAM error */}
        {mamError && (
          <div className="text-center py-2 px-3 text-fluux-muted text-xs">{mamError}</div>
        )}

        {!query && (
          <div className="text-center py-8 text-fluux-muted text-sm">
            {t('search.hint', 'Type to search across all messages')}
          </div>
        )}
      </div>
    </div>
  )
}

interface SearchResultItemProps {
  result: SearchResult
  context?: SearchResultContext
  isActive: boolean
  isSelected: boolean
  isKeyboardNav: boolean
  onClick: () => void
  onGoToMessage: (e: React.MouseEvent) => void
  itemProps: ReturnType<ReturnType<typeof useListKeyboardNav>['getItemProps']>
  itemAttribute: Record<string, string>
  currentLang: string
  timeFormat: TimeFormat
  t: (key: string) => string
}

function SearchResultItem({ result, context, isActive, isSelected, isKeyboardNav, onClick, onGoToMessage, itemProps, itemAttribute, currentLang, timeFormat, t }: SearchResultItemProps) {
  const timestamp = new Date(result.timestamp)

  const highlighted = isActive || isSelected

  return (
    <button
      {...itemAttribute}
      {...itemProps}
      onClick={onClick}
      className={`w-full px-2 py-1.5 rounded flex items-start gap-2.5 text-start cursor-pointer
                 transition-colors group/result ${
                   highlighted
                     ? 'bg-fluux-hover text-fluux-text'
                     : isKeyboardNav
                       ? 'text-fluux-muted'
                       : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text'
                 }`}
    >
      {/* Avatar / icon */}
      <div className="flex-shrink-0 mt-0.5">
        {result.isRoom ? (
          (() => {
            const roomAvatar = roomStore.getState().rooms.get(result.conversationId)?.avatar
            return roomAvatar ? (
              <img
                src={roomAvatar}
                alt={result.conversationName}
                className="w-6 h-6 rounded-full object-cover"
                draggable={false}
              />
            ) : (
              <Avatar
                identifier={result.conversationId}
                name={result.conversationName}
                size="xs"
              />
            )
          })()
        ) : (
          <Avatar
            identifier={result.conversationId}
            name={result.conversationName}
            avatarUrl={rosterStore.getState().contacts.get(result.conversationId)?.avatar}
            size="xs"
          />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-fluux-text truncate">
            {result.conversationName}
          </span>
          <div className="flex items-center gap-1 flex-shrink-0">
            {result.source === 'mam' && (
              <Cloud className="w-3 h-3 text-fluux-muted" />
            )}
            <span className="text-xs text-fluux-muted">
              {formatConversationTime(timestamp, t, currentLang, timeFormat)}
            </span>
            <button
              onClick={onGoToMessage}
              className="p-0.5 rounded opacity-0 group-hover/result:opacity-100 transition-opacity hover:bg-fluux-hover-strong"
              title="Go to message"
            >
              <ExternalLink className="w-3 h-3 text-fluux-muted" />
            </button>
          </div>
        </div>
        {/* Context before */}
        {context?.before.map((msg, i) => (
          <ContextLine key={`before-${i}`} body={msg.body} nick={msg.nick} from={msg.from} isRoom={result.isRoom} />
        ))}
        {/* Match snippet */}
        {result.matchSnippet && (
          <HighlightedSnippet snippet={result.matchSnippet} nick={result.isRoom ? result.nick : undefined} />
        )}
        {/* Context after */}
        {context?.after.map((msg, i) => (
          <ContextLine key={`after-${i}`} body={msg.body} nick={msg.nick} from={msg.from} isRoom={result.isRoom} />
        ))}
      </div>
    </button>
  )
}

function ContextLine({
  body,
  nick,
  from,
  isRoom,
}: {
  body: string
  nick?: string
  from: string
  isRoom: boolean
}) {
  if (!body) return null
  const senderName = isRoom ? nick : getLocalPart(from)
  const truncated = body.length > 80 ? body.slice(0, 80) + '…' : body
  return (
    <p className="text-xs text-fluux-muted/60 line-clamp-1 mt-0.5">
      {senderName && <span className="font-medium">{senderName}: </span>}
      {truncated}
    </p>
  )
}

function HighlightedSnippet({
  snippet,
  nick,
}: {
  snippet: { text: string; matchStart: number; matchEnd: number }
  nick?: string
}) {
  const before = snippet.text.slice(0, snippet.matchStart)
  const match = snippet.text.slice(snippet.matchStart, snippet.matchEnd)
  const after = snippet.text.slice(snippet.matchEnd)

  return (
    <p className="text-xs text-fluux-muted line-clamp-1 mt-0.5">
      {nick && <span className="font-medium text-fluux-text">{nick}: </span>}
      {before}
      <mark className="search-match px-0.5">
        {match}
      </mark>
      {after}
    </p>
  )
}
