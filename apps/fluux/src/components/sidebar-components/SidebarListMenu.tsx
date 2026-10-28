import { iosHaptic } from '@/platform/ios/haptics'
/**
 * Shared context menu system for sidebar lists.
 *
 * This lifts context menu state to the list level, allowing item components
 * to be stateless and wrapped with React.memo for better performance.
 *
 * Usage:
 * 1. Wrap your list with SidebarListMenuProvider
 * 2. Use useSidebarListMenu() in items to get event handlers
 * 3. Render SidebarListMenuPortal at the end of your list
 */
import {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
  type ReactNode,
  type RefObject,
} from 'react'
import { SidebarMenuPortal } from './SidebarMenuPortal'
import { useClickOutside, useMenuViewportClamp } from '@/hooks'
import { useMenuScrollDismiss } from '@/hooks/useMenuScrollDismiss'
import { useCloseOnEscape } from '@/hooks/useCloseOnEscape'

// ============================================================================
// Types
// ============================================================================

export interface MenuPosition {
  x: number
  y: number
}

export interface SidebarListMenuState<T> {
  /** Whether the menu is currently open */
  isOpen: boolean
  /** Position where the menu should be rendered */
  position: MenuPosition
  /** The item that was right-clicked/long-pressed */
  targetItem: T | null
  /** Ref to attach to the menu element (for click-outside detection) */
  menuRef: RefObject<HTMLDivElement | null>
  /** Whether a long press was triggered (use to prevent click after long press) */
  longPressTriggered: RefObject<boolean>
  /** Close the menu */
  close: () => void
  /** Open menu for an item; `anchor` is the element it opens from, if any */
  openMenu: (item: T, position: MenuPosition, anchor?: Element | null) => void
  /** Get props to spread on an item element for context menu support */
  getItemMenuProps: (item: T) => ItemMenuProps
}

export interface ItemMenuProps {
  onContextMenu: (e: React.MouseEvent) => void
  onTouchStart: (e: React.TouchEvent) => void
  onTouchEnd: () => void
  onTouchMove: () => void
  onTouchCancel: () => void
}

interface SidebarListMenuProviderProps {
  children: ReactNode
  /** Long press duration in ms (default: 500) */
  longPressDuration?: number
}

// ============================================================================
// Context
// ============================================================================

 
const SidebarListMenuContext = createContext<SidebarListMenuState<any> | null>(null)

// ============================================================================
// Provider
// ============================================================================

