import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, Loader2, Check } from 'lucide-react'
import { formatBytes } from '@/hooks'
import { getMediaCacheSize, clearMediaCache } from '@/utils/mediaCache'

export function StorageSettings() {
  const { t } = useTranslation()
  const [cacheSize, setCacheSize] = useState<number | null>(null)
  const [isClearing, setIsClearing] = useState(false)
  const [cleared, setCleared] = useState(false)

  const loadCacheSize = useCallback(async () => {
    setCacheSize(null)
    const size = await getMediaCacheSize()
    setCacheSize(size)
  }, [])

  useEffect(() => {
    loadCacheSize()
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

  return (
    <section className="max-w-md">
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
    </section>
  )
}
