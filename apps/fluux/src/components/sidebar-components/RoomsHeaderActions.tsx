import { useTranslation } from 'react-i18next'
import { Zap, Hash, LogIn, Search, RefreshCw } from 'lucide-react'
import { Tooltip } from '../Tooltip'
import { OverflowMenu, type OverflowMenuItem } from '../OverflowMenu'
import { SIDEBAR_HEADER_ICON_BTN } from './types'

interface RoomsHeaderActionsProps {
  /** Create a Quick Chat — the prominent bolt button. */
  onQuickChat: () => void
  /** Open the Create (permanent) Room modal. */
  onPermanentRoom: () => void
  /** Open the Join Room modal. */
  onJoinRoom: () => void
  /** Open the Browse Rooms modal. */
  onBrowseRooms: () => void
  /** Force a MAM catch-up across all rooms. */
  onCatchUpAll: () => void
  /** Whether a catch-up is currently running (disables the item). */
  isCatchingUp: boolean
}

/**
 * Rooms tab header actions: a Quick Chat bolt button (the fast, casual path)
 * beside a `⋮` overflow menu that groups the remaining room actions — the other
 * create/join paths, then the Catch-up maintenance action below a separator.
 */
export function RoomsHeaderActions({
  onQuickChat,
  onPermanentRoom,
  onJoinRoom,
  onBrowseRooms,
  onCatchUpAll,
  isCatchingUp,
}: RoomsHeaderActionsProps) {
  const { t } = useTranslation()
  const items: OverflowMenuItem[] = [
    { key: 'permanentRoom', label: t('rooms.permanentRoom'), icon: Hash, onClick: onPermanentRoom },
    { key: 'joinRoom', label: t('rooms.joinRoom'), icon: LogIn, onClick: onJoinRoom },
    { key: 'browseRooms', label: t('rooms.browseRooms'), icon: Search, onClick: onBrowseRooms },
    { key: 'catchup', label: t('rooms.catchUpAll'), icon: RefreshCw, onClick: onCatchUpAll, disabled: isCatchingUp, dividerBefore: true },
  ]
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip content={t('rooms.createQuickChat')} position="bottom">
        <button
          type="button"
          onClick={onQuickChat}
          aria-label={t('rooms.createQuickChat')}
          className={`${SIDEBAR_HEADER_ICON_BTN} text-fluux-muted hover:text-fluux-text`}
        >
          <Zap className="size-5" />
        </button>
      </Tooltip>
      <OverflowMenu
        ariaLabel={t('common.options')}
        items={items}
        buttonClassName={`${SIDEBAR_HEADER_ICON_BTN} text-fluux-muted hover:text-fluux-text`}
      />
    </div>
  )
}
