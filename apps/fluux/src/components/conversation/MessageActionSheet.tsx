/** Touch actions and quick reactions anchored to the selected message. */
import { useState, useRef, Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import { SmilePlus, Link2 } from 'lucide-react'
import { TouchMenu } from '../ui/TouchMenu'
import { SelectedMessagePreview } from './SelectedMessagePreview'
import { MenuButton } from '../sidebar-components/SidebarListMenu'
import { TOOLBAR_REACTIONS } from './MessageToolbar'
import { extractLinks } from '../../utils/messageStyles'
import { copyToClipboard } from '@/utils/clipboard'
import { MessageActionRows } from './MessageActionRows'

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
  /** Present only when the message has viewable reactions. */
  onShowReactors?: () => void
  /** Raw message body for the copy action; empty/undefined hides Copy. */
  body?: string
  onReply: () => void
  onEdit: () => void
  onDelete: () => void | Promise<void>
  /** Copies the message's room location, not a URL in its body. */
  onCopyMessageLink?: () => void | Promise<void>
  /** Save to, or remove from, the saved messages. Undefined when the message cannot be saved. */
  onToggleSaved?: () => void
  isSaved?: boolean
  onForward?: () => void
  /** Saves or shares the message's attachment; undefined hides the action. */
  onSaveAttachment?: () => void | Promise<void>
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
  onShowReactors,
  body,
  onReply,
  onEdit,
  onDelete,
  onCopyMessageLink,
  onToggleSaved,
  isSaved = false,
  onForward,
  onSaveAttachment,
  canReply,
  canEdit,
  canDelete,
}: MessageActionSheetProps) {
  const { t } = useTranslation()
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  const linkButtonRef = useRef<HTMLButtonElement>(null)
  const [lastSubmenu, setLastSubmenu] = useState<'links' | 'emoji' | null>(null)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showLinkPicker, setShowLinkPicker] = useState(false)

  const back = () => { setShowEmojiPicker(false); setShowLinkPicker(false) }

  // Always reset the inner picker on close so the menu reopens on the actions view.
  const close = () => {
    setShowEmojiPicker(false)
    setShowLinkPicker(false)
    setLastSubmenu(null)
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
    else { setLastSubmenu('links'); setShowLinkPicker(true) }
  }

  const reactions = onReaction && !showEmojiPicker && !showLinkPicker ? (
    <div className="flex items-center gap-1 px-2 pb-1">
      {TOOLBAR_REACTIONS.map((emoji) => (
        <button
          type="button"
          key={emoji}
          onClick={() => react(emoji)}
          className={`flex h-12 flex-1 items-center justify-center rounded-lg text-2xl transition-colors hover:bg-fluux-hover ${
            myReactions.includes(emoji) ? 'fluux-accent-tint' : ''
          }`}
          aria-label={t('chat.reactWith', { emoji })}
        >
          {emoji}
        </button>
      ))}
      <button
        type="button"
        ref={emojiButtonRef}
        onClick={() => { setLastSubmenu('emoji'); setShowEmojiPicker(true) }}
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
      viewKey={showEmojiPicker ? 'emoji' : showLinkPicker ? 'links' : 'actions'}
      onBack={showEmojiPicker || showLinkPicker ? back : undefined}
      returnFocusRef={lastSubmenu === 'links' ? linkButtonRef : lastSubmenu === 'emoji' ? emojiButtonRef : undefined}
      title={showLinkPicker ? t('chat.copyLinkChoose') : showEmojiPicker ? t('chat.moreReactions') : undefined}
      reactions={reactions}
      preview={<SelectedMessagePreview source={anchor} body={body} />}
      ariaLabel={t('chat.moreOptions')}
    >
      {showLinkPicker ? (
        <div className="pb-1">
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
            <EmojiPicker closeOnEscape={false} dynamicWidth onSelect={react} onClose={() => setShowEmojiPicker(false)} />
          </Suspense>
        </div>
      ) : (
        <>
          <div className="pb-1">
            <MessageActionRows
              touch
              run={runAction}
              onShowReactors={onShowReactors}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
              onCopyText={canCopy ? copyBody : undefined}
              onForward={onForward}
              onToggleSaved={onToggleSaved}
              isSaved={isSaved}
              onCopyMessageLink={onCopyMessageLink}
              onCopyLink={links.length > 0 ? onCopyLinkClick : undefined}
              copyLinkRef={linkButtonRef}
              onSaveAttachment={onSaveAttachment}
              canReply={canReply}
              canEdit={canEdit}
              canDelete={canDelete}
            />
          </div>
        </>
      )}
    </TouchMenu>
  )
}
