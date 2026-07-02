import { useTranslation } from 'react-i18next'
import { Building2, Mail, MapPin, User } from 'lucide-react'
import { type VCardInfo } from '@fluux/sdk'
import { InfoRow } from '@/components/profile-shared/InfoRow'

interface AboutCardProps {
  vcard: VCardInfo | null
}

export function AboutCard({ vcard }: AboutCardProps) {
  const { t } = useTranslation()
  const hasVcard = vcard && (vcard.fullName || vcard.org || vcard.email || vcard.country)
  if (!hasVcard || !vcard) return null

  return (
    <section className="rounded-xl border border-fluux-border bg-fluux-surface p-3">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-1 px-1">
        {t('contacts.about')}
      </h3>
      {vcard.fullName && <InfoRow icon={User} label={vcard.fullName} />}
      {vcard.org && <InfoRow icon={Building2} label={vcard.org} />}
      {vcard.email && <InfoRow icon={Mail} label={vcard.email} />}
      {vcard.country && <InfoRow icon={MapPin} label={vcard.country} />}
    </section>
  )
}
