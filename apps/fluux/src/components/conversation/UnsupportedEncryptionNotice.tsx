import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'
import { Tooltip } from '@/components/Tooltip'

export interface UnsupportedEncryptionNoticeProps {
  /**
   * Human-readable protocol name from {@link BaseMessage.unsupportedEncryption}
   * `.name`, e.g. `"OMEMO"`. Optional — falls back to a generic notice when the
   * sender's encryption method couldn't be named.
   */
  method?: string
}

/**
 * Rendered inside a message bubble when {@link BaseMessage.unsupportedEncryption}
 * is set — the SDK received an encrypted stanza whose protocol no registered
 * plugin handles (e.g. OMEMO). We deliberately suppress the sender's plaintext
 * fallback `<body>` (its wording and language are chosen by the sender's client,
 * so it reads like a real message) and show a localized notice instead.
 *
 * Unlike {@link EncryptedPlaceholder} there is no click affordance: the method is
 * simply unsupported, so there's nothing for the user to unlock or enable. The
 * visual language (muted, italic, small lock) intentionally matches the
 * placeholder's non-interactive state so all unreadable-encryption messages look
 * alike regardless of protocol.
 */
export const UnsupportedEncryptionNotice = memo(function UnsupportedEncryptionNotice({
  method,
}: UnsupportedEncryptionNoticeProps) {
  const { t } = useTranslation()
  const label = method
    ? t('chat.encryption.unsupportedMessage', { method })
    : t('chat.encryption.unsupportedMessageGeneric')
  return (
    <Tooltip
      content={t('chat.encryption.unsupportedMethodTooltip', { method: method ?? '' })}
      position="top"
      className="flex items-center gap-2 text-fluux-muted italic"
    >
      <Lock className="size-3.5 flex-shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </Tooltip>
  )
})
