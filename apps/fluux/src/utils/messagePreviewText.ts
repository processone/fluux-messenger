import { formatMessagePreview, type BaseMessage } from '@fluux/sdk'

/** Minimal shape of the i18next `t` we rely on — avoids coupling to its generics. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

type PreviewMessage = Parameters<typeof formatMessagePreview>[0] &
  Pick<BaseMessage, 'unsupportedEncryption'>

/**
 * Localized last-message preview / notification text.
 *
 * Mirrors {@link formatMessagePreview} but substitutes a localized notice for
 * messages whose `<body>` must not be surfaced verbatim. Today that's
 * unsupported-encryption messages: the plaintext fallback body is chosen by the
 * sender's client (e.g. "You received a message encrypted with OMEMO…"), so it
 * reads like a real message in the sidebar, command palette, and notifications.
 * This keeps those surfaces consistent with the in-bubble
 * {@link UnsupportedEncryptionNotice}.
 *
 * Retracted messages stay handled by callers — they also drive italic styling.
 */
export function formatLocalizedPreview(message: PreviewMessage, t: TranslateFn): string {
  const unsupported = message.unsupportedEncryption
  if (unsupported) {
    return unsupported.name
      ? t('chat.encryption.unsupportedMessage', { method: unsupported.name })
      : t('chat.encryption.unsupportedMessageGeneric')
  }
  return formatMessagePreview(message)
}
