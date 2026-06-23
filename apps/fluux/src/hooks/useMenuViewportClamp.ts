import { useLayoutEffect, type RefObject } from 'react'

export interface MenuPoint {
  x: number
  y: number
}

interface Size {
  width: number
  height: number
}

/** Default distance (px) to keep between the menu and the viewport edges. */
export const MENU_VIEWPORT_PADDING = 8

/**
 * Clamp a context-menu position so the menu stays fully within the viewport.
 *
 * Horizontal overflow shifts the menu left; vertical overflow flips it above
 * the click point when there is room, otherwise pins it to the bottom edge.
 * Pure function — no DOM access — so it can be unit tested directly.
 */
export function adjustMenuPositionToViewport(
  click: MenuPoint,
  menu: Size,
  viewport: Size,
  padding: number = MENU_VIEWPORT_PADDING,
): MenuPoint {
  let { x, y } = click

  // Adjust horizontal position if menu would overflow the right edge.
  if (x + menu.width > viewport.width - padding) {
    x = Math.max(padding, viewport.width - menu.width - padding)
  }

  // Adjust vertical position if menu would overflow the bottom edge.
  if (y + menu.height > viewport.height - padding) {
    // Try positioning above the click point.
    const aboveY = click.y - menu.height
    if (aboveY >= padding) {
      y = aboveY
    } else {
      // If it doesn't fit above either, pin to the bottom of the viewport.
      y = Math.max(padding, viewport.height - menu.height - padding)
    }
  }

  return { x, y }
}

/**
 * Shared layout effect that keeps an open context menu within the viewport.
 *
 * After the menu renders, measure it and re-position via `setPosition` if it
 * would overflow. `clickPosition` holds the original (unadjusted) coordinates
 * so re-runs always clamp from the true anchor rather than the clamped value.
 *
 * Used by both `useContextMenu` (per-item menus) and `SidebarListMenuProvider`
 * (list-level menus) so they share identical edge behaviour.
 */
export function useMenuViewportClamp(
  isOpen: boolean,
  menuRef: RefObject<HTMLDivElement | null>,
  clickPosition: RefObject<MenuPoint>,
  position: MenuPoint,
  setPosition: (next: MenuPoint) => void,
  padding: number = MENU_VIEWPORT_PADDING,
): void {
  useLayoutEffect(() => {
    if (!isOpen || !menuRef.current) return

    const rect = menuRef.current.getBoundingClientRect()
    const next = adjustMenuPositionToViewport(
      clickPosition.current,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
      padding,
    )

    // Only update if position changed to avoid an infinite loop.
    if (next.x !== position.x || next.y !== position.y) {
      setPosition(next)
    }
  }, [isOpen, position.x, position.y, padding, menuRef, clickPosition, setPosition])
}
