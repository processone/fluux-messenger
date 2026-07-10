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
 * browser) so the URL can be copied even on packaged desktop builds where the
 * native WebView menu is suppressed.
 *
 * Touch long-press is intentionally NOT wired here: the message bubble already
 * owns a long-press that opens MessageActionSheet, which carries its own Copy-link
 * affordance. The menu is portalled to document.body so its `position: fixed`
 * isn't offset by the virtualizer's row transforms.
 */
export function MessageLink({ href, children, className = 'text-fluux-link hover:underline' }: MessageLinkProps) {
  const menu = useContextMenu()
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        onContextMenu={menu.handleContextMenu}
      >
        {children ?? href}
      </a>
      {menu.isOpen && createPortal(<LinkContextMenu url={href} menu={menu} />, document.body)}
    </>
  )
}
