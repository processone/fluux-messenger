import { useCallback, useRef, memo, Suspense, lazy, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SmilePlus, Pencil, Forward, MoreHorizontal, Reply, Trash2 } from 'lucide-react'
import { useClickOutside } from '@/hooks'
import { Tooltip } from '../Tooltip'
import { ReactionBurst } from './ReactionBurst'

// Quick reaction emojis shown directly in toolbar (also reused by the touch
// MessageActionSheet so both surfaces offer the same quick reactions).
export const TOOLBAR_REACTIONS = ['👍', '❤️', '😂']

// Lazy-load emoji picker — only fetched when user opens reaction picker
const emojiPickerImport = () => import('../EmojiPicker').then(m => ({ default: m.EmojiPicker }))
const EmojiPicker = lazy(emojiPickerImport)

export interface MessageToolbarProps {
  /** Handler for reaction button clicks. When undefined, reaction UI is hidden. */
  onReaction?: (emoji: string) => void
  /** Handler for reply button click */
  onReply: () => void
  /** Handler for edit button click */
  onEdit: () => void
  /** Handler for delete button click */
  onDelete: () => void
  /** Emojis the current user has already reacted with */
  myReactions: string[]
  /** Whether the reply button should be shown */
  canReply: boolean
  /** Whether the edit button should be shown */
  canEdit: boolean
  /** Whether the delete/more options should be enabled */
  canDelete: boolean
  /** Whether toolbar is visible (handles hiding during composition) */
  isHidden: boolean
  /** Whether selected via keyboard (affects visibility logic) */
  isSelected: boolean
  /** Whether any keyboard selection is active */
  hasKeyboardSelection: boolean
  /** Whether toolbar should be shown for keyboard selection */
  showToolbarForSelection: boolean
  /** Whether the message shows an avatar (affects positioning) */
  showAvatar: boolean
  /** Whether reaction picker is open (controlled externally for click-outside) */
  showReactionPicker: boolean
  /** Setter for reaction picker state */
  setShowReactionPicker: (show: boolean) => void
  /** Whether more menu is open (controlled externally for click-outside) */
  showMoreMenu: boolean
  /** Setter for more menu state */
  setShowMoreMenu: (show: boolean) => void
  /** Whether message is hovered (controlled by parent for stable interaction) */
  isHovered?: boolean
  /** Called when mouse enters toolbar to keep message hovered */
  onToolbarMouseEnter?: () => void
}

/**
 * Floating action toolbar for messages.
 * Shows reaction emojis, reply, edit, forward, and more options.
 * Appears on hover or when message is keyboard-selected.
 */
