/** Touch actions and quick reactions anchored to the selected message. */
import { useState, Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import { Reply, Pencil, Trash2, Copy, SmilePlus, Link2 } from 'lucide-react'
import { TouchMenu } from '../ui/TouchMenu'
import { SelectedMessagePreview } from './SelectedMessagePreview'
import { MenuButton } from '../sidebar-components/SidebarListMenu'
import { TOOLBAR_REACTIONS } from './MessageToolbar'
import { extractLinks } from '../../utils/messageStyles'
import { copyToClipboard } from '@/utils/clipboard'

// Lazy-load the emoji picker — only fetched when the user opens "more reactions".
const EmojiPicker = lazy(() => import('../EmojiPicker').then((m) => ({ default: m.EmojiPicker })))

export interface MessageActionSheetProps {
  open: boolean
  anchor?: HTMLElement | null
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
  anchor,
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
  const [showLinkPicker, setShowLinkPicker] = useState(false)

  // Always reset the inner picker on close so the menu reopens on the actions view.
  const close = () => {
    setShowEmojiPicker(false)
    setShowLinkPicker(false)
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

  const links = extractLinks(body ?? '')
  const copyLink = (url: string) => {
    void copyToClipboard(url)
    close()
  }
  const onCopyLinkClick = () => {
    if (links.length === 1) copyLink(links[0])
    else setShowLinkPicker(true)
  }

  const reactions = onReaction && !showEmojiPicker && !showLinkPicker ? (
    <div className="flex items-center gap-1 px-2 pb-1">
      {TOOLBAR_REACTIONS.map((emoji) => (
        <button
          type="button"
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
        type="button"
        onClick={() => setShowEmojiPicker(true)}
        className="flex h-12 flex-1 items-center justify-center rounded-lg transition-colors hover:bg-fluux-hover"
        aria-label={t('chat.moreReactions')}
      >
        <SmilePlus className="size-6 text-fluux-muted" />
      </button>
    </div>
  ) : null

  return (
    <TouchMenu
      open={open}
      onClose={close}
      anchor={anchor}
      expanded={showEmojiPicker}
      reactions={reactions}
      preview={<SelectedMessagePreview source={anchor} body={body} />}
      ariaLabel={t('chat.moreOptions')}
    >
      {showLinkPicker ? (
        <div className="pb-1">
          <div className="px-3 py-2 text-sm text-fluux-muted">{t('chat.copyLinkChoose')}</div>
          {links.map((url) => (
            <MenuButton
              key={url}
              onClick={() => copyLink(url)}
              icon={<Link2 className="size-5 shrink-0" />}
              label={url}
              className="py-3 [&_span]:min-w-0 [&_span]:truncate"
            />
          ))}
        </div>
      ) : showEmojiPicker ? (
        <div className="flex justify-center px-2 pb-2">
          <Suspense fallback={null}>
            <EmojiPicker dynamicWidth onSelect={react} onClose={() => setShowEmojiPicker(false)} />
          </Suspense>
        </div>
      ) : (
        <>
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
            {links.length > 0 && (
              <MenuButton
                onClick={onCopyLinkClick}
                icon={<Link2 className="size-5" />}
                label={t('chat.copyLink')}
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
    </TouchMenu>
  )
}
