import { useTranslation } from 'react-i18next'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'
import { SettingsGroup } from '@/components/ui/SettingsGroup'
import { SettingsRow } from '@/components/ui/SettingsRow'
import { SettingsDisclosure } from '@/components/ui/SettingsDisclosure'
import { Toggle } from '@/components/ui/Toggle'

export function AdvancedSettings() {
  const { t } = useTranslation()
  const advancedMode = useAdvancedModeStore((s) => s.advancedMode)
  const setAdvancedMode = useAdvancedModeStore((s) => s.setAdvancedMode)

  return (
    <section className="w-full max-w-md space-y-4">
      <SettingsGroup>
        <SettingsRow
          label={t('login.advancedMode')}
          description={t('settings.advanced.enableDescription')}
          htmlFor="advanced-mode"
        >
          <Toggle id="advanced-mode" checked={advancedMode} onChange={setAdvancedMode} />
        </SettingsRow>
      </SettingsGroup>
      <SettingsDisclosure title={t('settings.advanced.toolLocations')}>
        <div>
          <h4 className="text-sm font-medium text-fluux-text">{t('console.title')}</h4>
          <p className="mt-1 text-xs text-fluux-muted">{t('settings.advanced.consoleLocation')}</p>
        </div>
        <div>
          <h4 className="text-sm font-medium text-fluux-text">{t('login.serverLabel')}</h4>
          <p className="mt-1 text-xs text-fluux-muted">{t('settings.advanced.serverLocation')}</p>
        </div>
      </SettingsDisclosure>
    </section>
  )
}
