import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { ModalOverlay } from '../ModalOverlay'
import { SecurityTab } from './tabs/SecurityTab'

interface ContactSecurityDetailProps {
  state: ConversationEncryptionState
  onVerify: () => void
  onRequestRevoke: () => void
  onDisableEncryption: () => void
  onEnableEncryption: () => void
  onClose: () => void
  peerJid?: string
  omemo?: React.ComponentProps<typeof SecurityTab>['omemo']
}

export function ContactSecurityDetail({
  state,
  onVerify,
  onRequestRevoke,
  onDisableEncryption,
  onEnableEncryption,
  onClose,
  peerJid,
  omemo,
}: ContactSecurityDetailProps) {
  const { t } = useTranslation()

  return (
    <ModalOverlay
      onClose={onClose}
      width="max-w-md"
      panelClassName="flex flex-col overflow-hidden md:max-h-[calc(100vh-2rem)] max-md:mx-0 max-md:max-w-none max-md:h-[100dvh] max-md:rounded-none"
    >
      <div className="h-14 px-4 flex items-center gap-2 border-b border-fluux-bg flex-shrink-0">
        <button
          onClick={onClose}
          className="p-1 -ms-1 rounded hover:bg-fluux-hover tap-target"
          aria-label={t('common.back')}
        >
          <ArrowLeft className="size-5 text-fluux-muted rtl-mirror" />
        </button>
        <h2 className="font-semibold text-fluux-text">{t('contacts.securityDetailsTitle')}</h2>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        <SecurityTab
          state={state}
          onVerify={onVerify}
          onRequestRevoke={onRequestRevoke}
          onDisableEncryption={onDisableEncryption}
          onEnableEncryption={onEnableEncryption}
          peerJid={peerJid}
          omemo={omemo}
        />
      </div>
    </ModalOverlay>
  )
}
