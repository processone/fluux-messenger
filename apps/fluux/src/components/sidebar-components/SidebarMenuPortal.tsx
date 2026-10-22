import { type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

interface SidebarMenuPortalProps {
  children: ReactNode
  menuRef: RefObject<HTMLDivElement | null>
  position: { x: number; y: number }
  className?: string
}

/** Keep fixed sidebar menus outside the scrolling list's paint tree on iOS. */
export function SidebarMenuPortal({ children, menuRef, position, className = 'min-w-40' }: SidebarMenuPortalProps) {
  return createPortal(
    <div
      ref={menuRef}
      className={`fixed fluux-popover rounded-lg py-1 z-50 select-none ${className}`}
      style={{ left: position.x, top: position.y }}
    >
      {children}
    </div>,
    document.body,
  )
}
