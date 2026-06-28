import { useTranslation } from 'react-i18next'
import { useSettingsStore, type MediaAutoDownload } from '@/stores/settingsStore'
import { SettingsSection } from '@/components/ui/SettingsSection'

const mediaOptions: { value: MediaAutoDownload; labelKey: string; descriptionKey: string }[] = [
  { value: 'always', labelKey: 'settings.mediaAutoDownloadAlways', descriptionKey: 'settings.mediaAutoDownloadAlwaysDescription' },
  { value: 'private-only', labelKey: 'settings.mediaAutoDownloadPrivateOnly', descriptionKey: 'settings.mediaAutoDownloadPrivateOnlyDescription' },
  { value: 'never', labelKey: 'settings.mediaAutoDownloadNever', descriptionKey: 'settings.mediaAutoDownloadNeverDescription' },
]

export function PrivacySettings() {
  const { t } = useTranslation()
  const mediaAutoDownload = useSettingsStore((s) => s.mediaAutoDownload)
  const setMediaAutoDownload = useSettingsStore((s) => s.setMediaAutoDownload)

  return (
    <section className="w-full max-w-md">
      <SettingsSection title={t('settings.categories.privacy')}>
        <div className="space-y-3">
        <label className="text-sm font-medium text-fluux-text">{t('settings.mediaAutoDownload')}</label>
        <p className="text-xs text-fluux-muted">{t('settings.mediaAutoDownloadDescription')}</p>
        <div className="flex flex-col gap-2">
          {mediaOptions.map((option) => {
            const isSelected = mediaAutoDownload === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setMediaAutoDownload(option.value)}
                className={`w-full text-start px-4 py-2.5 rounded-lg border-2 transition-all
                  ${isSelected
                    ? 'border-fluux-brand bg-fluux-brand/10'
                    : 'border-fluux-hover bg-fluux-bg hover:border-fluux-muted'
                  }`}
              >
                <span className={`text-sm font-medium ${isSelected ? 'text-fluux-text' : 'text-fluux-muted'}`}>
                  {t(option.labelKey)}
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-fluux-muted mt-2">
          {t(mediaOptions.find((o) => o.value === mediaAutoDownload)?.descriptionKey || '')}
        </p>
        <p className="text-xs text-fluux-muted border-t border-fluux-border pt-3 mt-3">
          {t('settings.mediaAutoDownloadStrangerNote')}
        </p>
        </div>
      </SettingsSection>
    </section>
  )
}
