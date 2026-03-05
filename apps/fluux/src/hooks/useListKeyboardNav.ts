import React, { useState, useEffect, useCallback, useMemo, useRef, RefObject } from 'react'

/**
 * Options for the useListKeyboardNav hook
 */
interface UseListKeyboardNavOptions<T> {
  /** Array of items to navigate through (full list) */
  items: T[]
  /**
   * Optional smaller subset of items for Alt+Arrow navigation.
   * When provided, Alt+Arrow navigates within this list while plain Arrow navigates the full list.
   * Useful for "active items" vs "all items" navigation (e.g., joined rooms vs all rooms).
   */
  altKeyItems?: T[]
  /** Callback when an item is selected (Enter key) */
  onSelect: (item: T, index: number) => void
  /** Whether keyboard navigation is enabled (default: true) */
  enabled?: boolean
  /** Ref to the scrollable list container for auto-scroll */
  listRef: RefObject<HTMLElement | null>
  /** Optional ref to search input - will be blurred on arrow navigation */
  searchInputRef?: RefObject<HTMLInputElement | null>
  /** Function to get a unique ID for each item (for scroll targeting) */
  getItemId: (item: T) => string
  /** Data attribute name used on list items (e.g., 'data-item-id') */
  itemAttribute?: string
  /** Optional ref to the focus zone - arrow keys only work when focus is within this zone */
  zoneRef?: RefObject<HTMLElement | null>
  /** Enable bounce animation at list boundaries (default: false) */
  enableBounce?: boolean
  /**
   * When true, Alt+Arrow navigation also activates/selects the item (calls onSelect).
   * Plain Arrow only highlights without activating.
   * Useful for: Alt+Arrow = navigate AND switch view, Plain Arrow = just highlight.
   */
  activateOnAltNav?: boolean
}

/**
 * Return value of useListKeyboardNav hook
 */
interface UseListKeyboardNavReturn {
  /** Currently selected index (-1 means no selection) */
  selectedIndex: number
  /** Manually set the selected index */
  setSelectedIndex: (index: number) => void
  /** Whether currently in keyboard navigation mode (suppresses mouse hover) */
  isKeyboardNav: boolean
  /** Props to spread on each list item */
  getItemProps: (index: number) => {
    'data-selected': boolean
    onMouseEnter: (e: React.MouseEvent) => void
    onMouseMove: (e: React.MouseEvent) => void
  }
  /** Data attribute value for the item at given index */
  getItemAttribute: (index: number) => Record<string, string>
  /** Props to spread on the list container for mouse leave handling */
  getContainerProps: () => {
    onMouseLeave: () => void
  }
}

/**
 * A reusable hook for keyboard navigation in lists.
 *
 * Provides:
 * - Arrow Up/Down navigation
 * - Enter to select
 * - Auto-scroll selected item into view
 * - Reset selection when items change
 * - Optional search input blur on navigation
 *
 * @example
 * ```tsx
 * const { selectedIndex, getItemProps, getItemAttribute } = useListKeyboardNav({
 *   items: contacts,
 *   onSelect: (contact) => openChat(contact.jid),
 *   listRef,
 *   getItemId: (contact) => contact.jid,
 * })
 *
 * return (
 *   <div ref={listRef}>
 *     {contacts.map((contact, index) => (
 *       <div
 *         key={contact.jid}
 *         {...getItemAttribute(index)}
 *         {...getItemProps(index)}
 *       >
 *         {contact.name}
 *       </div>
 *     ))}
 *   </div>
 * )
 * ```
 */
