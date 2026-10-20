import { useTranslation } from 'react-i18next'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

export function AdvancedSettings() {
  const { t } = useTranslation()
  const advancedMode = useAdvancedModeStore((s) => s.advancedMode)
  const setAdvancedMode = useAdvancedModeStore((s) => s.setAdvancedMode)

  return (
    <section className="w-full max-w-md space-y-4">
      <p className="text-sm text-fluux-text">{t('settings.advanced.enableDescription')}</p>
      <button
        type="button"
        onClick={() => setAdvancedMode(!advancedMode)}
        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors tap-target
          ${advancedMode
            ? 'border border-fluux-border text-fluux-text hover:bg-fluux-hover'
            : 'bg-fluux-brand text-fluux-text-on-accent hover:bg-fluux-brand-hover'
          }`}
      >
        {t(advancedMode ? 'settings.advanced.disable' : 'settings.advanced.enable')}
      </button>
    </section>
  )
}
