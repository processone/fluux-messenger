import { useTranslation } from 'react-i18next'
import { type ResourcePresence, useConnection } from '@fluux/sdk'
import { DeviceListItem } from '@/components/profile-shared/DeviceListItem'
import { SettingsDisclosure } from '@/components/ui/SettingsDisclosure'
import { SettingsSection } from '@/components/ui/SettingsSection'

export function DevicesSection() {
  const { ownResources, isConnected } = useConnection()
  const { t } = useTranslation()

  const hasResources = ownResources && ownResources.size > 0

  return (
    <section className="px-4 md:px-6">
      <SettingsSection title={hasResources ? t('profile.otherConnectedDevices') : t('profile.connectedDevices')}>
        {hasResources ? (
          <div className="space-y-3">
            <ul className="space-y-2 w-full">
              {Array.from(ownResources.entries()).map(([resource, presence]: [string, ResourcePresence]) => (
                <DeviceListItem
                  key={resource}
                  resource={resource}
                  presence={presence}
                  forceOffline={!isConnected}
                  showTechnicalDetails={false}
                />
              ))}
            </ul>
            <SettingsDisclosure title={t('profile.deviceDetails')}>
              {Array.from(ownResources.entries()).map(([resource, presence]) => (
                <div key={resource} className="min-w-0 space-y-2">
                  <p className="text-sm font-medium text-fluux-text break-all">
                    {presence.client || resource || t('contacts.unknown')}
                  </p>
                  <dl className="text-xs space-y-1">
                    <div>
                      <dt className="text-fluux-muted">{t('profile.sessionId')}</dt>
                      <dd className="font-mono text-fluux-text break-all">{resource}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-fluux-muted">{t('profile.priority')}</dt>
                      <dd className="text-fluux-text">{presence.priority}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </SettingsDisclosure>
          </div>
        ) : (
          <p className="text-fluux-muted text-sm text-center py-4">
            {t('profile.noOtherDevices')}
          </p>
        )}
      </SettingsSection>
    </section>
  )
}
