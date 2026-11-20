import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useContextMenu } from '@/hooks/useContextMenu'
import { LinkContextMenu } from '../LinkContextMenu'

interface MessageLinkProps {
  href: string
  children?: ReactNode
  className?: string
}

/**
 * A hyperlink inside a message. Left-click follows the link (handled globally by
 * externalLinkHandler); right-click opens LinkContextMenu (Copy link / Open in
 * browser) where the link stands alone, so the URL can be copied even on packaged
 * desktop builds where the native WebView menu is suppressed. Inside a message the
 * message's own menu (MessageContextMenu) carries those link items.
 *
 * Touch long-press is intentionally NOT wired here: the message bubble already
 * owns a long-press that opens MessageActionSheet, which carries its own Copy-link
 * affordance. The menu is portalled to document.body so its `position: fixed`
 * isn't offset by the virtualizer's row transforms.
 */
export function MessageLink({ href, children, className = 'text-fluux-link hover:underline' }: MessageLinkProps) {
  const menu = useContextMenu()
  // Inside a message the bubble's menu carries the link items; the link's own menu serves other places.
  const onContextMenu = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.currentTarget.closest('[data-message-id]')) return
    menu.handleContextMenu(e)
  }
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        onContextMenu={onContextMenu}
      >
        {children ?? href}
      </a>
      {menu.isOpen && createPortal(<LinkContextMenu url={href} menu={menu} />, document.body)}
    </>
  )
}