export function SidebarListMenuProvider<T>({
  children,
  longPressDuration = 500,
}: SidebarListMenuProviderProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition>({ x: 0, y: 0 })
  const [targetItem, setTargetItem] = useState<T | null>(null)

  const menuRef = useRef<HTMLDivElement>(null)
  const longPressTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTriggered = useRef(false)
  const pendingItemRef = useRef<T | null>(null)
  // Original (unadjusted) anchor, kept separate so re-clamps measure from the true point.
  const clickPosition = useRef<MenuPosition>({ x: 0, y: 0 })
  // The element the menu was opened from; only scrolls that move it close the menu.
  const anchorRef = useRef<Element | null>(null)

  useEffect(() => () => { if (longPressTimeout.current) clearTimeout(longPressTimeout.current) }, [])

  // Close menu
  const close = useCallback(() => {
    setIsOpen(false)
    setTargetItem(null)
  }, [])

  // Click outside to close
  useClickOutside(menuRef, close, isOpen)

  // Close when a scroll moves the anchor, not when an unrelated list scrolls itself.
  useMenuScrollDismiss(isOpen, menuRef, anchorRef, close)

  // Escape closes the open menu first and goes no further, so it cannot also jump the
  // conversation to its newest message. When overlays are stacked, Escape goes to the one
  // on top: a menu in the lightbox closes before the lightbox, and shortcut help opened
  // over a menu closes before the menu (see useCloseOnEscape).
  useCloseOnEscape(close, isOpen)

  // Open menu for an item
  const openMenu = (item: T, pos: MenuPosition, anchor: Element | null = null) => {
    anchorRef.current = anchor
    clickPosition.current = pos
    setTargetItem(item)
    setPosition(pos)
    setIsOpen(true)
  }

  // Keep the menu within the viewport once it has rendered (shared with useContextMenu).
  useMenuViewportClamp(isOpen, menuRef, clickPosition, position, setPosition)

  // Create handlers for an item
  const getItemMenuProps = (item: T): ItemMenuProps => {
    // Right-click handler (desktop)
    const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault()
      openMenu(item, { x: e.clientX, y: e.clientY }, e.currentTarget instanceof Element ? e.currentTarget : null)
    }

    // Long-press start (mobile)
    const handleTouchStart = (e: React.TouchEvent) => {
      if (longPressTimeout.current) clearTimeout(longPressTimeout.current)
      longPressTriggered.current = false
      pendingItemRef.current = null
      if (e.touches.length !== 1) return
      pendingItemRef.current = item
      const touch = e.touches[0]
      const touchPos = { x: touch.clientX, y: touch.clientY }
      // currentTarget is only set while the event dispatches, so read it before the timer.
      const anchor = e.currentTarget instanceof Element ? e.currentTarget : null

      longPressTimeout.current = setTimeout(() => {
        longPressTriggered.current = true
        if (pendingItemRef.current) {
          openMenu(pendingItemRef.current as T, touchPos, anchor)
          iosHaptic('contextMenu')
        }
      }, longPressDuration)
    }

    // Cancel long-press on move or end
    const handleTouchEnd = () => {
      if (longPressTimeout.current) {
        clearTimeout(longPressTimeout.current)
        longPressTimeout.current = null
      }
      pendingItemRef.current = null
    }

    return {
      onContextMenu: handleContextMenu,
      onTouchStart: handleTouchStart,
      onTouchEnd: handleTouchEnd,
      onTouchMove: handleTouchEnd,
      onTouchCancel: handleTouchEnd,
    }
  }

  const value: SidebarListMenuState<T> = {
    isOpen,
    position,
    targetItem,
    menuRef,
    longPressTriggered,
    close,
    openMenu,
    getItemMenuProps,
  }

  return (
    <SidebarListMenuContext.Provider value={value}>
      {children}
    </SidebarListMenuContext.Provider>
  )
}

// ============================================================================
// Hook
// ============================================================================

export function useSidebarListMenu<T>(): SidebarListMenuState<T> {
  const context = useContext(SidebarListMenuContext)
  if (!context) {
    throw new Error('useSidebarListMenu must be used within a SidebarListMenuProvider')
  }
  return context as SidebarListMenuState<T>
}

// ============================================================================
// Menu Portal Component
// ============================================================================

interface SidebarListMenuPortalProps {
  children: ReactNode
}

/**
 * Renders the menu at document level so scrolling list ancestors cannot clip it.
 * Place this at the end of your list, inside the provider.
 */
export function SidebarListMenuPortal({ children }: SidebarListMenuPortalProps) {
  const { isOpen, position, menuRef } = useSidebarListMenu()

  if (!isOpen) return null

  return (
    <SidebarMenuPortal menuRef={menuRef} position={position}>
      {children}
    </SidebarMenuPortal>
  )
}

// ============================================================================
// Menu Item Components (reusable)
// ============================================================================

interface MenuButtonProps {
  buttonRef?: React.Ref<HTMLButtonElement>
  onClick: () => void
  icon: ReactNode
  label: string
  variant?: 'default' | 'danger'
  /** Extra classes appended to the row, e.g. `py-3` for a comfortable touch target. */
  className?: string
}

export function MenuButton({ onClick, icon, label, variant = 'default', className = '', buttonRef }: MenuButtonProps) {
  const baseClasses = 'w-full px-3 py-2 touch:py-3 flex items-center gap-3 text-start transition-colors'
  const variantClasses = variant === 'danger'
    ? 'text-fluux-error hover:bg-fluux-red hover:text-white'
    : 'text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent'

  return (
    <button ref={buttonRef} type="button" onClick={onClick} className={`${baseClasses} ${variantClasses} ${className}`}>
      {icon}
      <span>{label}</span>
    </button>
  )
}

export function MenuDivider() {
  return <div className="my-1 border-t border-fluux-hover" />
}
