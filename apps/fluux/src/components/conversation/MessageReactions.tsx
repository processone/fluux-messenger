import { memo } from 'react'
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
  // Don't show reactions for retracted messages or if no reactions
  const hasReactions = reactions && Object.keys(reactions).length > 0
  if (isRetracted || !hasReactions) {
    return null
  }

  return (
    <div className="flex items-center gap-1 pt-1 flex-wrap select-none">
      {Object.entries(reactions).map(([emoji, reactors]) => (
        <Tooltip
          key={emoji}
          content={reactors.map(getReactorName).join(', ')}
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
    </div>
  )
})
