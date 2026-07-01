import { useTranslation } from 'react-i18next'
import { Plus, ChevronDown, Zap, Hash, LogIn, Search, RefreshCw } from 'lucide-react'
import { Tooltip } from '../Tooltip'
import { OverflowMenu, type OverflowMenuItem } from '../OverflowMenu'
import { SIDEBAR_HEADER_ICON_BTN } from './types'

interface RoomsHeaderActionsProps {
  /** Create a Quick Chat (the + primary action). */
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
 * Rooms tab header actions: a split create button (`+` = Quick Chat, `▾` opens a
 * create-menu of all four create/join paths) plus a `⋮` overflow menu for the
 * Catch-up maintenance action.
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
  const overflowItems: OverflowMenuItem[] = [
    { key: 'catchup', label: t('rooms.catchUpAll'), icon: RefreshCw, onClick: onCatchUpAll, disabled: isCatchingUp },
  ]
  return (
    <div className="flex items-center gap-0.5">
      <RoomsCreateSplitButton
        onQuickChat={onQuickChat}
        onPermanentRoom={onPermanentRoom}
        onJoinRoom={onJoinRoom}
        onBrowseRooms={onBrowseRooms}
      />
      <OverflowMenu
        ariaLabel={t('common.options')}
        items={overflowItems}
        buttonClassName={`${SIDEBAR_HEADER_ICON_BTN} text-fluux-muted hover:text-fluux-text`}
      />
    </div>
  )
}

interface RoomsCreateSplitButtonProps {
  onQuickChat: () => void
  onPermanentRoom: () => void
  onJoinRoom: () => void
  onBrowseRooms: () => void
}

/**
 * `+` fires Quick Chat directly; the adjacent `▾` opens a create-menu (built on
 * OverflowMenu via renderTrigger) listing all four create/join paths — Quick
 * Chat included, so the `+` shortcut is discoverable.
 */
function RoomsCreateSplitButton({ onQuickChat, onPermanentRoom, onJoinRoom, onBrowseRooms }: RoomsCreateSplitButtonProps) {
  const { t } = useTranslation()
  const items: OverflowMenuItem[] = [
    { key: 'quickChat', label: t('rooms.quickChat'), icon: Zap, onClick: onQuickChat },
    { key: 'permanentRoom', label: t('rooms.permanentRoom'), icon: Hash, onClick: onPermanentRoom },
    { key: 'joinRoom', label: t('rooms.joinRoom'), icon: LogIn, onClick: onJoinRoom },
    { key: 'browseRooms', label: t('rooms.browseRooms'), icon: Search, onClick: onBrowseRooms },
  ]
  return (
    <OverflowMenu
      ariaLabel={t('rooms.createRoom')}
      items={items}
      renderTrigger={({ isOpen, toggle, close }) => (
        <div className="flex items-center">
          <Tooltip content={t('rooms.createQuickChat')} position="bottom">
            <button
              type="button"
              onClick={() => {
                close()
                onQuickChat()
              }}
              aria-label={t('rooms.createQuickChat')}
              className={`${SIDEBAR_HEADER_ICON_BTN} text-fluux-muted hover:text-fluux-text`}
            >
              <Plus className="size-5" />
            </button>
          </Tooltip>
          <Tooltip content={t('rooms.createRoom')} position="bottom">
            <button
              type="button"
              onClick={toggle}
              aria-label={t('rooms.createRoom')}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              className="-ms-1 p-2 rounded-lg hover:bg-fluux-hover transition-colors text-fluux-muted hover:text-fluux-text flex items-center"
            >
              <ChevronDown className="size-4" />
            </button>
          </Tooltip>
        </div>
      )}
    />
  )
}
