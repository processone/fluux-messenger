import { useTranslation } from 'react-i18next'
import { Building2, Globe, Mail, MapPin, Monitor, Smartphone, User } from 'lucide-react'
import { type Contact, type VCardInfo, getClientType } from '@fluux/sdk'
import { getShowColor, getTranslatedShowText } from '@/utils/presence'

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
          {vcard.fullName && (
            <InfoRow icon={User} label={vcard.fullName} />
          )}
          {vcard.org && (
            <InfoRow icon={Building2} label={vcard.org} />
          )}
          {vcard.email && (
            <InfoRow icon={Mail} label={vcard.email} />
          )}
          {vcard.country && (
            <InfoRow icon={MapPin} label={vcard.country} />
          )}
        </section>
      )}

      {/* Devices */}
      {hasResources && contact.resources && (
        <section>
          <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-2 px-1">
            {t('contacts.connectedDevices')}
          </h3>
          <ul className="space-y-2">
            {Array.from(contact.resources.entries()).map(([resource, presence]) => {
              const clientType = getClientType(presence.client)
              const DeviceIcon = clientType === 'mobile' ? Smartphone : clientType === 'web' ? Globe : Monitor
              return (
                <li
                  key={resource}
                  className="flex items-center gap-2 px-3 py-2 bg-fluux-bg rounded-lg"
                >
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${getShowColor(presence.show, forceOffline)}`}
                    aria-hidden
                  />
                  <DeviceIcon className="w-4 h-4 text-fluux-muted flex-shrink-0" aria-hidden />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-fluux-text truncate">
                      {presence.client || resource || t('contacts.unknown')}
                    </div>
                    <div className="text-xs text-fluux-muted truncate">
                      {getTranslatedShowText(presence.show, t, forceOffline)}
                      <span className="text-fluux-muted/60"> · {t('profile.priority')}: {presence.priority}</span>
                      {presence.client && resource && (
                        <span className="text-fluux-muted/60"> · {resource}</span>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}

function InfoRow({ icon: Icon, label }: { icon: typeof User; label: string }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <Icon className="w-4 h-4 text-fluux-muted flex-shrink-0" aria-hidden />
      <span className="text-sm text-fluux-text break-words">{label}</span>
    </div>
  )
}
