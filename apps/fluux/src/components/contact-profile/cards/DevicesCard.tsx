import { useTranslation } from 'react-i18next'
import { type Contact } from '@fluux/sdk'
import { DeviceListItem } from '@/components/profile-shared/DeviceListItem'

interface DevicesCardProps {
  contact: Contact
  forceOffline: boolean
}

export function DevicesCard({ contact, forceOffline }: DevicesCardProps) {
  const { t } = useTranslation()
  const hasResources = contact.resources && contact.resources.size > 0
  if (!hasResources || !contact.resources) return null

  return (
    <section className="rounded-xl border border-fluux-hover bg-fluux-bg/40 p-3">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-2 px-1">
        {t('contacts.connectedDevices')}
      </h3>
      <ul className="space-y-2">
        {Array.from(contact.resources.entries()).map(([resource, presence]) => (
          <DeviceListItem
            key={resource}
            resource={resource}
            presence={presence}
            forceOffline={forceOffline}
          />
        ))}
      </ul>
    </section>
  )
}
