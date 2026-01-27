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
  type ReactNode,
  type RefObject,
} from 'react'
import { useClickOutside } from '@/hooks'

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
  menuRef: RefObject<HTMLDivElement>
  /** Whether a long press was triggered (use to prevent click after long press) */
  longPressTriggered: RefObject<boolean>
  /** Close the menu */
  close: () => void
  /** Open menu for an item */
  openMenu: (item: T, position: MenuPosition) => void
  /** Get props to spread on an item element for context menu support */
  getItemMenuProps: (item: T) => ItemMenuProps
}

export interface ItemMenuProps {
  onContextMenu: (e: React.MouseEvent) => void
  onTouchStart: (e: React.TouchEvent) => void
  onTouchEnd: () => void
  onTouchMove: () => void
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

  // Close menu
  const close = useCallback(() => {
    setIsOpen(false)
    setTargetItem(null)
  }, [])

  // Click outside to close
  useClickOutside(menuRef, close, isOpen)

  // Open menu for an item
  const openMenu = useCallback((item: T, pos: MenuPosition) => {
    setTargetItem(item)
    setPosition(pos)
    setIsOpen(true)
  }, [])

  // Create handlers for an item
  const getItemMenuProps = useCallback((item: T): ItemMenuProps => {
    // Right-click handler (desktop)
    const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault()
      openMenu(item, { x: e.clientX, y: e.clientY })
    }

    // Long-press start (mobile)
    const handleTouchStart = (e: React.TouchEvent) => {
      longPressTriggered.current = false
      pendingItemRef.current = item
      const touch = e.touches[0]
      const touchPos = { x: touch.clientX, y: touch.clientY }

      longPressTimeout.current = setTimeout(() => {
        longPressTriggered.current = true
        if (pendingItemRef.current) {
          openMenu(pendingItemRef.current as T, touchPos)
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
    }
  }, [openMenu, longPressDuration])

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
 * Renders the menu content at the correct position.
 * Place this at the end of your list, inside the provider.
 */
export function SidebarListMenuPortal({ children }: SidebarListMenuPortalProps) {
  const { isOpen, position, menuRef } = useSidebarListMenu()

  if (!isOpen) return null

  return (
    <div
      ref={menuRef}
      className="fixed bg-fluux-bg rounded-lg shadow-xl border border-fluux-hover py-1 z-50 min-w-40"
      style={{ left: position.x, top: position.y }}
    >
      {children}
    </div>
  )
}

// ============================================================================
// Menu Item Components (reusable)
// ============================================================================

interface MenuButtonProps {
  onClick: () => void
  icon: ReactNode
  label: string
  variant?: 'default' | 'danger'
}

export function MenuButton({ onClick, icon, label, variant = 'default' }: MenuButtonProps) {
  const baseClasses = 'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors'
  const variantClasses = variant === 'danger'
    ? 'text-fluux-red hover:bg-fluux-red hover:text-white'
    : 'text-fluux-text hover:bg-fluux-brand hover:text-white'

  return (
    <button onClick={onClick} className={`${baseClasses} ${variantClasses}`}>
      {icon}
      <span>{label}</span>
    </button>
  )
}

export function MenuDivider() {
  return <div className="my-1 border-t border-fluux-hover" />
}
