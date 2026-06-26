import type { Message, RoomMessage } from '../core/types'

/**
 * Whether a persisted message has anything to display.
 *
 * Historically a body-less stanza (a stray XEP-0333 chat marker, or a message
 * whose `<body>` was entirely a XEP-0428 fallback) could be stored with an
 * empty body and no other payload — it then rendered as a blank bubble (the
 * "empty Cynthia row" reported from the XSF room). New writes are blocked at
 * parse time by `hasRenderableContent`; this predicate is the read-side
 * complement: cache reads skip any such rows already on disk so the stale
 * artifact disappears (and never seeds a catch-up cursor as the newest row).
 *
 * A message still renders with an empty body when it is a retraction tombstone,
 * carries an attachment or poll, or holds encrypted content shown as a
 * placeholder — those are all kept.
 */
export function isRenderableStoredMessage(message: Message | RoomMessage): boolean {
  return (
    (typeof message.body === 'string' && message.body.trim().length > 0) ||
    message.attachment != null ||
    message.poll != null ||
    message.pollClosed != null ||
    message.isRetracted === true ||
    message.encryptedPayload != null ||
    message.unsupportedEncryption != null
  )
}
