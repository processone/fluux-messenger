/**
 * copyMessageBody — the single derivation of the text a message contributes to a
 * multi-message clipboard transcript.
 *
 * Shared by every copy path (the 1:1 `ChatView` and MUC `RoomView` store-backed
 * formatters, and the `data-message-body` attribute the mounted-DOM path reads),
 * so a message copies the same way wherever the selection is collected from.
 *
 * Four rules, in order:
 *
 *  1. A retracted message copies the localized "message deleted" notice from
 *     {@link formatLocalizedPreview}, never its text. The store deliberately
 *     preserves `body` through a retraction so the bubble can be replaced in
 *     place; copying that body would put text the sender deleted back into the
 *     clipboard, and a bodiless retraction would drop out of the transcript
 *     entirely.
 *  2. An unsupported-encryption message copies the localized notice from
 *     {@link formatLocalizedPreview}, even when it has a body. That raw body is a
 *     sender-chosen XEP-0380 fallback which the bubble deliberately refuses to
 *     display and the single-message copy action already excludes.
 *  3. Every other message that HAS a body copies that body **verbatim**. A transcript is a
 *     quotation: styling markup and reply-quote prefixes must survive intact, and
 *     {@link formatLocalizedPreview} strips both. Copy output for ordinary text
 *     messages is therefore byte-identical to what it has always been.
 *  4. A message whose text lives OUTSIDE `body` — a poll (`poll.title`), a closed-poll
 *     announcement (`pollClosed.title`), a file-only message (`attachment`) — falls
 *     back to the shared preview formatter, the same one that renders the sidebar,
 *     the command palette and notifications. It yields an emoji plus the title or
 *     filename, so a pasted poll cannot be mistaken for someone having typed that
 *     sentence. Before this, such messages were dropped from the transcript entirely.
 *
 * Whitespace-only bodies and previews are treated as absent. Any other raw body
 * remains verbatim, including markup-only forms such as empty code fences.
 * `buildCopyText` applies the same trim test, so nothing can contribute a blank line.
 */
import { formatLocalizedPreview } from './messagePreviewText'

/** Minimal shape of the i18next `t` we rely on — mirrors messagePreviewText. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/** Any message the preview formatter accepts (chat or room). */
export type CopyableMessage = Parameters<typeof formatLocalizedPreview>[0]

/** Text a message contributes to a copied transcript; '' when it has none. */
export function deriveCopyBody(message: CopyableMessage, t: TranslateFn): string {
  if (message.isRetracted || message.unsupportedEncryption) {
    const preview = formatLocalizedPreview(message, t)
    return preview.trim() ? preview : ''
  }

  const body = message.body
  if (body && body.trim()) return body

  const preview = formatLocalizedPreview(message, t)
  return preview.trim() ? preview : ''
}