export function useListKeyboardNav<T>({
  items,
  altKeyItems,
  onSelect,
  enabled = true,
  listRef,
  searchInputRef,
  getItemId,
  itemAttribute = 'data-item-id',
  zoneRef,
  enableBounce = false,
  activateOnAltNav = false,
}: UseListKeyboardNavOptions<T>): UseListKeyboardNavReturn {
  const [selectedIndex, setSelectedIndex] = useState(-1)
  // Track if we're in keyboard navigation mode (suppresses mouse hover updates)
  const [isKeyboardNav, setIsKeyboardNav] = useState(false)
  // Track the selected item's ID so we can preserve selection when items change (e.g., pagination append)
  const selectedItemIdRef = useRef<string | null>(null)
  // Track the last mouse position to distinguish real mouse movement from scroll-induced mousemove events.
  // When scrollIntoView shifts the list, the browser fires mousemove on items passing under the
  // stationary cursor — we must ignore those.
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null)

  // Trigger bounce animation at list boundaries
  const triggerBounce = useCallback(
    (direction: 'top' | 'bottom') => {
      if (!enableBounce || !listRef.current) return
      const className = direction === 'top' ? 'bounce-top' : 'bounce-bottom'
      listRef.current.classList.add(className)
      setTimeout(() => listRef.current?.classList.remove(className), 300)
    },
    [enableBounce, listRef]
  )

  // Create a stable string of item IDs for comparison (avoids reset on same-content array)
  const itemsKey = useMemo(() => items.map(getItemId).join('\0'), [items, getItemId])

  // Create maps for efficient ID-to-index lookups
  const itemIdToIndex = useMemo(
    () => new Map(items.map((item, i) => [getItemId(item), i])),
    [items, getItemId]
  )
  const altKeyItemIdToIndex = useMemo(
    () => altKeyItems ? new Map(altKeyItems.map((item, i) => [getItemId(item), i])) : null,
    [altKeyItems, getItemId]
  )

  // Keep a ref to the latest itemIdToIndex map so the reset effect can use it
  // without depending on its identity (which changes when getItemId is recreated).
  const itemIdToIndexRef = useRef(itemIdToIndex)
  itemIdToIndexRef.current = itemIdToIndex

  // When items change, try to preserve the selection by matching the previously selected item ID.
  // This prevents the selection from resetting to -1 when items are appended (e.g., pagination).
  useEffect(() => {
    const prevId = selectedItemIdRef.current
    if (prevId) {
      const newIndex = itemIdToIndexRef.current.get(prevId)
      if (newIndex !== undefined) {
        setSelectedIndex(newIndex)
        return
      }
    }
    setSelectedIndex(-1)
    selectedItemIdRef.current = null
  }, [itemsKey])

  // Keyboard event handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled || items.length === 0) return

      const activeElement = document.activeElement

      // Check if focus is inside a modal (data-modal attribute or fixed z-50 overlay)
      // If so, only handle if our list is also inside that modal
      const modalBackdrop = activeElement?.closest('[data-modal="true"], .fixed.z-50')
      if (modalBackdrop) {
        const ourListIsInModal = listRef.current && modalBackdrop.contains(listRef.current)
        if (!ourListIsInModal) return
      }

      // If focus is not in a modal (e.g., on document.body after search input blur),
      // but a modal IS open in the document, only handle if our list is inside that modal.
      // This prevents sidebar lists from stealing keyboard events when a modal is active.
      if (!modalBackdrop) {
        const openModal = document.querySelector('[data-modal="true"]')
        if (openModal && listRef.current && !openModal.contains(listRef.current)) {
          return
        }
      }

      // If zoneRef is provided, only handle keys when focus is within that zone
      if (zoneRef?.current) {
        if (!zoneRef.current.contains(activeElement)) return
      }

      // Don't interfere if user is typing in an unrelated input
      const target = e.target as HTMLElement
      // Check isContentEditable property OR contentEditable attribute for better compatibility
      const isInInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.contentEditable === 'true'
      const isOurSearchInput = searchInputRef?.current && target === searchInputRef.current

      // Only handle if not in input, or if in our search input
      if (isInInput && !isOurSearchInput) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Determine if we should handle Alt+arrows:
        // - If altKeyItems is provided: Alt navigates the smaller list
        // - If activateOnAltNav is true: Alt navigates and activates (even without altKeyItems)
        // - Otherwise: ignore Alt+arrows (let other components handle them)
        const shouldHandleAlt = altKeyItems || activateOnAltNav
        if (e.altKey && !shouldHandleAlt) return

        // Determine which list to navigate: altKeyItems (Alt pressed) or items (plain arrow)
        const useAltList = e.altKey && altKeyItems && altKeyItems.length > 0
        const navItems = useAltList ? altKeyItems : items
        const navItemIdToIndex = useAltList ? altKeyItemIdToIndex : itemIdToIndex

        if (navItems.length === 0) return

        e.preventDefault()
        setIsKeyboardNav(true)

        // Blur search input to indicate we're now navigating the list
        if (isOurSearchInput) {
          searchInputRef?.current?.blur()
        }

        // Calculate the new index - we need the current selectedIndex for this
        // Use a functional update pattern but calculate outside to avoid React calling it multiple times
        const calculateNewIndex = (prev: number): { newIndex: number; bounced: boolean } => {
          // Find current position in the navigation list
          let currentNavIndex = -1
          if (prev >= 0 && prev < items.length) {
            const currentId = getItemId(items[prev])
            currentNavIndex = navItemIdToIndex?.get(currentId) ?? -1
          }

          // Calculate new index in navigation list
          let newNavIndex: number
          let bounced = false
          if (e.key === 'ArrowDown') {
            if (currentNavIndex < 0) {
              newNavIndex = 0
            } else if (currentNavIndex >= navItems.length - 1) {
              triggerBounce('bottom')
              bounced = true
              return { newIndex: prev, bounced }
            } else {
              newNavIndex = currentNavIndex + 1
            }
          } else {
            // ArrowUp
            if (currentNavIndex < 0) {
              newNavIndex = 0
            } else if (currentNavIndex <= 0) {
              triggerBounce('top')
              bounced = true
              return { newIndex: prev, bounced }
            } else {
              newNavIndex = currentNavIndex - 1
            }
          }

          // Map back to main items index
          const newItem = navItems[newNavIndex]
          if (!newItem) return { newIndex: prev, bounced }
          const newId = getItemId(newItem)
          return { newIndex: itemIdToIndex.get(newId) ?? prev, bounced }
        }

        // Calculate new index based on current state
        const { newIndex, bounced } = calculateNewIndex(selectedIndex)

        // Update state and track selected item ID for preservation across list changes
        setSelectedIndex(newIndex)
        selectedItemIdRef.current = newIndex >= 0 && newIndex < items.length ? getItemId(items[newIndex]) : null

        // If Alt+arrow and activateOnAltNav, call onSelect (only if actually navigated)
        if (e.altKey && activateOnAltNav && !bounced && newIndex !== selectedIndex && newIndex >= 0 && newIndex < items.length) {
          // Use setTimeout to ensure React has processed the state update
          setTimeout(() => onSelect(items[newIndex], newIndex), 0)
        }
      } else if (e.key === 'Enter' && selectedIndex >= 0 && selectedIndex < items.length) {
        e.preventDefault()
        onSelect(items[selectedIndex], selectedIndex)
      }
    },
    [enabled, items, altKeyItems, selectedIndex, onSelect, searchInputRef, zoneRef, listRef, triggerBounce, getItemId, itemIdToIndex, altKeyItemIdToIndex, activateOnAltNav]
  )

  // Add keyboard listener
  useEffect(() => {
    if (!enabled) return

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, handleKeyDown])

  // Auto-scroll selected item into view
  useEffect(() => {
    if (selectedIndex < 0 || !listRef.current || !items[selectedIndex]) return

    const itemId = getItemId(items[selectedIndex])
    const selector = `[${itemAttribute}="${CSS.escape(itemId)}"]`
    const element = listRef.current.querySelector(selector)
    element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedIndex, items, listRef, getItemId, itemAttribute])

  // Helper to get props for each item
  const getItemProps = useCallback(
    (index: number) => ({
      'data-selected': index === selectedIndex,
      onMouseEnter: (e: React.MouseEvent) => {
        if (isKeyboardNav) return
        // Ignore scroll-induced enters: when the list scrolls (keyboard auto-scroll or mouse wheel),
        // items pass under a stationary cursor, triggering onMouseEnter. We detect this by checking
        // whether the mouse actually moved to new coordinates.
        const prev = lastMousePosRef.current
        const x = e.clientX
        const y = e.clientY
        if (prev && prev.x === x && prev.y === y) return
        lastMousePosRef.current = { x, y }
        setSelectedIndex(index)
      },
      onMouseMove: (e: React.MouseEvent) => {
        // Only exit keyboard nav mode when the mouse ACTUALLY moves to new coordinates.
        // scrollIntoView causes the browser to fire mousemove on items passing under a
        // stationary cursor — we must ignore those phantom events.
        const prev = lastMousePosRef.current
        const x = e.clientX
        const y = e.clientY
        if (prev && prev.x === x && prev.y === y) return
        lastMousePosRef.current = { x, y }
        if (isKeyboardNav) {
          setIsKeyboardNav(false)
        }
      },
    }),
    [selectedIndex, isKeyboardNav]
  )

  // Helper to get the data attribute for scroll targeting
  const getItemAttribute = useCallback(
    (index: number): Record<string, string> => {
      if (!items[index]) return {}
      return { [itemAttribute]: getItemId(items[index]) }
    },
    [items, getItemId, itemAttribute]
  )

  // Helper to get props for the list container (clears hover on mouse leave)
  const getContainerProps = useCallback(
    () => ({
      onMouseLeave: () => {
        // Clear hover highlight when mouse leaves the list (unless in keyboard nav mode)
        if (!isKeyboardNav) {
          setSelectedIndex(-1)
        }
      },
    }),
    [isKeyboardNav]
  )

  return {
    selectedIndex,
    setSelectedIndex,
    isKeyboardNav,
    getItemProps,
    getItemAttribute,
    getContainerProps,
  }
}
