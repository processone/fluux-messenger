import { useTranslation } from 'react-i18next'
import { Archive, Plus } from 'lucide-react'
import { Tooltip } from '../Tooltip'
import { SIDEBAR_HEADER_ICON_BTN } from './types'

interface MessagesHeaderActionsProps {
  /** Whether the archived-conversations filter is active. */
  showArchived: boolean
  /** Toggle the archived filter. */
  onToggleArchived: () => void
  /** Open the New Message modal. */
  onNewMessage: () => void
}

/**
 * Messages tab header actions: an Archive view-filter toggle (visible, reflects
 * active state) followed by a New Message create button.
 */
export function MessagesHeaderActions({ showArchived, onToggleArchived, onNewMessage }: MessagesHeaderActionsProps) {
  const { t } = useTranslation()
  const archiveLabel = showArchived ? t('messages.showActive') : t('messages.showArchived')
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip content={archiveLabel} position="bottom">
        <button
          type="button"
          onClick={onToggleArchived}
          aria-pressed={showArchived}
          aria-label={archiveLabel}
          className={`${SIDEBAR_HEADER_ICON_BTN} ${showArchived ? 'text-fluux-brand' : 'text-fluux-muted hover:text-fluux-text'}`}
        >
          <Archive className="size-5" />
        </button>
      </Tooltip>
      <Tooltip content={t('newMessage.title')} position="bottom">
        <button
          type="button"
          onClick={onNewMessage}
          aria-label={t('newMessage.title')}
          className={`${SIDEBAR_HEADER_ICON_BTN} text-fluux-muted hover:text-fluux-text`}
        >
          <Plus className="size-5" />
        </button>
      </Tooltip>
    </div>
  )
}
