import { useRef, useEffect } from 'react'
import { TextInput } from '../ui/TextInput'
import { useTranslation } from 'react-i18next'
import { ChevronUp, ChevronDown, X } from 'lucide-react'

interface FindOnPageBarProps {
  searchText: string
  onSearchTextChange: (text: string) => void
  currentMatchIndex: number
  totalMatches: number
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

export function FindOnPageBar({
  searchText,
  onSearchTextChange,
  currentMatchIndex,
  totalMatches,
  onNext,
  onPrev,
  onClose,
}: FindOnPageBarProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        onPrev()
      } else {
        onNext()
      }
    }
  }

  const hasQuery = searchText.trim().length >= 2
  const matchLabel = hasQuery && totalMatches > 0
    ? `${currentMatchIndex + 1}/${totalMatches}`
    : hasQuery
      ? t('search.noResults', 'No matches')
      : ''

  return (
    <div className="absolute top-0 end-0 z-30 m-2">
      <div className="flex items-center gap-1 px-2 py-1.5 bg-fluux-bg border border-fluux-border rounded-lg shadow-lg">
        <TextInput
          ref={inputRef}
          type="text"
          value={searchText}
          onChange={(e) => onSearchTextChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('search.findInConversation', 'Find…')}
          className="w-40 px-1.5 py-0.5 text-sm bg-transparent border-none outline-none
                     text-fluux-text placeholder-fluux-muted"
        />
        {matchLabel && (
          <span className="text-xs text-fluux-muted whitespace-nowrap px-1">
            {matchLabel}
          </span>
        )}
        <button
          onClick={onPrev}
          disabled={totalMatches === 0}
          className="p-0.5 rounded hover:bg-fluux-hover text-fluux-muted disabled:opacity-30"
          title={t('search.previousMatch', 'Previous match (Shift+Enter)')}
        >
          <ChevronUp className="w-4 h-4" />
        </button>
        <button
          onClick={onNext}
          disabled={totalMatches === 0}
          className="p-0.5 rounded hover:bg-fluux-hover text-fluux-muted disabled:opacity-30"
          title={t('search.nextMatch', 'Next match (Enter)')}
        >
          <ChevronDown className="w-4 h-4" />
        </button>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-fluux-hover text-fluux-muted"
          title={t('common.close', 'Close (Esc)')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
