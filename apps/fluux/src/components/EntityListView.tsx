import { useRef, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Loader2 } from 'lucide-react'
import { TextInput } from './ui/TextInput'

interface EntityListViewProps<T> {
  title: string
  items: T[]
  isLoading: boolean
  hasMore: boolean
  searchValue: string
  totalCount?: number
  onSearchChange: (value: string) => void
  onLoadMore: () => void
  renderItem: (item: T, index: number) => ReactNode
  emptyMessage: string
  keyExtractor: (item: T) => string
  /** Optional action button (e.g., "Add User") */
  headerAction?: ReactNode
}

export function EntityListView<T>({
  title,
  items,
  isLoading,
  hasMore,
  searchValue,
  totalCount,
  onSearchChange,
  onLoadMore,
  renderItem,
  emptyMessage,
  keyExtractor,
  headerAction,
}: EntityListViewProps<T>) {
  const { t } = useTranslation()
  const loadMoreRef = useRef<HTMLDivElement>(null)

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoading) {
          onLoadMore()
        }
      },
      { threshold: 0.1 }
    )

    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current)
    }

    return () => observer.disconnect()
  }, [hasMore, isLoading, onLoadMore])

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header with title, count, and optional action */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-fluux-text">
          {title}
          {totalCount !== undefined && (
            <span className="ms-2 text-sm font-normal text-fluux-muted">
              ({totalCount.toLocaleString()})
            </span>
          )}
        </h2>
        {headerAction}
      </div>

      {/* Search input */}
      <div className="relative mb-3">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fluux-muted" />
        <TextInput
          type="text"
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('admin.entityList.searchPlaceholder')}
          className="w-full ps-9 pe-3 py-2 text-sm bg-fluux-bg border border-fluux-hover rounded-lg
                     text-fluux-text placeholder-fluux-muted focus:outline-none focus:border-fluux-brand"
        />
      </div>

      {/* List container */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
        {items.length === 0 && !isLoading ? (
          <div className="flex flex-col items-center justify-center py-8 text-fluux-muted">
            <p>{emptyMessage}</p>
          </div>
        ) : (
          <>
            {items.map((item, index) => (
              <div key={keyExtractor(item)}>
                {renderItem(item, index)}
              </div>
            ))}

            {/* Load more trigger / loading indicator */}
            <div ref={loadMoreRef} className="py-2">
              {isLoading && (
                <div className="flex items-center justify-center gap-2 text-fluux-muted">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">{t('admin.entityList.loadingMore')}</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
