import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, ChevronRight } from 'lucide-react'
import { useAdmin, adminStore, type ServerStats } from '@fluux/sdk'
import { OVERVIEW_CARDS } from './admin/adminOverview'
import { formatTime } from '@/utils/format'

/**
 * Friendly server overview: a discovery-driven grid of vital-signs cards.
 */
export function ServerOverview() {
  const { t } = useTranslation()
  const {
    serverStats,
    isLoadingStats,
    fetchServerStats,
  } = useAdmin()

  // Fetch on mount (idempotent enough; refresh is manual otherwise).
  useEffect(() => {
    void fetchServerStats()
  }, [fetchServerStats])

  const durationUnits = {
    d: t('admin.overview.units.d'),
    h: t('admin.overview.units.h'),
    m: t('admin.overview.units.m'),
    s: t('admin.overview.units.s'),
  }

  const stats = serverStats
  const presentCards = stats
    ? OVERVIEW_CARDS.filter(card => stats[card.key] !== undefined && stats[card.key] !== null)
    : []

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-fluux-muted">
          {stats?.fetchedAt
            ? t('admin.overview.updatedAt', { time: formatTime(stats.fetchedAt) })
            : null}
        </div>
        <button
          type="button"
          onClick={() => { void fetchServerStats() }}
          disabled={isLoadingStats}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-fluux-bg hover:bg-fluux-hover text-fluux-text disabled:opacity-50 transition-colors tap-target"
        >
          <RefreshCw className={`size-4 ${isLoadingStats ? 'animate-spin' : ''}`} />
          {t('admin.overview.refresh')}
        </button>
      </div>

      {/* Cards or empty state */}
      {presentCards.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted py-12">
          <p className="mb-3">{t('admin.overview.empty')}</p>
          <button
            type="button"
            onClick={() => { void fetchServerStats() }}
            className="px-4 py-2 text-sm rounded-lg bg-fluux-brand text-fluux-text-on-accent hover:bg-fluux-brand/90 transition-colors"
          >
            {t('admin.overview.retry')}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {presentCards.map(card => {
            const Icon = card.icon
            const value = stats![card.key] as NonNullable<ServerStats[keyof ServerStats]>
            const secondary = card.secondaryKey ? stats![card.secondaryKey] : undefined
            const inner = (
              <>
                <div className="flex items-center gap-2 text-fluux-muted mb-2">
                  <Icon className="size-4" />
                  <span className="text-xs font-medium">{t(card.labelKey)}</span>
                  {card.target && <ChevronRight className="size-4 ms-auto rtl-mirror" />}
                </div>
                <div className="text-2xl font-semibold text-fluux-text break-words font-display" title={String(value)}>
                  {card.format(value, durationUnits)}
                </div>
                {card.secondaryLabelKey && secondary != null && (
                  <div className="text-xs text-fluux-muted mt-1">
                    {t(card.secondaryLabelKey, { n: secondary as number })}
                  </div>
                )}
              </>
            )
            if (card.target) {
              const target = card.target
              return (
                <button
                  key={String(card.key)}
                  type="button"
                  onClick={() => adminStore.getState().setActiveCategory(target)}
                  className="flex flex-col p-4 rounded-xl bg-fluux-surface border border-fluux-border text-start hover:bg-fluux-hover hover:border-fluux-brand/40 transition-colors tap-target"
                >
                  {inner}
                </button>
              )
            }
            return (
              <div key={String(card.key)} className="p-4 rounded-xl bg-fluux-surface border border-fluux-border">
                {inner}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
