import { useTranslation } from 'react-i18next'
import { type Contact, type VCardInfo } from '@fluux/sdk'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { AboutCard } from './cards/AboutCard'
import { DevicesCard } from './cards/DevicesCard'
import { GroupsCard } from './cards/GroupsCard'
import { SecurityGlanceCard } from './cards/SecurityGlanceCard'

interface ContactProfileGridProps {
  contact: Contact
  vcard: VCardInfo | null
  isInRoster: boolean
  forceOffline: boolean
  encryptionState: ConversationEncryptionState
  onOpenSecurity: () => void
}

export function ContactProfileGrid({
  contact,
  vcard,
  isInRoster,
  forceOffline,
  encryptionState,
  onOpenSecurity,
}: ContactProfileGridProps) {
  const { t } = useTranslation()

  // Each card self-nulls when it has no data; mirror those conditions so we can
  // show an empty state instead of a bare padded grid when nothing renders.
  const hasAbout = !!(vcard && (vcard.fullName || vcard.org || vcard.email || vcard.country))
  const hasDevices = !!(contact.resources && contact.resources.size > 0)
  const hasGroups = !!(isInRoster && contact.groups && contact.groups.length > 0)
  const hasSecurity = encryptionState.kind !== 'disabled'

  if (!hasAbout && !hasDevices && !hasGroups && !hasSecurity) {
    return (
      <div className="px-4 py-8 md:px-6 text-center text-sm text-fluux-muted">
        {t('contacts.noDetails')}
      </div>
    )
  }

  return (
    <div className="px-4 py-4 md:px-6 md:py-5 grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
      <AboutCard vcard={vcard} />
      <DevicesCard contact={contact} forceOffline={forceOffline} />
      <GroupsCard groups={contact.groups} isInRoster={isInRoster} />
      <SecurityGlanceCard state={encryptionState} onOpen={onOpenSecurity} />
    </div>
  )
}
