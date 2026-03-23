import { useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearch, generateConsistentColorHexSync } from '@fluux/sdk'
import type { SearchResult } from '@fluux/sdk'
import { Avatar } from '../Avatar'
import { useNavigateToTarget } from '@/hooks/useNavigateToTarget'
import { formatConversationTime } from '@/utils/dateFormat'
import { useSettingsStore, type TimeFormat } from '@/stores/settingsStore'
import { Search, X, Loader2, Hash } from 'lucide-react'

export function SearchView() {
  const { t, i18n } = useTranslation()
  const { query, results, isSearching, error, search, clearSearch } = useSearch()
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  const inputRef = useRef<HTMLInputElement>(null)
  const currentLang = i18n.language.split('-')[0]
  const timeFormat = useSettingsStore((s) => s.timeFormat)

  // Auto-focus search input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleResultClick = useCallback(
    (result: SearchResult) => {
      if (result.isRoom) {
        navigateToRoom(result.conversationId, result.messageId)
      } else {
        navigateToConversation(result.conversationId, result.messageId)
      }
    },
    [navigateToConversation, navigateToRoom]
  )

  return (
    <div className="flex flex-col h-full">
      {/* Search input */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-fluux-muted pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => search(e.target.value)}
            placeholder={t('search.placeholder', 'Search messages…')}
            className="w-full pl-8 pr-8 py-1.5 text-sm bg-fluux-input border border-fluux-border rounded-md
                       text-fluux-text placeholder-fluux-muted
                       focus:outline-none focus:ring-1 focus:ring-fluux-brand focus:border-fluux-brand"
          />
          {query && (
            <button
              onClick={clearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-fluux-hover text-fluux-muted"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Results area */}
      <div className="flex-1 overflow-y-auto px-1">
        {isSearching && (
          <div className="flex items-center justify-center gap-2 py-8 text-fluux-muted text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('search.searching', 'Searching…')}
          </div>
        )}

        {!isSearching && query && results.length === 0 && (
          <div className="text-center py-8 text-fluux-muted text-sm">
            {t('search.noResults', 'No messages found')}
          </div>
        )}

        {error && (
          <div className="text-center py-4 text-red-400 text-sm">{error}</div>
        )}

        {!isSearching && results.length > 0 && (
          <div className="space-y-0.5">
            {results.map((result) => (
              <SearchResultItem
                key={result.indexId}
                result={result}
                onClick={() => handleResultClick(result)}
                currentLang={currentLang}
                timeFormat={timeFormat}
                t={t}
              />
            ))}
          </div>
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
  onClick: () => void
  currentLang: string
  timeFormat: TimeFormat
  t: (key: string) => string
}

function SearchResultItem({ result, onClick, currentLang, timeFormat, t }: SearchResultItemProps) {
  const timestamp = new Date(result.timestamp)

  return (
    <button
      onClick={onClick}
      className="w-full px-2 py-1.5 rounded flex items-start gap-2.5 text-left cursor-pointer
                 transition-colors text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text"
    >
      {/* Avatar / icon */}
      <div className="flex-shrink-0 mt-0.5">
        {result.isRoom ? (
          <Hash
            className="w-7 h-7 p-1 rounded-full text-white"
            style={{
              backgroundColor: generateConsistentColorHexSync(result.conversationId, {
                saturation: 60,
                lightness: 45,
              }),
            }}
          />
        ) : (
          <Avatar
            identifier={result.conversationId}
            name={result.conversationName}
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
          <span className="text-xs text-fluux-muted flex-shrink-0">
            {formatConversationTime(timestamp, t, currentLang, timeFormat)}
          </span>
        </div>
        {result.matchSnippet && (
          <HighlightedSnippet snippet={result.matchSnippet} />
        )}
      </div>
    </button>
  )
}

function HighlightedSnippet({
  snippet,
}: {
  snippet: { text: string; matchStart: number; matchEnd: number }
}) {
  const before = snippet.text.slice(0, snippet.matchStart)
  const match = snippet.text.slice(snippet.matchStart, snippet.matchEnd)
  const after = snippet.text.slice(snippet.matchEnd)

  return (
    <p className="text-xs text-fluux-muted truncate mt-0.5">
      {before}
      <mark className="bg-fluux-brand/20 text-fluux-text rounded-sm px-0.5">
        {match}
      </mark>
      {after}
    </p>
  )
}
