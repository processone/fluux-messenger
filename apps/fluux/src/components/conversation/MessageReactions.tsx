import { iosHaptic } from '@/platform/ios/haptics'
import { memo, useCallback, useMemo, useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip } from '../Tooltip'
import { ReactionBurst } from './ReactionBurst'

export interface MessageReactionsProps {
  /** Reactions map: emoji -> list of reactor identifiers */
  reactions: Record<string, string[]>
  /** Emojis the current user has reacted with */
  myReactions: string[]
  /** Handler for toggling a reaction. When undefined, reactions are read-only. */
  onReaction?: (emoji: string) => void
  /** Function to get display name for a reactor identifier */
  getReactorName: (reactorId: string) => string
  /** Opens the reactor list on the held emoji. */
  onShowReactors?: (emoji: string) => void
  /** Whether the message is retracted (hides reactions) */
  isRetracted?: boolean
}

export const MessageReactions = memo(function MessageReactions({
  reactions,
  myReactions,
  onReaction,
  getReactorName,
  onShowReactors,
  isRetracted,
}: MessageReactionsProps) {
  const { t } = useTranslation()
  const MAX_INLINE = 9
  const MAX_OVERFLOW = 9
  const [burst, setBurst] = useState<{ x: number; y: number } | null>(null)
  const clearBurst = useCallback(() => setBurst(null), [])

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdTarget = useRef<{ chip: HTMLElement; emoji: string } | null>(null)
  const holdFired = useRef(false)
  const cancelHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current)
    holdTimer.current = null
    holdTarget.current = null
  }, [])
  useEffect(() => cancelHold, [cancelHold])
  useEffect(() => {
    const hold = holdTarget.current
    if (hold && (isRetracted || !onShowReactors || !hold.chip.isConnected || hold.chip.dataset.reactionEmoji !== hold.emoji || !reactions[hold.emoji]?.length)) cancelHold()
  }, [reactions, isRetracted, onShowReactors, cancelHold])

  // Don't show reactions for retracted messages or if no reactions
  const hasReactions = Object.values(reactions).some((reactors) => reactors.length > 0)

  // Sort reactions by count (descending), then split into visible and overflow
  const sorted = useMemo(() =>
    hasReactions
      ? Object.entries(reactions).filter(([, reactors]) => reactors.length > 0).sort((a, b) => b[1].length - a[1].length)
      : [],
    [reactions, hasReactions]
  )

  if (isRetracted || !hasReactions) {
    return null
  }

  const visible = sorted.slice(0, MAX_INLINE)
  const overflow = sorted.slice(MAX_INLINE, MAX_INLINE + MAX_OVERFLOW)

  const formatTooltip = (reactors: string[]) => {
    const MAX_SHOWN = 9
    const names = reactors.map(getReactorName)
    if (names.length <= MAX_SHOWN) return names.join(', ')
    return names.slice(0, MAX_SHOWN).join(', ') + ' + ' + t('chat.reactionOthers', { count: names.length - MAX_SHOWN })
  }

  return (
    <div
      className="flex items-center gap-1 pt-1 flex-wrap select-none"
      onTouchStart={(event) => {
        event.stopPropagation()
        cancelHold()
        holdFired.current = false
        if (!onShowReactors || event.touches.length > 1) return
        const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-reaction-emoji]')
        const emoji = chip?.dataset.reactionEmoji
        if (!chip || !emoji) return
        const hold = { chip, emoji }
        holdTarget.current = hold
        holdTimer.current = setTimeout(() => {
          if (holdTarget.current !== hold || !chip.isConnected || chip.dataset.reactionEmoji !== emoji) {
            cancelHold()
            return
          }
          cancelHold()
          holdFired.current = true
          chip.focus({ preventScroll: true })
          onShowReactors(emoji)
          iosHaptic('contextMenu')
        }, 500)
      }}
      onTouchEnd={(event) => { event.stopPropagation(); cancelHold() }}
      onTouchMove={(event) => { event.stopPropagation(); cancelHold() }}
      onTouchCancel={(event) => { event.stopPropagation(); cancelHold() }}
      onContextMenu={(event) => { if (holdFired.current) event.preventDefault() }}
      onClickCapture={(event) => {
        // A touch hold can synthesize a click on release; viewing reactors must not toggle a reaction.
        if (holdFired.current) {
          event.preventDefault()
          event.stopPropagation()
          holdFired.current = false
        }
      }}
    >
      {visible.map(([emoji, reactors]) => (
        <Tooltip
          key={emoji}
          content={formatTooltip(reactors)}
          position="top"
          delay={300}
        >
          <button
            type="button"
            data-reaction-emoji={emoji}
            onClick={onReaction ? (e: React.MouseEvent) => {
              // Burst only when adding a reaction, not removing
              if (!myReactions.includes(emoji)) {
                const rect = e.currentTarget.getBoundingClientRect()
                setBurst({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
              }
              onReaction(emoji)
            } : undefined}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 touch:px-2.5 touch:py-1.5 rounded-full text-xs
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
          <button
            type="button"
            data-reaction-emoji={overflow[0][0]}
            aria-label={t('chat.reactions')}
            className="inline-flex items-center px-1.5 py-0.5 touch:px-2.5 touch:py-1.5 rounded-full text-xs bg-fluux-muted/20 text-fluux-muted"
          >
            +{overflow.length}
          </button>
        </Tooltip>
      )}
      {burst && <ReactionBurst x={burst.x} y={burst.y} onDone={clearBurst} />}
    </div>
  )
})
