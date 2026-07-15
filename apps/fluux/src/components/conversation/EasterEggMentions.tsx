import { useTranslation } from 'react-i18next'
import { useEasterEggMentionStore } from '@/stores/easterEggMentionStore'
import { MentionChip } from './MentionChip'

interface EasterEggMentionsProps {
  conversationId: string
  /** Replay the stored animation in the active view (chat or room triggerAnimation). */
  onReplay: (animation: string) => void
}

export function EasterEggMentions({ conversationId, onReplay }: EasterEggMentionsProps) {
  const { t } = useTranslation()
  const egg = useEasterEggMentionStore((s) => s.mentions.get(conversationId))
  const dismiss = useEasterEggMentionStore((s) => s.dismiss)

  if (!egg) return null

  return (
    <div className="px-3 pb-1">
      <MentionChip
        label={t('easterEgg.mention', { name: egg.senderName })}
        actionLabel={t('easterEgg.replay')}
        onAction={() => onReplay(egg.animation)}
        onDismiss={() => dismiss(conversationId)}
      />
    </div>
  )
}
