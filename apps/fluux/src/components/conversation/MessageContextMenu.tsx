/** Pointer menu for a right-click on a message: the quick reactions, what sits under the pointer, then the message actions. */
import { useRef, useState, Suspense, lazy } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Reply, Pencil, Trash2, Copy, SmilePlus, Link2, Forward, ExternalLink, Download, Link } from 'lucide-react'
import { MenuButton } from '../sidebar-components/SidebarListMenu'
import { TOOLBAR_REACTIONS } from './MessageToolbar'
import { extractLinks } from '../../utils/messageStyles'
import { copyToClipboard } from '@/utils/clipboard'
import { openInBrowser } from '@/utils/openInBrowser'
import { SaveActionIcon, saveActionLabelKey } from '@/utils/saveAction'
import type { ContextMenuState } from '@/hooks/useContextMenu'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import type { MessageActionSheetProps } from './MessageActionSheet'

const EmojiPicker = lazy(() => import('../EmojiPicker').then((m) => ({ default: m.EmojiPicker })))

/** What the right-click landed on, read when the menu opened. */
export interface MessageContextTarget {
  /** Words the user selected before the click; empty when none. */
  selection: string
  /** The link under the pointer. */
  linkUrl?: string
  /** True when the pointer is over an inline image of the message. */
  image: boolean
}

type ActionProps = Omit<MessageActionSheetProps, 'open' | 'anchor' | 'onClose'>

export interface MessageContextMenuProps extends ActionProps {
  menu: ContextMenuState
  target: MessageContextTarget
  /** Image under the pointer: its URL and the save action. */
  imageUrl?: string
  onSaveImage?: () => void | Promise<void>
}

/**
 * Same actions, in the same order, as the touch MessageActionSheet; the group for
 * the selection, link or image under the pointer goes on top.
 */
export function MessageContextMenu({
  menu, target, imageUrl, onSaveImage,
  onReaction, myReactions, onShowReactors, body, onReply, onEdit, onDelete,
  onCopyMessageLink, onForward, onSaveAttachment, canReply, canEdit, canDelete,
}: MessageContextMenuProps) {
  const { t } = useTranslation()
  const [view, setView] = useState<'actions' | 'emoji' | 'links'>('actions')
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  useFocusTrap(menu.menuRef, { active: menu.isOpen })
  if (!menu.isOpen) return null

  const run = (fn: () => void | Promise<void>) => { menu.close(); void fn() }
  const react = (emoji: string) => { menu.close(); onReaction?.(emoji) }

  const links = extractLinks(body ?? '')
  const copyLink = (url: string) => run(() => copyToClipboard(url))

  const contextItems = (
    <>
      {target.selection && (
        <MenuButton
          onClick={() => run(() => copyToClipboard(target.selection))}
          icon={<Copy className="size-4" />}
          label={t('chat.selection.copy')}
        />
      )}
      {target.linkUrl && (
        <>
          <MenuButton onClick={() => copyLink(target.linkUrl!)} icon={<Link2 className="size-4" />} label={t('chat.copyLink')} />
          {!target.linkUrl.startsWith('xmpp:') && (
            <MenuButton
              onClick={() => run(() => openInBrowser(target.linkUrl!))}
              icon={<ExternalLink className="size-4" />}
              label={t('chat.openInBrowser')}
            />
          )}
        </>
      )}
      {target.image && imageUrl && (
        <>
          {onSaveImage && (
            <MenuButton onClick={() => run(onSaveImage)} icon={<Download className="size-4" />} label={t('chat.saveImage')} />
          )}
          <MenuButton onClick={() => copyLink(imageUrl)} icon={<Link className="size-4" />} label={t('chat.copyImageUrl')} />
          <MenuButton
            onClick={() => run(() => openInBrowser(imageUrl))}
            icon={<ExternalLink className="size-4" />}
            label={t('chat.openInBrowser')}
          />
        </>
      )}
    </>
  )
  const hasContext = !!target.selection || !!target.linkUrl || (target.image && !!imageUrl)

  const menuBody = view === 'emoji' ? (
    <Suspense fallback={null}>
      <EmojiPicker closeOnEscape={false} dynamicWidth onSelect={react} onClose={() => setView('actions')} />
    </Suspense>
  ) : view === 'links' ? (
    <div className="max-w-xs">
      {links.map((url) => (
        <MenuButton key={url} onClick={() => copyLink(url)} icon={<Link2 className="size-4" />} label={url} className="[&_span]:min-w-0 [&_span]:truncate" />
      ))}
    </div>
  ) : (
    <>
      {onReaction && (
        <div className="flex items-center gap-1 px-2 py-1" role="group" aria-label={t('chat.moreReactions')}>
          {TOOLBAR_REACTIONS.map((emoji) => (
            <button
              type="button"
              key={emoji}
              onClick={() => react(emoji)}
              className={`flex h-9 flex-1 items-center justify-center rounded-lg text-xl transition-colors hover:bg-fluux-hover ${myReactions.includes(emoji) ? 'bg-fluux-brand/20' : ''}`}
              aria-label={t('chat.reactWith', { emoji })}
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            ref={emojiButtonRef}
            onClick={() => setView('emoji')}
            className="flex h-9 flex-1 items-center justify-center rounded-lg transition-colors hover:bg-fluux-hover"
            aria-label={t('chat.moreReactions')}
          >
            <SmilePlus className="size-5 text-fluux-muted" />
          </button>
        </div>
      )}
      {hasContext && (
        <>
          {onReaction && <div className="my-1 border-t border-fluux-border" role="separator" />}
          {contextItems}
          <div className="my-1 border-t border-fluux-border" role="separator" />
        </>
      )}
      {onShowReactors && <MenuButton onClick={() => run(onShowReactors)} icon={<SmilePlus className="size-4" />} label={t('chat.reactions')} />}
      {canReply && <MenuButton onClick={() => run(onReply)} icon={<Reply className="rtl-mirror size-4" />} label={t('chat.reply')} />}
      {!!body && (
        <MenuButton onClick={() => run(() => copyToClipboard(body))} icon={<Copy className="size-4" />} label={t('chat.copyMessage')} />
      )}
      {onForward && <MenuButton onClick={() => run(onForward)} icon={<Forward className="rtl-mirror size-4" />} label={t('chat.forwardMessageLink')} />}
      {onCopyMessageLink && <MenuButton onClick={() => run(onCopyMessageLink)} icon={<Link2 className="size-4" />} label={t('chat.copyMessageLink')} />}
      {links.length > 0 && (
        <MenuButton
          onClick={() => (links.length === 1 ? copyLink(links[0]) : setView('links'))}
          icon={<Link2 className="size-4" />}
          label={t('chat.copyLink')}
        />
      )}
      {onSaveAttachment && <MenuButton onClick={() => run(onSaveAttachment)} icon={<SaveActionIcon className="size-4" />} label={t(saveActionLabelKey())} />}
      {canEdit && <MenuButton onClick={() => run(onEdit)} icon={<Pencil className="size-4" />} label={t('chat.editMessage')} />}
      {canDelete && <MenuButton onClick={() => run(onDelete)} icon={<Trash2 className="size-4" />} label={t('chat.deleteMessage')} variant="danger" />}
    </>
  )

  // Portaled so the virtualized rows' transforms do not offset `position: fixed`.
  return createPortal(
    <div
      ref={menu.menuRef}
      role="menu"
      aria-label={t('chat.moreOptions')}
      className="fixed z-50 min-w-[220px] py-1 rounded-lg fluux-popover"
      style={{ left: menu.position.x, top: menu.position.y }}
    >
      {menuBody}
    </div>,
    document.body,
  )
}
