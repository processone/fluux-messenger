import { useTranslation } from 'react-i18next'
import { Wrench, AlertTriangle } from 'lucide-react'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

/**
 * Advanced settings category.
 *
 * Foundation only: this category is the home for expert/advanced options
 * (custom resource, connection tuning, insecure-TLS opt-in, …) which will be
 * added here incrementally. For now it explains what advanced mode is and lets
 * the user turn it back off — the same flag also gates this category's
 * visibility in the settings sidebar.
 */
export function AdvancedSettings() {
  const { t } = useTranslation()
  const setAdvancedMode = useAdvancedModeStore((s) => s.setAdvancedMode)

  return (
    <section className="max-w-md">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.advanced.title')}
      </h3>

      {/* Warning banner — advanced options can break connectivity/security */}
      <div className="flex items-start gap-3 rounded-lg border border-fluux-border bg-fluux-bg p-4 mb-6">
        <AlertTriangle className="size-5 text-fluux-yellow shrink-0 mt-0.5" />
        <p className="text-sm text-fluux-text">{t('settings.advanced.warning')}</p>
      </div>

      {/* Placeholder for the advanced options that will live here */}
      <div className="flex flex-col items-center text-center gap-2 rounded-lg border border-dashed border-fluux-border p-6 mb-6">
        <Wrench className="size-6 text-fluux-muted" />
        <p className="text-sm text-fluux-muted">{t('settings.advanced.empty')}</p>
      </div>

      {/* Turn advanced mode back off */}
      <div className="space-y-3">
        <p className="text-sm text-fluux-text">{t('settings.advanced.disableDescription')}</p>
        <button
          type="button"
          onClick={() => setAdvancedMode(false)}
          className="px-4 py-2 rounded-lg border border-fluux-border text-sm font-medium
                     text-fluux-text hover:bg-fluux-hover transition-colors tap-target"
        >
          {t('settings.advanced.disable')}
        </button>
      </div>
    </section>
  )
}
