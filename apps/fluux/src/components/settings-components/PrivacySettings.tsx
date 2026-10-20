import { useTranslation } from 'react-i18next'
import { useSettingsStore, type MediaAutoDownload } from '@/stores/settingsStore'
import { SettingsSection } from '@/components/ui/SettingsSection'
import { SettingsGroup } from '@/components/ui/SettingsGroup'
import { SettingsRow } from '@/components/ui/SettingsRow'
import { Toggle } from '@/components/ui/Toggle'

const mediaOptions: { value: MediaAutoDownload; labelKey: string; descriptionKey: string }[] = [
  { value: 'always', labelKey: 'settings.mediaAutoDownloadAlways', descriptionKey: 'settings.mediaAutoDownloadAlwaysDescription' },
  { value: 'private-only', labelKey: 'settings.mediaAutoDownloadPrivateOnly', descriptionKey: 'settings.mediaAutoDownloadPrivateOnlyDescription' },
  { value: 'never', labelKey: 'settings.mediaAutoDownloadNever', descriptionKey: 'settings.mediaAutoDownloadNeverDescription' },
]

export function PrivacySettings() {
  const { t } = useTranslation()
  const mediaAutoDownload = useSettingsStore((s) => s.mediaAutoDownload)
  const setMediaAutoDownload = useSettingsStore((s) => s.setMediaAutoDownload)
  const archiveConversations = useSettingsStore((s) => s.archiveConversations)
  const setArchiveConversations = useSettingsStore((s) => s.setArchiveConversations)

  return (
    <section className="w-full max-w-md">
      <SettingsSection>
        <SettingsGroup className="mb-6">
          <SettingsRow
            label={t('settings.archiveConversations')}
            description={t('settings.archiveConversationsDescription')}
            htmlFor="archive-conversations"
          >
            <Toggle
              id="archive-conversations"
              checked={archiveConversations}
              onChange={setArchiveConversations}
              aria-label={t('settings.archiveConversations')}
            />
          </SettingsRow>
        </SettingsGroup>
        <div className="space-y-3">
        <label id="media-auto-download-label" className="text-sm font-medium text-fluux-text">{t('settings.mediaAutoDownload')}</label>
        <div role="group" aria-labelledby="media-auto-download-label"
          className="grid grid-cols-3 gap-1 rounded-lg border border-fluux-border bg-fluux-bg p-1">
          {mediaOptions.map((option) => {
            const isSelected = mediaAutoDownload === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setMediaAutoDownload(option.value)}
                className={`min-w-0 rounded-md px-2 py-2 text-center text-sm font-medium leading-tight transition-colors
                  ${isSelected
                    ? 'bg-fluux-active text-fluux-text ring-1 ring-fluux-brand'
                    : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text'
                  }`}
              >
                {t(option.labelKey)}
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
