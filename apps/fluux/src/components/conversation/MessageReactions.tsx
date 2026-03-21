import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip } from '../Tooltip'

export interface MessageReactionsProps {
  /** Reactions map: emoji -> list of reactor identifiers */
  reactions: Record<string, string[]>
  /** Emojis the current user has reacted with */
  myReactions: string[]
  /** Handler for toggling a reaction. When undefined, reactions are read-only. */
  onReaction?: (emoji: string) => void
  /** Function to get display name for a reactor identifier */
  getReactorName: (reactorId: string) => string
  /** Whether the message is retracted (hides reactions) */
  isRetracted?: boolean
}

/**
 * Displays message reactions as clickable pills.
 * Each pill shows the emoji and count, highlighted if user has reacted.
 * Clicking toggles the user's reaction.
 */
export const MessageReactions = memo(function MessageReactions({
  reactions,
  myReactions,
  onReaction,
  getReactorName,
  isRetracted,
}: MessageReactionsProps) {
  const { t } = useTranslation()
  // Don't show reactions for retracted messages or if no reactions
  const hasReactions = reactions && Object.keys(reactions).length > 0
  if (isRetracted || !hasReactions) {
    return null
  }

  const MAX_INLINE = 9
  const MAX_OVERFLOW = 9

  // Sort reactions by count (descending), then split into visible and overflow
  const sorted = useMemo(() =>
    Object.entries(reactions).sort((a, b) => b[1].length - a[1].length),
    [reactions]
  )
  const visible = sorted.slice(0, MAX_INLINE)
  const overflow = sorted.slice(MAX_INLINE, MAX_INLINE + MAX_OVERFLOW)

  const formatTooltip = (reactors: string[]) => {
    const MAX_SHOWN = 9
    const names = reactors.map(getReactorName)
    if (names.length <= MAX_SHOWN) return names.join(', ')
    return names.slice(0, MAX_SHOWN).join(', ') + ' + ' + t('chat.reactionOthers', { count: names.length - MAX_SHOWN })
  }

  return (
    <div className="flex items-center gap-1 pt-1 flex-wrap select-none">
      {visible.map(([emoji, reactors]) => (
        <Tooltip
          key={emoji}
          content={formatTooltip(reactors)}
          position="top"
          delay={300}
        >
          <button
            onClick={onReaction ? () => onReaction(emoji) : undefined}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs
                       border transition-colors ${
                         myReactions.includes(emoji)
                           ? 'bg-fluux-brand/20 border-fluux-brand'
                           : 'bg-fluux-surface border-fluux-border hover:bg-fluux-hover'
                       } ${!onReaction ? 'cursor-default' : ''}`}
          >
            <span>{emoji}</span>
            <span className="text-fluux-muted">{reactors.length}</span>
          </button>
        </Tooltip>
      ))}
      {overflow.length > 0 && (
        <Tooltip
          content={
            <div className="flex flex-col gap-1">
              {overflow.map(([emoji, reactors]) => (
                <span key={emoji} className="text-xs">
                  {emoji} {reactors.length}
                </span>
              ))}
            </div>
          }
          position="top"
          delay={300}
        >
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs bg-fluux-muted/20 text-fluux-muted cursor-default">
            +{overflow.length}
          </span>
        </Tooltip>
      )}
    </div>
  )
})
