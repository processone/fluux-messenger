import { useTranslation } from 'react-i18next'
import { useReactionMentionStore } from '@/stores/reactionMentionStore'
import { MentionChip } from './MentionChip'

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
        <MentionChip
          key={m.id}
          label={t('reactions.mention', { name: m.reactorName, emoji: m.emoji, preview: m.preview })}
          actionLabel={t('reactions.see')}
          onAction={() => onSee(m.messageId)}
          onDismiss={() => dismissMention(conversationId, m.id)}
        />
      ))}
    </div>
  )
}