export const MessageToolbar = memo(function MessageToolbar({
  onReaction,
  onReply,
  onEdit,
  onDelete,
  myReactions,
  canReply,
  canEdit,
  canDelete,
  isHidden,
  isSelected,
  hasKeyboardSelection,
  showToolbarForSelection,
  showAvatar,
  showReactionPicker,
  setShowReactionPicker,
  showMoreMenu,
  setShowMoreMenu,
  isHovered,
  onToolbarMouseEnter,
}: MessageToolbarProps) {
  const { t } = useTranslation()
  const toolbarRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const reactionButtonRef = useRef<HTMLButtonElement>(null)
  const pickerDropUpRef = useRef(false)
  const moreMenuDropUpRef = useRef(false)
  const moreButtonRef = useRef<HTMLButtonElement>(null)

  // Close reaction picker
  const closeReactionPicker = () => setShowReactionPicker(false)
  useClickOutside(toolbarRef, closeReactionPicker, showReactionPicker)

  // Close more menu
  const closeMoreMenu = () => setShowMoreMenu(false)
  useClickOutside(moreMenuRef, closeMoreMenu, showMoreMenu)

  // Reaction burst state
  const [burst, setBurst] = useState<{ x: number; y: number } | null>(null)
  const clearBurst = useCallback(() => setBurst(null), [])

  // Handle reaction click - close picker and notify parent
  const handleReaction = onReaction ? (emoji: string) => {
    onReaction(emoji)
    setShowReactionPicker(false)
  } : undefined

  // Handle delete click - close menu and notify parent
  const handleDelete = () => {
    onDelete()
    setShowMoreMenu(false)
  }

  // Calculate visibility state
  // When isHovered is provided (controlled mode), use it instead of CSS hover
  // Uses translate + opacity for a slide-in-from-right effect
  const useControlledHover = isHovered !== undefined
  const visibility: 'visible' | 'hidden' | 'css' = isHidden
    ? 'hidden'
    : showReactionPicker || showMoreMenu || (isSelected && showToolbarForSelection)
      ? 'visible'
      : hasKeyboardSelection
        ? 'hidden'
        : useControlledHover
          ? (isHovered ? 'visible' : 'hidden')
          : 'css'
  const visibilityClass =
    visibility === 'visible'
      ? 'opacity-100 translate-x-0'
      : visibility === 'hidden'
        ? 'opacity-0 translate-x-2'
        : 'opacity-0 translate-x-2 group-hover:opacity-100 group-hover:translate-x-0'
  // The wrapper is permanently pointer-events-none so its padding halo never
  // steals mousedowns from the text underneath; only the visible button bar
  // (and its dropdowns, via inheritance) is interactive.
  const interactivityClass =
    visibility === 'visible'
      ? 'pointer-events-auto'
      : visibility === 'hidden'
        ? ''
        : 'group-hover:pointer-events-auto'

  return (
    // Outer wrapper provides an extended hover zone (padding) around the visible toolbar
    // select-none prevents toolbar from being included in text selection
    <div
      data-message-toolbar
      className={`absolute ${showAvatar ? '-top-7' : '-top-12'} -end-2 p-4 z-20 select-none pointer-events-none transition-all duration-200 ease-out ${visibilityClass}`}
    >
      {/* Visible toolbar */}
      <div
        ref={toolbarRef}
        className={`flex items-center fluux-popover rounded-md ${interactivityClass}`}
        onMouseEnter={onToolbarMouseEnter}
      >
      {/* Quick reaction emojis (hidden when reactions are disabled) */}
      {handleReaction && TOOLBAR_REACTIONS.map(emoji => (
        <button
          key={emoji}
          onClick={(e: React.MouseEvent) => {
            if (!myReactions.includes(emoji)) {
              const rect = e.currentTarget.getBoundingClientRect()
              setBurst({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
            }
            handleReaction(emoji)
          }}
          className={`px-2 py-1.5 transition-colors text-base ${
            showReactionPicker || showMoreMenu ? '' : 'hover:bg-fluux-hover'
          } ${myReactions.includes(emoji) ? 'bg-fluux-brand/20' : ''}`}
          aria-label={t('chat.reactWith', { emoji })}
        >
          {emoji}
        </button>
      ))}

      {/* Divider (hidden when reactions are disabled) */}
      {handleReaction && <div className="w-px h-5 bg-fluux-hover" />}

      {/* More reactions button (hidden when reactions are disabled) */}
      {handleReaction && (
      <div className="relative">
        <button
          ref={reactionButtonRef}
          onClick={() => {
            if (!showReactionPicker && reactionButtonRef.current) {
              // Compute direction synchronously before opening to avoid position jump
              const rect = reactionButtonRef.current.getBoundingClientRect()
              const spaceBelow = window.innerHeight - rect.bottom
              pickerDropUpRef.current = spaceBelow < 450
            }
            setShowReactionPicker(!showReactionPicker)
          }}
          onMouseEnter={() => { void emojiPickerImport() }}
          className={`p-1.5 transition-colors ${showReactionPicker || showMoreMenu ? '' : 'hover:bg-fluux-hover'}`}
          aria-label={t('chat.moreReactions')}
        >
          <SmilePlus className="size-4 text-fluux-muted" />
        </button>

        {/* Full emoji picker for reactions */}
        {showReactionPicker && (
          <div className={`absolute end-0 z-30 ${pickerDropUpRef.current ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
            <Suspense fallback={null}>
              <EmojiPicker
                onSelect={(emoji) => handleReaction(emoji)}
                onClose={() => setShowReactionPicker(false)}
              />
            </Suspense>
          </div>
        )}
      </div>
      )}

      {/* Reply button - hidden for last message */}
      {canReply && (
        <Tooltip content={t('chat.reply')} position="top" disabled={showReactionPicker || showMoreMenu}>
          <button
            onClick={onReply}
            className={`p-1.5 transition-colors ${showReactionPicker || showMoreMenu ? '' : 'hover:bg-fluux-hover'}`}
            aria-label={t('chat.reply')}
          >
            <Reply className="rtl-mirror size-4 text-fluux-muted" />
          </button>
        </Tooltip>
      )}

      {/* Edit button - only for last outgoing message */}
      {canEdit && (
        <Tooltip content={t('chat.editMessage')} position="top" disabled={showReactionPicker || showMoreMenu}>
          <button
            onClick={onEdit}
            className={`p-1.5 transition-colors ${showReactionPicker || showMoreMenu ? '' : 'hover:bg-fluux-hover'}`}
            aria-label={t('chat.editMessage')}
          >
            <Pencil className="size-4 text-fluux-muted" />
          </button>
        </Tooltip>
      )}

      {/* Forward button (placeholder) */}
      <Tooltip content={t('chat.forwardMessage')} position="top" disabled={showReactionPicker || showMoreMenu}>
        <button
          className={`p-1.5 transition-colors opacity-50 cursor-not-allowed ${showReactionPicker || showMoreMenu ? '' : 'hover:bg-fluux-hover'}`}
          aria-label={t('chat.forwardMessage')}
          disabled
        >
          <Forward className="rtl-mirror size-4 text-fluux-muted" />
        </button>
      </Tooltip>

      {/* More options button with dropdown */}
      <div className="inline-flex relative" ref={moreMenuRef}>
        <Tooltip content={t('chat.moreOptions')} position="top" disabled={showReactionPicker || showMoreMenu}>
          <button
            ref={moreButtonRef}
            onClick={() => {
              if (!showMoreMenu && moreButtonRef.current) {
                const rect = moreButtonRef.current.getBoundingClientRect()
                const spaceBelow = window.innerHeight - rect.bottom
                moreMenuDropUpRef.current = spaceBelow < 100
              }
              setShowMoreMenu(!showMoreMenu)
            }}
            className={`p-1.5 transition-colors ${showReactionPicker || showMoreMenu ? '' : 'hover:bg-fluux-hover'} ${!canDelete ? 'opacity-50 cursor-not-allowed' : ''}`}
            aria-label={t('chat.moreOptions')}
            disabled={!canDelete}
          >
            <MoreHorizontal className="size-4 text-fluux-muted" />
          </button>
        </Tooltip>

        {/* More options dropdown menu */}
        {showMoreMenu && canDelete && (
          <div className={`absolute end-0 min-w-[160px] fluux-popover rounded-lg z-30 overflow-hidden ${moreMenuDropUpRef.current ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
            <button
              onClick={handleDelete}
              className="w-full px-3 py-2 text-sm text-start text-red-500 hover:bg-fluux-hover transition-colors flex items-center gap-2"
            >
              <Trash2 className="size-4" />
              {t('chat.deleteMessage')}
            </button>
          </div>
        )}
      </div>
      {/* End more options */}
      </div>
      {/* End visible toolbar */}
      {burst && <ReactionBurst x={burst.x} y={burst.y} onDone={clearBurst} />}
    </div>
  )
})
