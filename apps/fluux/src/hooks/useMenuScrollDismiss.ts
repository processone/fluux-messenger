import { useEffect, type RefObject } from 'react'
import { getFloatingViewport } from './floatingViewport'

/**
 * Whether a scroll should close an open context menu.
 *
 * A fixed menu only loses its place when the scroll moves the element it was opened from:
 * the scrolled container holds that anchor, or the whole document scrolled. Other containers
 * also scroll on their own while a menu is open — the message list re-pins to its newest
 * message after the member panel narrows it or a message arrives — and a member or sidebar
 * menu must not disappear with them. On a busy machine that re-pin used to land just after a
 * member's menu opened, so Whisper vanished before it could be chosen.
 *
 * The menu's own scrolling keeps its earlier rule: a height-limited menu under the custom
 * title bar stays open. Without a connected anchor there is nothing to compare, so the menu
 * keeps closing on any scroll.
 */
export function scrollDismissesMenu(
  target: EventTarget | null,
  menu: Element | null,
  anchor: Element | null,
): boolean {
  if (!(target instanceof Node)) return true
  if (menu?.contains(target)) return !getFloatingViewport().top
  if (!anchor?.isConnected) return true
  return target.contains(anchor)
}

/**
 * Close an open context menu when a scroll moves its anchor (see `scrollDismissesMenu`).
 * Shared by `useContextMenu` (per-item menus) and `SidebarListMenuProvider` (list menus).
 */
export function useMenuScrollDismiss(
  isOpen: boolean,
  menuRef: RefObject<HTMLElement | null>,
  anchorRef: RefObject<Element | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!isOpen) return
    const handleScroll = (event: Event) => {
      if (scrollDismissesMenu(event.target, menuRef.current, anchorRef.current)) close()
    }
    document.addEventListener('scroll', handleScroll, { capture: true })
    return () => document.removeEventListener('scroll', handleScroll, { capture: true })
  }, [isOpen, close, menuRef, anchorRef])
}
