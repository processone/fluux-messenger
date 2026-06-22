import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, ChevronRight } from 'lucide-react'
import { useAdmin, type ServerStats, type AdminCommand } from '@fluux/sdk'
import { OVERVIEW_CARDS } from './admin/adminOverview'
import { formatTime } from '@/utils/format'

/**
 * Friendly server overview: a discovery-driven grid of vital-signs cards plus
 * an "Advanced" disclosure that preserves the raw stats command runner.
 */
export function ServerOverview() {
  const { t } = useTranslation()
  const {
    serverStats,
    isLoadingStats,
    fetchServerStats,
    commandsByCategory,
    executeCommand,
    isExecuting,
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
            return (
              <div key={String(card.key)} className="p-4 rounded-xl bg-fluux-bg border border-fluux-hover">
                <div className="flex items-center gap-2 text-fluux-muted mb-2">
                  <Icon className="size-4" />
                  <span className="text-xs font-medium">{t(card.labelKey)}</span>
                </div>
                <div className="text-2xl font-semibold text-fluux-text break-words" title={String(value)}>
                  {card.format(value, durationUnits)}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Advanced: raw stats commands (preserved capability) */}
      {commandsByCategory.stats.length > 0 && (
        <details className="mt-6 group">
          <summary className="flex items-center gap-1.5 cursor-pointer text-sm text-fluux-muted hover:text-fluux-text select-none">
            <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
            {t('admin.overview.advanced')}
          </summary>
          <p className="text-xs text-fluux-muted mt-1 ms-5">{t('admin.overview.advancedHint')}</p>
          <div className="mt-2 ms-5 space-y-0.5">
            {commandsByCategory.stats.map((cmd: AdminCommand) => (
              <button
                key={cmd.node}
                onClick={() => { void executeCommand(cmd.node) }}
                disabled={isExecuting}
                className="w-full px-2 py-1.5 rounded flex items-center justify-between text-start text-sm text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text disabled:opacity-50 transition-colors"
              >
                <span className="truncate">{cmd.name}</span>
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
