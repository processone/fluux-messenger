import { useTranslation } from 'react-i18next'
import { Building2, Mail, MapPin, User } from 'lucide-react'
import { type Contact, type VCardInfo } from '@fluux/sdk'
import { InfoRow } from '@/components/profile-shared/InfoRow'
import { DeviceListItem } from '@/components/profile-shared/DeviceListItem'

interface ProfileTabProps {
  contact: Contact
  vcard: VCardInfo | null
  forceOffline: boolean
}

export function ProfileTab({ contact, vcard, forceOffline }: ProfileTabProps) {
  const { t } = useTranslation()

  const hasVcard = vcard && (vcard.fullName || vcard.org || vcard.email || vcard.country)
  const hasResources = contact.resources && contact.resources.size > 0

  if (!hasVcard && !hasResources) {
    return (
      <div className="px-4 py-8 md:px-6 text-center text-sm text-fluux-muted">
        {t('contacts.noContacts')}
      </div>
    )
  }

  return (
    <div className="px-4 py-4 md:px-6 md:py-5 space-y-5">
      {/* vCard */}
      {hasVcard && vcard && (
        <section className="rounded-lg bg-fluux-bg/40 py-1">
          {vcard.fullName && <InfoRow icon={User} label={vcard.fullName} />}
          {vcard.org && <InfoRow icon={Building2} label={vcard.org} />}
          {vcard.email && <InfoRow icon={Mail} label={vcard.email} />}
          {vcard.country && <InfoRow icon={MapPin} label={vcard.country} />}
        </section>
      )}

      {/* Devices */}
      {hasResources && contact.resources && (
        <section>
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
      )}
    </div>
  )
}
