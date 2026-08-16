import { useTranslation } from 'react-i18next'
import { Building2, Mail, MapPin, User } from 'lucide-react'
import { type ProfileDetails } from '@fluux/sdk'
import { InfoRow } from '@/components/profile-shared/InfoRow'

interface AboutCardProps {
  details: ProfileDetails | null
}

export function AboutCard({ details }: AboutCardProps) {
  const { t } = useTranslation()
  const hasDetails = details && (details.fullName || details.org || details.email || details.country)
  if (!hasDetails || !details) return null

  return (
    <section className="rounded-xl border border-fluux-border bg-fluux-surface p-3">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-1 px-1">
        {t('contacts.about')}
      </h3>
      {details.fullName && <InfoRow icon={User} label={details.fullName} />}
      {details.org && <InfoRow icon={Building2} label={details.org} />}
      {details.email && <InfoRow icon={Mail} label={details.email} />}
      {details.country && <InfoRow icon={MapPin} label={details.country} />}
    </section>
  )
}
