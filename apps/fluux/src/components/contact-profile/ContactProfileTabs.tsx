import { useTranslation } from 'react-i18next'
import { Loader2, Lock, LockOpen, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'

export type ContactProfileTab = 'profile' | 'security'

interface ContactProfileTabsProps {
  active: ContactProfileTab
  onChange: (tab: ContactProfileTab) => void
  encryptionState: ConversationEncryptionState
}

interface SecurityBadge {
  icon: typeof ShieldCheck
  className: string
  ariaLabel: string
}

function getSecurityBadge(
  state: ConversationEncryptionState,
  t: (key: string) => string,
): SecurityBadge | null {
  switch (state.kind) {
    case 'encrypted':
      return state.trust === 'verified'
        ? {
            icon: ShieldCheck,
            className: 'text-green-600 dark:text-green-400',
            ariaLabel: t('contacts.encryption.verified'),
          }
        : {
            icon: Lock,
            className: 'text-fluux-muted',
            ariaLabel: t('contacts.encryption.tofu'),
          }
    case 'plaintextForced':
      return {
        icon: LockOpen,
        className: 'text-fluux-muted',
        ariaLabel: t('chat.encryption.plaintextForced'),
      }
    case 'blocked':
      return {
        icon: ShieldAlert,
        className: 'text-yellow-600 dark:text-yellow-400',
        ariaLabel: t('chat.encryption.blocked'),
      }
    case 'checking':
      return {
        icon: Loader2,
        className: 'text-fluux-muted animate-spin',
        ariaLabel: t('chat.encryption.checking'),
      }
    default:
      return null
  }
}

export function ContactProfileTabs({ active, onChange, encryptionState }: ContactProfileTabsProps) {
  const { t } = useTranslation()
  const securityBadge = getSecurityBadge(encryptionState, t)

  const tabs: Array<{ key: ContactProfileTab; label: string; badge?: SecurityBadge | null }> = [
    { key: 'profile', label: t('contacts.tabs.profile') },
    { key: 'security', label: t('contacts.tabs.security'), badge: securityBadge },
  ]

  return (
    <div role="tablist" aria-orientation="horizontal" className="flex border-b border-fluux-bg sticky top-0 bg-fluux-chat z-10">
      {tabs.map(({ key, label, badge }) => {
        const isActive = active === key
        const Icon = badge?.icon
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`contact-tab-panel-${key}`}
            id={`contact-tab-${key}`}
            onClick={() => onChange(key)}
            className={`flex-1 flex items-center justify-center gap-2 px-4 min-h-[44px] text-sm font-medium border-b-2 transition-colors ${
              isActive
                ? 'border-fluux-brand text-fluux-text'
                : 'border-transparent text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover/50'
            }`}
          >
            <span>{label}</span>
            {Icon && badge && (
              <Icon
                className={`w-4 h-4 ${badge.className}`}
                aria-label={badge.ariaLabel}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

export { getSecurityBadge }
