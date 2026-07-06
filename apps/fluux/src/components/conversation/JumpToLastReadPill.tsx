import { useTranslation } from 'react-i18next'

interface JumpToLastReadPillProps {
  visible: boolean
  /** Messages after the divider when known; 0 = unknown (deep/degraded). */
  count: number
  onJump: () => void
}

/**
 * Secondary catch-up affordance (spec §2): shown while the "New messages"
 * divider sits above the viewport, so the reading position stays one click
 * away after a jump-to-present. Styling mirrors FloatingDateHeader's pill.
 */
export function JumpToLastReadPill({ visible, count, onJump }: JumpToLastReadPillProps) {
  const { t } = useTranslation()
  if (!visible) return null
  return (
    <div data-jump-to-last-read className="absolute top-3 inset-x-0 z-30 flex justify-center pointer-events-none">
      <button
        type="button"
        onClick={onJump}
        title={t('chat.jumpToLastRead')}
        className="pointer-events-auto px-3 py-1 rounded-full bg-fluux-float border border-fluux-border shadow-lg text-xs font-medium text-fluux-muted whitespace-nowrap hover:text-fluux-text"
      >
        {count > 0 ? t('chat.newMessagesCount', { count }) : t('chat.youWereAway')}
      </button>
    </div>
  )
}
