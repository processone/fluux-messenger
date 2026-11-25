import { useCallback, useRef, memo, Suspense, lazy, useState, useEffect } from 'react'
import { useFloatingLayerBounds } from '@/hooks/useFloatingLayerBounds'
import { useCloseOnEscape } from '@/hooks/useCloseOnEscape'
import { useTranslation } from 'react-i18next'
import { SmilePlus, Pencil, Forward, MoreHorizontal, Reply, Trash2, Link2, BookmarkPlus, BookmarkMinus } from 'lucide-react'
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
  /** Keep displayed action slots fixed during a deliberate interaction. */
  interactionHeld?: boolean
  /** Handler for reaction button clicks. When undefined, reaction UI is hidden. */
  onReaction?: (emoji: string) => void
  /** Handler for reply button click */
  onReply: () => void
  /** Handler for edit button click */
  onEdit: () => void
  /** Handler for delete button click */
  onDelete: () => void
  /** Available only for a confirmed public message in an archived room. */
  onCopyMessageLink?: () => void
  /** Save the message to, or remove it from, the saved messages. Undefined when it cannot be saved. */
  onToggleSaved?: () => void
  isSaved?: boolean
  /** Keep the floating toolbar clear of the row's separate bookmark target. */
  hasTrailingAction?: boolean
  /** Shares only the room message link with a chosen chat. */
  onForward?: () => void
  /** Emojis the current user has already reacted with */
  myReactions: string[]
  /** Whether the reply button should be shown */
  canReply: boolean
  /** Whether the edit button should be shown */
  canEdit: boolean
  /** Whether deletion is permitted (independent of copying a message link). */
  canDelete: boolean
  /** Whether toolbar is visible (handles hiding during composition) */
  isHidden: boolean
  /** Whether selected via keyboard (affects visibility logic) */
  isSelected: boolean
  /** Whether any keyboard selection is active */
  hasKeyboardSelection: boolean
  /** Whether toolbar should be shown for keyboard selection */
  showToolbarForSelection: boolean
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
  onCopyMessageLink,
  onToggleSaved,
  isSaved = false,
  hasTrailingAction = false,
  onForward,
  myReactions,
  canReply,
  canEdit,
  canDelete,
  isHidden,
  isSelected,
  hasKeyboardSelection,
  showToolbarForSelection,
  showReactionPicker,
  setShowReactionPicker,
  showMoreMenu,
  setShowMoreMenu,
  isHovered,
  onToolbarMouseEnter,
  interactionHeld = false,
}: MessageToolbarProps) {
  const { t } = useTranslation()
  const [actionFocused, setActionFocused] = useState(false)
  const [pointerPressed, setPointerPressed] = useState(false)
  const pressedPointerId = useRef<number | null>(null)
  // A pressed control must stay visible when layout moves it away from a stationary pointer.
  useEffect(() => {
    if (!pointerPressed) return
    let releaseTimer: ReturnType<typeof setTimeout> | undefined
    const clear = () => { pressedPointerId.current = null; setPointerPressed(false) }
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId === pressedPointerId.current) clear()
    }
    const afterMouseUp = () => { releaseTimer = setTimeout(clear, 0) }
    document.addEventListener('mouseup', afterMouseUp, true)
    // Departure can release capture before cancellation, leaving the event outside this toolbar.
    document.addEventListener('pointercancel', onPointerCancel, true)
    window.addEventListener('blur', clear)
    return () => {
      clearTimeout(releaseTimer)
      document.removeEventListener('mouseup', afterMouseUp, true)
      document.removeEventListener('pointercancel', onPointerCancel, true)
      window.removeEventListener('blur', clear)
    }
  }, [pointerPressed])
  const keyboardFocus = useRef(true)
  const updateActionFocus = (target: EventTarget | null) => {
    setActionFocused(keyboardFocus.current && target instanceof Element && target.matches(':focus-visible'))
  }
  const slotsRef = useRef({ reactions: !!onReaction, reply: canReply, edit: canEdit, delete: canDelete, copy: !!onCopyMessageLink, save: !!onToggleSaved })
  if (!interactionHeld) slotsRef.current = { reactions: !!onReaction, reply: canReply, edit: canEdit, delete: canDelete, copy: !!onCopyMessageLink, save: !!onToggleSaved }
  const slots = slotsRef.current
  const canOpenMore = (slots.delete && canDelete) || (slots.copy && !!onCopyMessageLink) || (slots.save && !!onToggleSaved)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const reactionButtonRef = useRef<HTMLButtonElement>(null)
  const pickerDropUpRef = useRef(false)
  const heldPickerBoundsRef = useRef<{ dropUp: boolean; maxHeight: number } | null>(null)
  const heldPickerBounds = interactionHeld ? heldPickerBoundsRef.current : null
  const moreMenuDropUpRef = useRef(false)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const morePanelRef = useRef<HTMLDivElement>(null)
  useFloatingLayerBounds(morePanelRef, showMoreMenu)

  // Close reaction picker
  const closeReactionPicker = () => setShowReactionPicker(false)
  useClickOutside(toolbarRef, closeReactionPicker, showReactionPicker)

  // Close more menu
  const closeMoreMenu = () => setShowMoreMenu(false)
  useClickOutside(moreMenuRef, closeMoreMenu, showMoreMenu)
  useCloseOnEscape(() => {
    keyboardFocus.current = true
    setShowMoreMenu(false)
    moreButtonRef.current?.focus({ preventScroll: true })
    updateActionFocus(moreButtonRef.current)
  }, showMoreMenu)

  // Reaction burst state
  const [burst, setBurst] = useState<{ x: number; y: number } | null>(null)
  const clearBurst = useCallback(() => setBurst(null), [])

  // Handle reaction click - close picker and notify parent
  const handleReaction = (emoji: string) => {
    if (!onReaction) return
    onReaction(emoji)
    setShowReactionPicker(false)
    if (showReactionPicker) reactionButtonRef.current?.focus({ preventScroll: true })
  }

  // Handle delete click - close menu and notify parent
  const handleDelete = () => {
    if (!canDelete) return
    onDelete()
    setShowMoreMenu(false)
  }

  // Calculate visibility state
  // When isHovered is provided (controlled mode), use it instead of CSS hover
  // Uses translate + opacity for a slide-in-from-right effect
  const useControlledHover = isHovered !== undefined
  const visibility: 'visible' | 'hidden' | 'css' = isHidden
    ? 'hidden'
    : pointerPressed || actionFocused || showReactionPicker || showMoreMenu || (isSelected && showToolbarForSelection)
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
    // Anchor to the full message row so density, dividers, and whisper spacing
    // cannot open a pointer gap. The visible bar overlaps the row's top edge;
    // the surrounding padding stays inert so underlying text remains selectable.
    <div
      data-message-toolbar
      onPointerDownCapture={event => {
        if (event.button === 0 && event.isPrimary) pressedPointerId.current = event.pointerId
      }}
      onMouseDownCapture={event => {
        setPointerPressed(event.button === 0)
        keyboardFocus.current = false
        setActionFocused(false)
      }}
      onClickCapture={() => setPointerPressed(false)}
      onKeyDownCapture={event => { keyboardFocus.current = true; updateActionFocus(event.target) }}
      onKeyUpCapture={() => updateActionFocus(document.activeElement)}
      onFocusCapture={event => updateActionFocus(event.target)}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setActionFocused(false)
      }}
      className={`hidden can-hover:block absolute -top-12 ${hasTrailingAction ? 'end-10' : 'end-2'} p-4 z-20 select-none pointer-events-none transition-all duration-200 ease-out ${visibilityClass}`}
    >
      {/* Visible toolbar. The p-0.5 inset keeps each control's square hover/active
          fill (hover:bg-fluux-hover, reacted fluux-accent-tint) clear of the
          rounded-md corners — without it, an end button's fill pokes past the
          popover's rounded border. Clipping via overflow-hidden isn't an option
          here because the reaction picker and more-menu dropdowns overflow the bar. */}
      <div
        ref={toolbarRef}
        className={`flex items-center p-0.5 fluux-popover rounded-md ${interactivityClass}`}
        onMouseEnter={onToolbarMouseEnter}
      >
      {/* Quick reaction emojis (hidden when reactions are disabled) */}
      {slots.reactions && TOOLBAR_REACTIONS.map(emoji => (
        <button
          type="button"
          key={emoji}
          disabled={!onReaction}
          onClick={(e: React.MouseEvent) => {
            if (onReaction && !myReactions.includes(emoji)) {
              const rect = e.currentTarget.getBoundingClientRect()
              setBurst({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
            }
            handleReaction(emoji)
          }}
          // leading-none collapses the emoji's line box to its em square so the
          // glyph sits centered in the hover/active fill; the default text-base
          // line-height (1.5) adds leading that rides the emoji high in the pill.
          className={`px-2 py-1.5 leading-none transition-colors text-base ${
            showReactionPicker || showMoreMenu ? '' : 'hover:bg-fluux-hover'
          } ${myReactions.includes(emoji) ? 'fluux-accent-tint' : ''}`}
          aria-label={t('chat.reactWith', { emoji })}
        >
          {emoji}
        </button>
      ))}

      {/* Divider (hidden when reactions are disabled) */}
      {slots.reactions && <div className="w-px h-5 bg-fluux-hover" />}

      {/* More reactions button (hidden when reactions are disabled) */}
      {slots.reactions && (
      <div className="relative">
        <button
          type="button"
          ref={reactionButtonRef}
          disabled={!onReaction}
          onClick={() => {
            if (!showReactionPicker && reactionButtonRef.current) {
              // Compute direction synchronously before opening to avoid position jump
              const rect = reactionButtonRef.current.getBoundingClientRect()
              const spaceBelow = window.innerHeight - rect.bottom
              pickerDropUpRef.current = spaceBelow < 450
              const list = reactionButtonRef.current.closest('[data-message-list]')?.getBoundingClientRect()
              if (list) {
                const above = Math.max(0, rect.top - Math.max(0, list.top) - 12)
                const below = Math.max(0, Math.min(window.innerHeight, list.bottom) - rect.bottom - 12)
                const dropUp = below < 450 && above > below
                // Capture once: arrivals/typing cannot resize the menu under the pointer.
                heldPickerBoundsRef.current = { dropUp, maxHeight: dropUp ? above : below }
              }
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
          <div data-message-panel="reactions" className={`absolute end-0 z-30 ${(heldPickerBounds?.dropUp ?? pickerDropUpRef.current) ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
            <Suspense fallback={null}>
              <EmojiPicker
                maxHeight={heldPickerBounds?.maxHeight}
                onSelect={(emoji) => handleReaction(emoji)}
                onClose={() => {
                  keyboardFocus.current = true
                  setShowReactionPicker(false)
                  reactionButtonRef.current?.focus({ preventScroll: true })
                  updateActionFocus(reactionButtonRef.current)
                }}
              />
            </Suspense>
          </div>
        )}
      </div>
      )}

      {/* Reply button - hidden for last message */}
      {slots.reply && (
        <Tooltip content={t('chat.reply')} position="top" disabled={showReactionPicker || showMoreMenu}>
          <button
            type="button"
            disabled={!canReply}
            onClick={() => { if (canReply) onReply() }}
            className={`p-1.5 transition-colors ${showReactionPicker || showMoreMenu ? '' : 'hover:bg-fluux-hover'}`}
            aria-label={t('chat.reply')}
          >
            <Reply className="rtl-mirror size-4 text-fluux-muted" />
          </button>
        </Tooltip>
      )}

      {/* Edit button - only for last outgoing message */}
      {slots.edit && (
        <Tooltip content={t('chat.editMessage')} position="top" disabled={showReactionPicker || showMoreMenu}>
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => { if (canEdit) onEdit() }}
            className={`p-1.5 transition-colors ${showReactionPicker || showMoreMenu ? '' : 'hover:bg-fluux-hover'}`}
            aria-label={t('chat.editMessage')}
          >
            <Pencil className="size-4 text-fluux-muted" />
          </button>
        </Tooltip>
      )}

      {/* Forward shares the room message link; a one-to-one message has none, so it shares its content. */}
      <Tooltip content={t(onForward ? 'chat.forwardMessageLink' : 'chat.forwardMessage')} position="top" disabled={showReactionPicker || showMoreMenu}>
        <button
          type="button"
          className={`p-1.5 transition-colors ${!onForward ? 'opacity-50 cursor-not-allowed' : ''} ${showReactionPicker || showMoreMenu ? '' : 'hover:bg-fluux-hover'}`}
          aria-label={t(onForward ? 'chat.forwardMessageLink' : 'chat.forwardMessage')}
          disabled={!onForward}
          onClick={onForward}
        >
          <Forward className="rtl-mirror size-4 text-fluux-muted" />
        </button>
      </Tooltip>

      {/* More options button with dropdown */}
      <div className="inline-flex relative" ref={moreMenuRef}>
        <Tooltip content={t('chat.moreOptions')} position="top" disabled={showReactionPicker || showMoreMenu}>
          <button
            type="button"
            ref={moreButtonRef}
            onClick={() => {
              if (!showMoreMenu && moreButtonRef.current) {
                const rect = moreButtonRef.current.getBoundingClientRect()
                const spaceBelow = window.innerHeight - rect.bottom
                moreMenuDropUpRef.current = spaceBelow < 100
              }
              setShowMoreMenu(!showMoreMenu)
            }}
            className={`p-1.5 transition-colors ${showReactionPicker || showMoreMenu ? '' : 'hover:bg-fluux-hover'} ${!canOpenMore ? 'opacity-50 cursor-not-allowed' : ''}`}
            aria-label={t('chat.moreOptions')}
            disabled={!canOpenMore}
          >
            <MoreHorizontal className="size-4 text-fluux-muted" />
          </button>
        </Tooltip>

        {/* More options dropdown menu */}
        {showMoreMenu && (slots.delete || slots.copy || slots.save) && (
          <div ref={morePanelRef} data-message-panel="more" className={`absolute end-0 ${slots.copy || slots.save ? 'min-w-[224px]' : 'min-w-[160px]'} fluux-popover rounded-lg z-30 overflow-hidden ${moreMenuDropUpRef.current ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
            {slots.save && (
              <button
                type="button"
                disabled={!onToggleSaved}
                onClick={() => { onToggleSaved?.(); setShowMoreMenu(false) }}
                className="focus-ring-inset w-full px-3 py-2 text-sm text-start hover:bg-fluux-hover transition-colors flex items-center gap-2"
              >
                {isSaved ? <BookmarkMinus className="size-4" /> : <BookmarkPlus className="size-4" />}
                {isSaved ? t('chat.removeFromSaved') : t('chat.saveMessage')}
              </button>
            )}
            {slots.copy && (
              <button
                type="button"
                disabled={!onCopyMessageLink}
                onClick={() => { onCopyMessageLink?.(); setShowMoreMenu(false) }}
                className="focus-ring-inset w-full px-3 py-2 text-sm text-start hover:bg-fluux-hover transition-colors flex items-center gap-2"
              >
                <Link2 className="size-4" />
                {t('chat.copyMessageLink')}
              </button>
            )}
            {slots.delete && <button
              type="button"
              onClick={handleDelete}
              disabled={!canDelete}
              className="focus-ring-inset w-full px-3 py-2 text-sm text-start text-red-500 hover:bg-fluux-hover transition-colors flex items-center gap-2"
            >
              <Trash2 className="size-4" />
              {t('chat.deleteMessage')}
            </button>}
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
