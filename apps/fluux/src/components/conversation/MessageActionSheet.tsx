/**
 * Touch action sheet for a single message.
 *
 * Long-pressing a message bubble on a touch device opens this bottom sheet — the
 * touch counterpart of the desktop hover toolbar (MessageToolbar), which can't be
 * reached without a pointer. It reuses the same building blocks as the rest of the
 * app: BottomSheet for the surface, TOOLBAR_REACTIONS + the lazy EmojiPicker for
 * reactions, and MenuButton/MenuDivider for the action rows (at a comfortable
 * touch height).
 */
import { useState, Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import { Reply, Pencil, Trash2, Copy, SmilePlus } from 'lucide-react'
import { BottomSheet } from '../ui/BottomSheet'
import { MenuButton, MenuDivider } from '../sidebar-components/SidebarListMenu'
import { TOOLBAR_REACTIONS } from './MessageToolbar'

// Lazy-load the emoji picker — only fetched when the user opens "more reactions".
const EmojiPicker = lazy(() => import('../EmojiPicker').then((m) => ({ default: m.EmojiPicker })))

export interface MessageActionSheetProps {
  open: boolean
  onClose: () => void
  /** Reaction handler. When undefined, the room lacks stable identity so the reaction row is hidden. */
  onReaction?: (emoji: string) => void
  /** Emojis the current user has already reacted with (for highlighting). */
  myReactions: string[]
  /** Raw message body for the copy action; empty/undefined hides Copy. */
  body?: string
  onReply: () => void
  onEdit: () => void
  onDelete: () => void | Promise<void>
  canReply: boolean
  canEdit: boolean
  canDelete: boolean
}

export function MessageActionSheet({
  open,
  onClose,
  onReaction,
  myReactions,
  body,
  onReply,
  onEdit,
  onDelete,
  canReply,
  canEdit,
  canDelete,
}: MessageActionSheetProps) {
  const { t } = useTranslation()
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)

  // Always reset the inner picker on close so the sheet reopens on the actions view.
  const close = () => {
    setShowEmojiPicker(false)
    onClose()
  }

  const react = (emoji: string) => {
    onReaction?.(emoji)
    close()
  }

  const runAction = (fn: () => void | Promise<void>) => {
    close()
    void fn()
  }

  const copyBody = () => {
    if (body) void navigator.clipboard?.writeText(body).catch(() => {})
    close()
  }

  const canCopy = !!body

  return (
    <BottomSheet open={open} onClose={close} ariaLabel={t('chat.moreOptions')}>
      {showEmojiPicker ? (
        <div className="flex justify-center px-2 pb-2">
          <Suspense fallback={null}>
            <EmojiPicker onSelect={react} onClose={() => setShowEmojiPicker(false)} />
          </Suspense>
        </div>
      ) : (
        <>
          {/* Quick reactions (hidden when reactions are disabled for this room) */}
          {onReaction && (
            <>
              <div className="flex items-center gap-1 px-2 pb-1">
                {TOOLBAR_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => react(emoji)}
                    className={`flex h-12 flex-1 items-center justify-center rounded-lg text-2xl transition-colors hover:bg-fluux-hover ${
                      myReactions.includes(emoji) ? 'bg-fluux-brand/20' : ''
                    }`}
                    aria-label={t('chat.reactWith', { emoji })}
                  >
                    {emoji}
                  </button>
                ))}
                <button
                  onClick={() => setShowEmojiPicker(true)}
                  className="flex h-12 flex-1 items-center justify-center rounded-lg transition-colors hover:bg-fluux-hover"
                  aria-label={t('chat.moreReactions')}
                >
                  <SmilePlus className="size-6 text-fluux-muted" />
                </button>
              </div>
              <MenuDivider />
            </>
          )}

          {/* Action rows — py-3 gives a comfortable >=44px touch target */}
          <div className="pb-1">
            {canReply && (
              <MenuButton
                onClick={() => runAction(onReply)}
                icon={<Reply className="rtl-mirror size-5" />}
                label={t('chat.reply')}
                className="py-3"
              />
            )}
            {canCopy && (
              <MenuButton
                onClick={copyBody}
                icon={<Copy className="size-5" />}
                label={t('chat.copyMessage')}
                className="py-3"
              />
            )}
            {canEdit && (
              <MenuButton
                onClick={() => runAction(onEdit)}
                icon={<Pencil className="size-5" />}
                label={t('chat.editMessage')}
                className="py-3"
              />
            )}
            {canDelete && (
              <MenuButton
                onClick={() => runAction(onDelete)}
                icon={<Trash2 className="size-5" />}
                label={t('chat.deleteMessage')}
                variant="danger"
                className="py-3"
              />
            )}
          </div>
        </>
      )}
    </BottomSheet>
  )
}
