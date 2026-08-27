import { isPreviewableMessage } from '@fluux/sdk'
import { formatLocalizedPreview } from './messagePreviewText'

/** Minimal shape of the i18next `t` we rely on — matches messagePreviewText.ts. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/** Longest quoted preview a reaction notification shows. */
const PREVIEW_MAX_LENGTH = 80

type ReactedMessage = Parameters<typeof formatLocalizedPreview>[0]

/**
 * Quoted text for "X reacted to '…'".
 *
 * Reuses the sidebar's preview derivation ({@link formatLocalizedPreview}) so a
 * bodiless message names itself: a poll quotes its title, a file quotes its
 * name, a retracted message quotes "message deleted", and an
 * unsupported-encryption message quotes a localized notice rather than the
 * sender-chosen plaintext fallback. Reading `body` alone made every one of
 * those collapse to empty quotes.
 *
 * Returns `''` when the message has nothing displayable at all — a bodiless
 * signal placeholder, e.g. an encrypted reaction stored as an empty-body
 * message. Callers must then use {@link formatReactionNotification}, which
 * swaps in a quote-free label.
 */
export function reactionPreviewText(message: ReactedMessage, t: TranslateFn): string {
  if (!isPreviewableMessage(message)) return ''
  return formatLocalizedPreview(message, t).slice(0, PREVIEW_MAX_LENGTH)
}

/**
 * Label for a reaction notification — the toast and the in-flow mention chip
 * share it so the two surfaces cannot drift apart.
 *
 * An empty or whitespace-only `preview` selects a quote-free key: a visually
 * blank quote is never a sensible thing to show.
 */
export function formatReactionNotification(
  t: TranslateFn,
  { name, emoji, preview }: { name: string; emoji: string; preview: string },
): string {
  return preview.trim()
    ? t('reactions.mention', { name, emoji, preview })
    : t('reactions.mentionNoPreview', { name, emoji })
}
