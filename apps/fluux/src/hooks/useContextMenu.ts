import { useState, useRef, useCallback, useLayoutEffect } from 'react'
import { useClickOutside } from './useClickOutside'

export interface ContextMenuState {
  /** Whether the context menu is currently open */
  isOpen: boolean
  /** Position where the menu should be rendered */
  position: { x: number; y: number }
  /** Ref to attach to the menu element (for click-outside detection and positioning) */
  menuRef: React.RefObject<HTMLDivElement>
  /** Whether a long press was triggered (use to prevent click after long press) */
  longPressTriggered: React.RefObject<boolean>
  /** Close the menu */
  close: () => void
  /** Handler for right-click on desktop */
  handleContextMenu: (e: React.MouseEvent) => void
  /** Handler for touch start (long-press detection) */
  handleTouchStart: (e: React.TouchEvent) => void
  /** Handler for touch end/move (cancel long-press) */
  handleTouchEnd: () => void
}

interface UseContextMenuOptions {
  /** Long press duration in ms (default: 500) */
  longPressDuration?: number
}

/**
 * Hook for managing context menu state with support for:
 * - Right-click on desktop
 * - Long-press on mobile/touch devices
 * - Click-outside to close
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const menu = useContextMenu()
 *
 *   const handleClick = () => {
 *     if (menu.isOpen || menu.longPressTriggered.current) return
 *     // normal click action
 *   }
 *
 *   return (
 *     <>
 *       <div
 *         onClick={handleClick}
 *         onContextMenu={menu.handleContextMenu}
 *         onTouchStart={menu.handleTouchStart}
 *         onTouchEnd={menu.handleTouchEnd}
 *         onTouchMove={menu.handleTouchEnd}
 *       >
 *         Right-click or long-press me
 *       </div>
 *
 *       {menu.isOpen && (
 *         <div
 *           ref={menu.menuRef}
 *           style={{ position: 'fixed', left: menu.position.x, top: menu.position.y }}
 *         >
 *           <button onClick={() => { menu.close(); doAction(); }}>Action</button>
 *         </div>
 *       )}
 *     </>
 *   )
 * }
 * ```
 */
export function useContextMenu(options: UseContextMenuOptions = {}): ContextMenuState {
  const { longPressDuration = 500 } = options

  const [isOpen, setIsOpen] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })

  const menuRef = useRef<HTMLDivElement>(null)
  const longPressTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTriggered = useRef(false)
  // Store the click position separately from the adjusted position
  const clickPosition = useRef({ x: 0, y: 0 })

  // Close menu
  const close = useCallback(() => setIsOpen(false), [])

  // Click outside to close
  useClickOutside(menuRef, close, isOpen)

  // Adjust position after menu renders to keep it within viewport
  useLayoutEffect(() => {
    if (!isOpen || !menuRef.current) return

    const menu = menuRef.current
    const rect = menu.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const padding = 8 // Keep some distance from viewport edges

    let { x, y } = clickPosition.current

    // Adjust horizontal position if menu would overflow right edge
    if (x + rect.width > viewportWidth - padding) {
      x = Math.max(padding, viewportWidth - rect.width - padding)
    }

    // Adjust vertical position if menu would overflow bottom edge
    if (y + rect.height > viewportHeight - padding) {
      // Try positioning above the click point
      const aboveY = clickPosition.current.y - rect.height
      if (aboveY >= padding) {
        y = aboveY
      } else {
        // If it doesn't fit above either, position at the bottom of viewport
        y = Math.max(padding, viewportHeight - rect.height - padding)
      }
    }

    // Only update if position changed to avoid infinite loops
    if (x !== position.x || y !== position.y) {
      setPosition({ x, y })
    }
  }, [isOpen, position.x, position.y])

  // Right-click handler (desktop)
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    clickPosition.current = { x: e.clientX, y: e.clientY }
    setPosition({ x: e.clientX, y: e.clientY })
    setIsOpen(true)
  }, [])

  // Long-press start (mobile)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    longPressTriggered.current = false
    const touch = e.touches[0]
    longPressTimeout.current = setTimeout(() => {
      longPressTriggered.current = true
      clickPosition.current = { x: touch.clientX, y: touch.clientY }
      setPosition({ x: touch.clientX, y: touch.clientY })
      setIsOpen(true)
    }, longPressDuration)
  }, [longPressDuration])

  // Cancel long-press on move or end
  const handleTouchEnd = useCallback(() => {
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current)
      longPressTimeout.current = null
    }
  }, [])

  return {
    isOpen,
    position,
    menuRef,
    longPressTriggered,
    close,
    handleContextMenu,
    handleTouchStart,
    handleTouchEnd,
  }
}
