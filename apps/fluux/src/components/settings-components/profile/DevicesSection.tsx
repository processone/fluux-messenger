import { useTranslation } from 'react-i18next'
import { type ResourcePresence, useConnection } from '@fluux/sdk'
import { DeviceListItem } from '@/components/profile-shared/DeviceListItem'

export function DevicesSection() {
  const { ownResources, isConnected } = useConnection()
  const { t } = useTranslation()

  const hasResources = ownResources && ownResources.size > 0

  return (
    <section className="px-4 md:px-6">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-2 px-1">
        {hasResources ? t('profile.otherConnectedDevices') : t('profile.connectedDevices')}
      </h3>
      {hasResources ? (
        <ul className="space-y-2 w-full max-w-md">
          {Array.from(ownResources.entries()).map(([resource, presence]: [string, ResourcePresence]) => (
            <DeviceListItem
              key={resource}
              resource={resource}
              presence={presence}
              forceOffline={!isConnected}
            />
          ))}
        </ul>
      ) : (
        <p className="text-fluux-muted text-sm text-center py-4">
          {t('profile.noOtherDevices')}
        </p>
      )}
    </section>
  )
}
