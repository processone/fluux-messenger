/** The message actions, in one order, for both menus: the touch sheet and the pointer menu. */
import type { Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { Reply, Pencil, Trash2, Copy, SmilePlus, Link2, Forward, BookmarkPlus, BookmarkMinus } from 'lucide-react'
import { MenuButton } from '../sidebar-components/SidebarListMenu'
import { SaveActionIcon, saveActionLabelKey } from '@/utils/saveAction'

export interface MessageActionRowsProps {
  /** Touch rows are taller and carry larger icons; pointer rows are compact. */
  touch?: boolean
  /** Closes the menu, then runs the action. */
  run: (fn: () => void | Promise<void>) => void
  onShowReactors?: () => void
  onReply: () => void
  onEdit: () => void
  onDelete: () => void | Promise<void>
  /** Copies the message text; undefined hides Copy text. */
  onCopyText?: () => void
  onForward?: () => void
  /** Saves or removes the message; undefined hides the row. */
  onToggleSaved?: () => void | Promise<void>
  isSaved?: boolean
  onCopyMessageLink?: () => void | Promise<void>
  /** Copies a link of the message body; undefined hides Copy link. */
  onCopyLink?: () => void
  copyLinkRef?: Ref<HTMLButtonElement>
  onSaveAttachment?: () => void | Promise<void>
  canReply: boolean
  canEdit: boolean
  canDelete: boolean
}

export function MessageActionRows({
  touch, run, onShowReactors, onReply, onEdit, onDelete, onCopyText, onForward, onToggleSaved, isSaved, onCopyMessageLink,
  onCopyLink, copyLinkRef, onSaveAttachment, canReply, canEdit, canDelete,
}: MessageActionRowsProps) {
  const { t } = useTranslation()
  const icon = touch ? 'size-5' : 'size-4'
  // py-3 gives a comfortable >=44px touch target
  const className = touch ? 'py-3' : undefined
  return (
    <>
      {onShowReactors && (
        <MenuButton onClick={() => run(onShowReactors)} icon={<SmilePlus className={icon} />} label={t('chat.reactions')} className={className} />
      )}
      {canReply && (
        <MenuButton onClick={() => run(onReply)} icon={<Reply className={`rtl-mirror ${icon}`} />} label={t('chat.reply')} className={className} />
      )}
      {onCopyText && (
        <MenuButton onClick={onCopyText} icon={<Copy className={icon} />} label={t('chat.copyMessage')} className={className} />
      )}
      {onForward && (
        <MenuButton onClick={() => run(onForward)} icon={<Forward className={`rtl-mirror ${icon}`} />} label={t('chat.forwardMessageLink')} className={className} />
      )}
      {onToggleSaved && (
        <MenuButton
          onClick={() => run(onToggleSaved)}
          icon={isSaved ? <BookmarkMinus className={icon} /> : <BookmarkPlus className={icon} />}
          label={isSaved ? t('chat.removeFromSaved') : t('chat.saveMessage')}
          className={className}
        />
      )}
      {onCopyMessageLink && (
        <MenuButton onClick={() => run(onCopyMessageLink)} icon={<Link2 className={icon} />} label={t('chat.copyMessageLink')} className={className} />
      )}
      {onCopyLink && (
        <MenuButton buttonRef={copyLinkRef} onClick={onCopyLink} icon={<Link2 className={icon} />} label={t('chat.copyLink')} className={className} />
      )}
      {onSaveAttachment && (
        <MenuButton onClick={() => run(onSaveAttachment)} icon={<SaveActionIcon className={icon} />} label={t(saveActionLabelKey())} className={className} />
      )}
      {canEdit && (
        <MenuButton onClick={() => run(onEdit)} icon={<Pencil className={icon} />} label={t('chat.editMessage')} className={className} />
      )}
      {canDelete && (
        <MenuButton onClick={() => run(onDelete)} icon={<Trash2 className={icon} />} label={t('chat.deleteMessage')} variant="danger" className={className} />
      )}
    </>
  )
}
