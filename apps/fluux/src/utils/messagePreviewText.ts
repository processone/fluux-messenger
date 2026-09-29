import { isSpamModerated } from './spamModeration'
import { formatMessagePreview, type BaseMessage, type DecryptFailureReason } from '@fluux/sdk'

/** Minimal shape of the i18next `t` we rely on — avoids coupling to its generics. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

type PreviewMessage = Parameters<typeof formatMessagePreview>[0] &
  Pick<BaseMessage, 'isRetracted' | 'isModerated' | 'moderationReason' | 'unsupportedEncryption' | 'encryptedPayload' | 'securityContext'>

/**
 * Localized last-message preview / notification text.
 *
 * Mirrors {@link formatMessagePreview} but substitutes a localized notice for
 * messages whose `<body>` must not — or cannot — be surfaced verbatim:
 *
 *  1. **Retracted messages.** The store deliberately preserves `body` through a
 *     retraction, so the SDK formatter would echo the text the sender just
 *     deleted; and a bodiless retraction would collapse to an empty preview.
 *     Ordinary retractions read "message deleted". Moderated Spam is hidden
 *     under the same policy as the conversation timeline.
 *  2. **Pending decryption.** Use the same localized failure reason as the
 *     message bubble instead of exposing the SDK fallback body.
 *  3. **Unsupported-encryption messages.** The plaintext fallback body is chosen
 *     by the sender's client (e.g. "You received a message encrypted with
 *     OMEMO…"), so it reads like a real message. This keeps preview surfaces
 *     consistent with the in-bubble {@link UnsupportedEncryptionNotice}.
 *
 * Retraction is checked first: a retracted message is deleted regardless of how
 * it was encrypted.
 *
 * The retraction notice lives here rather than in each caller so every present
 * and future preview surface — sidebar, rooms list, command palette, desktop
 * notifications, reaction quotes, clipboard — is covered without repeating the
 * test. Callers that style a retraction (the sidebars italicise it) still read
 * `message.isRetracted` themselves: that is a presentation choice this shared
 * text derivation has no business making.
 *
 * It stays in the app rather than in the SDK's `formatMessagePreview` because
 * only the app has `t`; the SDK formatter remains localization-free.
 */
export function formatLocalizedPreview(message: PreviewMessage, t: TranslateFn): string {
  if (isSpamModerated(message)) return ''
  if (message.isRetracted) return t('chat.messageDeleted')

  if (message.encryptedPayload) return t(decryptFailureKey(message.securityContext?.failureReason))

  const unsupported = message.unsupportedEncryption
  if (unsupported) {
    return unsupported.name
      ? t('chat.encryption.unsupportedMessage', { method: unsupported.name })
      : t('chat.encryption.unsupportedMessageGeneric')
  }
  return formatMessagePreview(message)
}

/** Shared failure text for message bubbles and compact previews. */
export function decryptFailureKey(reason?: DecryptFailureReason): string {
  switch (reason) {
    case 'key-unavailable': return 'chat.encryption.couldNotDecryptKeyUnavailable'
    case 'signature-invalid': return 'chat.encryption.couldNotDecryptSignature'
    default: return 'chat.encryption.couldNotDecryptUnreadable'
  }
}
