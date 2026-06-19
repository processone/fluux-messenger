import { useLayoutEffect, useRef, useState } from 'react'
import { MENU_VIEWPORT_PADDING, type MenuPoint } from './useMenuViewportClamp'

/** Vertical side the menu opens toward, relative to its trigger. */
export type MenuDirection = 'down' | 'up'

/** Gap (px) between the trigger and the menu. */
const MENU_TRIGGER_GAP = 4

interface TriggerRect {
  left: number
  top: number
  bottom: number
}

interface Size {
  width: number
  height: number
}

/**
 * Position a `menu`-sized box next to `trigger`, clamped inside `viewport`.
 *
 * Horizontally the menu is left-aligned to the trigger and shifted left if it
 * would overflow the right edge — never past the left edge. Vertically it opens
 * toward `direction`, flips to the other side when there isn't room, and pins
 * inside the viewport as a last resort. Pure function — unit testable.
 */
export function anchorMenuToTrigger(
  trigger: TriggerRect,
  menu: Size,
  viewport: Size,
  direction: MenuDirection = 'down',
  gap: number = MENU_TRIGGER_GAP,
  padding: number = MENU_VIEWPORT_PADDING,
): MenuPoint {
  // Horizontal: left-align to the trigger, clamp within the viewport.
  let x = trigger.left
  if (x + menu.width > viewport.width - padding) {
    x = viewport.width - menu.width - padding
  }
  x = Math.max(padding, x)

  // Vertical: open toward `direction`, flip when the preferred side lacks room.
  const below = trigger.bottom + gap
  const above = trigger.top - gap - menu.height
  const fitsBelow = below + menu.height <= viewport.height - padding
  const fitsAbove = above >= padding
  const pinned = Math.max(padding, viewport.height - menu.height - padding)

  let y: number
  if (direction === 'up') {
    y = fitsAbove ? above : fitsBelow ? below : pinned
  } else {
    y = fitsBelow ? below : fitsAbove ? above : pinned
  }

  return { x, y }
}

export interface UseAnchoredMenuOptions {
  /** Side the menu opens toward (defaults to `'down'`). */
  direction?: MenuDirection
}

/**
 * Positions a toggle-button dropdown next to its trigger and keeps it inside
 * the viewport.
 *
 * A fixed-width menu anchored to a header/sidebar button near a screen edge
 * would otherwise grow off-screen on narrow (mobile) layouts. This measures the
 * trigger and the rendered menu, then places the menu via {@link
 * anchorMenuToTrigger} so it never overflows: it can open `'down'` or `'up'`
 * (flipping when there's no room) and shifts left to stay on screen.
 *
 * Usage: attach `triggerRef` to the trigger button, `menuRef` to the menu, and
 * render the menu with `fixed` positioning and `position` as inline `left`/`top`.
 * Measuring the trigger directly (rather than a click event) keeps the menu
 * placed correctly even when it is opened programmatically.
 */
export function useAnchoredMenu(
  isOpen: boolean,
  { direction = 'down' }: UseAnchoredMenuOptions = {},
) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<MenuPoint>({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current || !menuRef.current) return

    const trigger = triggerRef.current.getBoundingClientRect()
    const menu = menuRef.current.getBoundingClientRect()
    const next = anchorMenuToTrigger(
      { left: trigger.left, top: trigger.top, bottom: trigger.bottom },
      { width: menu.width, height: menu.height },
      { width: window.innerWidth, height: window.innerHeight },
      direction,
    )

    // Only update if the position changed to avoid an infinite loop.
    if (next.x !== position.x || next.y !== position.y) {
      setPosition(next)
    }
  }, [isOpen, position.x, position.y, direction])

  return { triggerRef, menuRef, position }
}
