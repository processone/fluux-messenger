import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useReactionMentionStore } from '@/stores/reactionMentionStore'

interface ReactionMentionsProps {
  conversationId: string
  /**
   * Jump to the reacted message. The parent sets the active conversation's / room's
   * `targetMessageId`, which drives the message list's load-around-by-id + scroll —
   * the same path search uses. This works even when the target has scrolled out of the
   * loaded window, unlike a DOM query (#923).
   */
  onSee: (messageId: string) => void
}

export function ReactionMentions({ conversationId, onSee }: ReactionMentionsProps) {
  const { t } = useTranslation()
  const mentions = useReactionMentionStore((s) => s.mentions.get(conversationId))
  const dismissMention = useReactionMentionStore((s) => s.dismissMention)

  if (!mentions || mentions.length === 0) return null

  return (
    <div className="px-3 pb-1 space-y-1">
      {mentions.map((m) => (
        <div key={m.id} className="mx-auto max-w-md flex items-center justify-center gap-2 text-xs text-fluux-muted bg-fluux-hover/60 rounded-full px-3 py-1">
          <span className="truncate">{t('reactions.mention', { name: m.reactorName, emoji: m.emoji, preview: m.preview })}</span>
          <button onClick={() => onSee(m.messageId)} className="font-medium text-fluux-brand hover:underline flex-shrink-0">
            {t('reactions.see')}
          </button>
          <button onClick={() => dismissMention(conversationId, m.id)} aria-label={t('common.dismiss')} className="text-fluux-muted hover:text-fluux-text flex-shrink-0">
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
