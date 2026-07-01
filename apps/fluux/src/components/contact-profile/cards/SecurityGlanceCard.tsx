import { useTranslation } from 'react-i18next'
import {
  ChevronRight, Loader2, Lock, LockOpen, ShieldAlert, ShieldCheck, ShieldX,
} from 'lucide-react'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'

interface SecurityGlanceCardProps {
  state: ConversationEncryptionState
  onOpen: () => void
}

interface Glance {
  icon: typeof ShieldCheck
  label: string
  tone: 'success' | 'neutral' | 'warning' | 'danger'
}

export function getGlance(
  state: ConversationEncryptionState,
  t: (key: string) => string,
): Glance | null {
  switch (state.kind) {
    case 'encrypted':
      return state.trust === 'verified'
        ? { icon: ShieldCheck, label: t('contacts.encryption.glanceVerified'), tone: 'success' }
        : { icon: Lock, label: t('contacts.encryption.glanceEncrypted'), tone: 'neutral' }
    case 'keyLocked':
      return { icon: Lock, label: t('contacts.encryption.glanceLocked'), tone: 'neutral' }
    case 'plaintextForced':
      return { icon: LockOpen, label: t('contacts.encryption.glanceDisabled'), tone: 'neutral' }
    case 'unsupported':
      return { icon: LockOpen, label: t('contacts.encryption.glanceNotEncrypted'), tone: 'neutral' }
    case 'rejected':
      return { icon: ShieldX, label: t('contacts.encryption.rejectedTitle'), tone: 'danger' }
    case 'blocked':
      return { icon: ShieldAlert, label: t('chat.encryption.blocked'), tone: 'warning' }
    case 'checking':
      return { icon: Loader2, label: t('chat.encryption.checking'), tone: 'neutral' }
    default:
      return null
  }
}

const TONE_CLASS: Record<Glance['tone'], string> = {
  success: 'text-fluux-encryption',
  danger: 'text-fluux-error',
  warning: 'text-fluux-yellow',
  neutral: 'text-fluux-muted',
}

export function SecurityGlanceCard({ state, onOpen }: SecurityGlanceCardProps) {
  const { t } = useTranslation()
  const glance = getGlance(state, t)
  if (!glance) return null
  const Icon = glance.icon
  const spin = state.kind === 'checking'

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full flex items-center gap-2 rounded-xl border border-fluux-hover bg-fluux-surface p-3 text-start hover:bg-fluux-hover transition-colors min-h-[44px]"
    >
      <Icon className={`size-5 flex-shrink-0 ${TONE_CLASS[glance.tone]} ${spin ? 'animate-spin' : ''}`} aria-hidden />
      <span className="text-sm text-fluux-text flex-1 min-w-0">{glance.label}</span>
      <ChevronRight className="size-4 text-fluux-muted flex-shrink-0 rtl-mirror" aria-hidden />
    </button>
  )
}
