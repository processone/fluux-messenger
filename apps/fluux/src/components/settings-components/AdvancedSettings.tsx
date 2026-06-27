import { useTranslation } from 'react-i18next'
import { Wrench, AlertTriangle } from 'lucide-react'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

/**
 * Advanced settings category.
 *
 * This category is always visible in the settings sidebar and is the canonical
 * home for the advanced-mode switch (both directions), so the flag is reachable
 * in-app even when autoconnect skips the login screen. When advanced mode is
 * off it explains the feature and offers to enable it; when on it shows the
 * expert options (placeholder for now) and lets the user turn it back off.
 */
export function AdvancedSettings() {
  const { t } = useTranslation()
  const advancedMode = useAdvancedModeStore((s) => s.advancedMode)
  const setAdvancedMode = useAdvancedModeStore((s) => s.setAdvancedMode)

  return (
    <section className="max-w-md">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.advanced.title')}
      </h3>

      {!advancedMode ? (
        /* OFF: explain what advanced mode unlocks, then offer to enable it. */
        <div className="space-y-4">
          <p className="text-sm text-fluux-text">{t('settings.advanced.enableDescription')}</p>
          <button
            type="button"
            onClick={() => setAdvancedMode(true)}
            className="px-4 py-2 rounded-lg bg-fluux-brand text-fluux-text-on-accent text-sm font-medium
                       hover:bg-fluux-brand-hover transition-colors tap-target"
          >
            {t('settings.advanced.enable')}
          </button>
        </div>
      ) : (
        /* ON: warning + options placeholder + turn back off. */
        <>
          <div className="flex items-start gap-3 rounded-lg border border-fluux-border bg-fluux-bg p-4 mb-6">
            <AlertTriangle className="size-5 text-fluux-yellow shrink-0 mt-0.5" />
            <p className="text-sm text-fluux-text">{t('settings.advanced.warning')}</p>
          </div>

          <div className="flex flex-col items-center text-center gap-2 rounded-lg border border-dashed border-fluux-border p-6 mb-6">
            <Wrench className="size-6 text-fluux-muted" />
            <p className="text-sm text-fluux-muted">{t('settings.advanced.empty')}</p>
          </div>

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
        </>
      )}
    </section>
  )
}
