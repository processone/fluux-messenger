/** Pointer menu for a right-click on a message: the quick reactions, what sits under the pointer, then the message actions. */
import { useRef, useState, useEffect, Suspense, lazy } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Copy, SmilePlus, Link2, ExternalLink, Download, Link } from 'lucide-react'
import { MenuButton } from '../sidebar-components/SidebarListMenu'
import { TOOLBAR_REACTIONS } from './MessageToolbar'
import { extractLinks } from '../../utils/messageStyles'
import { copyToClipboard } from '@/utils/clipboard'
import { openInBrowser } from '@/utils/openInBrowser'
import { MessageActionRows } from './MessageActionRows'
import type { ContextMenuState } from '@/hooks/useContextMenu'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import type { MessageActionSheetProps } from './MessageActionSheet'

const EmojiPicker = lazy(() => import('../EmojiPicker').then((m) => ({ default: m.EmojiPicker })))

/** What the right-click landed on, read when the menu opened. */
export interface MessageContextTarget {
  /** Words the user selected before the click; empty when none. */
  selection: string
  /** The selected range, restored for Copy when the engine drops the selection while the menu is open. */
  range?: Range
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
  onCopyMessageLink, onForward, onToggleSaved, isSaved, onSaveAttachment, canReply, canEdit, canDelete,
}: MessageContextMenuProps) {
  const { t } = useTranslation()
  const [view, setView] = useState<'actions' | 'emoji' | 'links'>('actions')
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  useFocusTrap(menu.menuRef, { active: menu.isOpen, includeShadowRoots: true })
  // A view change replaces the focused control: move focus into the new view.
  const previousView = useRef(view)
  useEffect(() => {
    const from = previousView.current
    previousView.current = view
    if (from === view) return
    const root = menu.menuRef.current
    const target = view === 'actions' && from === 'emoji' ? emojiButtonRef.current : root?.querySelector<HTMLElement>('button')
    ;(target ?? root)?.focus({ preventScroll: true })
  }, [view, menu.menuRef])

  const run = (fn: () => void | Promise<void>) => { menu.close(); void fn() }
  const react = (emoji: string) => { menu.close(); onReaction?.(emoji) }

  const links = extractLinks(body ?? '')
  const copyLink = (url: string) => run(() => copyToClipboard(url))
  // Copy runs the browser's own copy over the live selection so the list's copy formatting (dates,
  // sender headers) applies; the text read at open time is the fallback.
  const copySelection = () => run(() => {
    const live = window.getSelection()
    if (live?.toString() !== target.selection && target.range) {
      live?.removeAllRanges()
      live?.addRange(target.range)
    }
    const done = live?.toString() === target.selection && typeof document.execCommand === 'function' && document.execCommand('copy')
    if (!done) return copyToClipboard(target.selection)
  })

  const contextItems = (
    <>
      {target.selection && (
        <MenuButton
          onClick={copySelection}
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
              className={`flex h-9 flex-1 items-center justify-center rounded-lg text-xl transition-colors hover:bg-fluux-hover ${myReactions.includes(emoji) ? 'fluux-accent-tint' : ''}`}
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
      <MessageActionRows
        run={run}
        onShowReactors={onShowReactors}
        onReply={onReply}
        onEdit={onEdit}
        onDelete={onDelete}
        onCopyText={body ? () => run(() => copyToClipboard(body)) : undefined}
        onForward={onForward}
        onToggleSaved={onToggleSaved}
        isSaved={isSaved}
        onCopyMessageLink={onCopyMessageLink}
        // A link under the pointer has its own Copy link above.
        onCopyLink={links.length > 0 && !target.linkUrl ? () => (links.length === 1 ? copyLink(links[0]) : setView('links')) : undefined}
        onSaveAttachment={onSaveAttachment}
        canReply={canReply}
        canEdit={canEdit}
        canDelete={canDelete}
      />
    </>
  )

  // Portaled so the virtualized rows' transforms do not offset `position: fixed`.
  return createPortal(
    <div
      ref={menu.menuRef}
      role="menu"
      aria-label={t('chat.moreOptions')}
      tabIndex={-1}
      // Portaled: keep clicks and right-clicks from reaching the message row's React handlers.
      onClick={(e) => e.stopPropagation()}
      // Pressing a button must not clear the page selection that Copy reads (WebKit drops it otherwise);
      // the picker's search field still takes focus.
      // The picker's search field swallows Escape before the document sees it, so the menu takes it first.
      onKeyDownCapture={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        menu.close()
      }}
      onMouseDown={(e) => {
        const el = e.nativeEvent.composedPath()[0]
        if (!(el instanceof Element && el.closest('input, textarea, [contenteditable="true"]'))) e.preventDefault()
      }}
      // The system menu stays reachable with Shift and in the picker's search field.
      onContextMenu={(e) => {
        e.stopPropagation()
        // The emoji picker's search field sits in a shadow root, where the event is retargeted to its host.
        const el = e.nativeEvent.composedPath()[0]
        const editable = el instanceof Element && !!el.closest('input, textarea, [contenteditable="true"]')
        if (!e.shiftKey && !editable) e.preventDefault()
      }}
      // Keeps the conversation's keyboard navigation out of the menu (same marker as other overlays).
      data-modal="true"
      // A long menu or link chooser scrolls inside a short window.
      className="fixed z-50 min-w-[220px] py-1 rounded-lg fluux-popover outline-none max-h-[calc(100dvh-1rem)] overflow-y-auto"
      style={{ left: menu.position.x, top: menu.position.y }}
    >
      {menuBody}
    </div>,
    document.body,
  )
}
