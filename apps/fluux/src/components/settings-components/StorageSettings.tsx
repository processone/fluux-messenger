import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, Loader2, Check, Search } from 'lucide-react'
import { formatBytes } from '@/hooks'
import { getMediaCacheSize, clearMediaCache } from '@/utils/mediaCache'
import { rebuildSearchIndex } from '@fluux/sdk'
import type { RebuildProgress } from '@fluux/sdk'

export function StorageSettings() {
  const { t } = useTranslation()
  const [cacheSize, setCacheSize] = useState<number | null>(null)
  const [isClearing, setIsClearing] = useState(false)
  const [cleared, setCleared] = useState(false)
  const [isRebuilding, setIsRebuilding] = useState(false)
  const [rebuilt, setRebuilt] = useState<number | false>(false)
  const [progress, setProgress] = useState<RebuildProgress | null>(null)

  const loadCacheSize = useCallback(async () => {
    setCacheSize(null)
    const size = await getMediaCacheSize()
    setCacheSize(size)
  }, [])

  useEffect(() => {
    void loadCacheSize()
  }, [loadCacheSize])

  const handleClear = async () => {
    setIsClearing(true)
    setCleared(false)
    await clearMediaCache()
    setCacheSize(0)
    setIsClearing(false)
    setCleared(true)
    // Reset "cleared" feedback after a few seconds
    setTimeout(() => setCleared(false), 3000)
  }

  const handleRebuildIndex = async () => {
    setIsRebuilding(true)
    setRebuilt(false)
    setProgress(null)
    try {
      const count = await rebuildSearchIndex((p) => setProgress(p))
      setRebuilt(count)
      setTimeout(() => setRebuilt(false), 5000)
    } catch (error) {
      console.error('[StorageSettings] Search index rebuild failed:', error)
    } finally {
      setIsRebuilding(false)
      setProgress(null)
    }
  }

  const progressPercent = progress && progress.total > 0
    ? Math.round((progress.indexed / progress.total) * 100)
    : 0

  return (
    <section className="max-w-md space-y-8">
      <div>
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.storage.mediaCache')}
      </h3>

      <div className="space-y-4">
        <p className="text-sm text-fluux-muted">
          {t('settings.storage.mediaCacheDescription')}
        </p>

        {/* Cache size display */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-fluux-bg/60 border border-fluux-border">
          <span className="text-sm text-fluux-text">{t('settings.storage.cacheSize')}</span>
          <span className="text-sm font-medium text-fluux-text">
            {cacheSize === null
              ? t('settings.storage.calculating')
              : formatBytes(cacheSize)
            }
          </span>
        </div>

        {/* Clear cache button */}
        <button
          onClick={handleClear}
          disabled={isClearing || cacheSize === 0}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
            bg-fluux-hover hover:bg-fluux-border text-fluux-text
            disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isClearing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : cleared ? (
            <Check className="w-4 h-4 text-fluux-green" />
          ) : (
            <Trash2 className="w-4 h-4" />
          )}
          {cleared ? t('settings.storage.cacheCleared') : t('settings.storage.clearCache')}
        </button>
      </div>
      </div>

      {/* Search index */}
      <div>
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.storage.searchIndex', 'Search Index')}
      </h3>

      <div className="space-y-4">
        <p className="text-sm text-fluux-muted">
          {t('settings.storage.searchIndexDescription', 'The search index allows full-text search across your message history. Rebuild it if search results seem incomplete.')}
        </p>

        {/* Progress bar */}
        {isRebuilding && progress && progress.total > 0 && (
          <div className="space-y-1">
            <div className="h-2 rounded-full bg-fluux-hover overflow-hidden">
              <div
                className="h-full rounded-full bg-fluux-brand transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <p className="text-xs text-fluux-muted text-end">
              {progress.indexed} / {progress.total} ({progressPercent}%)
            </p>
          </div>
        )}

        <button
          onClick={handleRebuildIndex}
          disabled={isRebuilding}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
            bg-fluux-hover hover:bg-fluux-border text-fluux-text
            disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRebuilding ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : rebuilt !== false ? (
            <Check className="w-4 h-4 text-fluux-green" />
          ) : (
            <Search className="w-4 h-4" />
          )}
          {isRebuilding
            ? t('settings.storage.rebuildingIndex', 'Rebuilding…')
            : rebuilt !== false
              ? t('settings.storage.indexRebuilt', '{{count}} messages indexed', { count: rebuilt })
              : t('settings.storage.rebuildIndex', 'Rebuild search index')}
        </button>
      </div>
      </div>
    </section>
  )
}
