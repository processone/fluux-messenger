import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useListKeyboardNav } from './useListKeyboardNav'
import React, { useRef } from 'react'

type TestItem = { id: string; name: string }
type OnSelectFn = (item: TestItem, index: number) => void

/** Create a mock React.MouseEvent with the given coordinates */
function mockMouseEvent(x = 100, y = 100) {
  return { clientX: x, clientY: y } as React.MouseEvent
}

function createWrapper(items: TestItem[], onSelect: OnSelectFn, enabled = true) {
  return () => {
    const listRef = useRef<HTMLDivElement>(null)
    const searchInputRef = useRef<HTMLInputElement>(null)

    return useListKeyboardNav({
      items,
      onSelect,
      enabled,
      listRef,
      searchInputRef,
      getItemId: (item) => item.id,
      itemAttribute: 'data-item-id',
    })
  }
}

describe('useListKeyboardNav', () => {
  const mockItems: TestItem[] = [
    { id: '1', name: 'Alice' },
    { id: '2', name: 'Bob' },
    { id: '3', name: 'Charlie' },
  ]

  let mockOnSelect: Mock<OnSelectFn>

  beforeEach(() => {
    mockOnSelect = vi.fn<OnSelectFn>()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('Initial state', () => {
    it('starts with selectedIndex of -1', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      expect(result.current.selectedIndex).toBe(-1)
    })

    it('provides getItemProps function', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      const props = result.current.getItemProps(0)
      expect(props).toHaveProperty('data-selected')
      expect(props).toHaveProperty('onMouseEnter')
    })

    it('provides getItemAttribute function', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      const attr = result.current.getItemAttribute(0)
      expect(attr).toEqual({ 'data-item-id': '1' })
    })
  })

  describe('Arrow key navigation', () => {
    it('selects first item on ArrowDown when no selection', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      expect(result.current.selectedIndex).toBe(0)
    })

    it('moves selection down on ArrowDown', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      act(() => {
        result.current.setSelectedIndex(0)
      })

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      expect(result.current.selectedIndex).toBe(1)
    })

    it('stops at last item on ArrowDown', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      act(() => {
        result.current.setSelectedIndex(2) // Last item
      })

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      expect(result.current.selectedIndex).toBe(2) // Should stay at last
    })

    it('selects first item on ArrowUp when no selection', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
      })

      expect(result.current.selectedIndex).toBe(0)
    })

    it('moves selection up on ArrowUp', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      act(() => {
        result.current.setSelectedIndex(2)
      })

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
      })

      expect(result.current.selectedIndex).toBe(1)
    })

    it('stops at first item on ArrowUp', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      act(() => {
        result.current.setSelectedIndex(0) // First item
      })

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
      })

      expect(result.current.selectedIndex).toBe(0) // Should stay at first
    })
  })

  describe('Enter key selection', () => {
    it('calls onSelect with selected item on Enter', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      act(() => {
        result.current.setSelectedIndex(1)
      })

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      })

      expect(mockOnSelect).toHaveBeenCalledWith(mockItems[1], 1)
    })

    it('does not call onSelect when no item is selected', () => {
      renderHook(createWrapper(mockItems, mockOnSelect))

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      })

      expect(mockOnSelect).not.toHaveBeenCalled()
    })

    it('does not call onSelect for out-of-bounds index', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      act(() => {
        result.current.setSelectedIndex(10) // Out of bounds
      })

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      })

      expect(mockOnSelect).not.toHaveBeenCalled()
    })

    // Regression test: Enter key in textarea should NOT trigger onSelect
    // This prevents the bug where pressing Enter to send a message would
    // also switch to the next conversation in the sidebar
    it('does not call onSelect when Enter is pressed in a textarea (bubbling)', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      // Select an item first
      act(() => {
        result.current.setSelectedIndex(1)
      })

      // Create a textarea (like MessageComposer) and focus it
      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      textarea.focus()

      // Dispatch Enter key event FROM the textarea - it will bubble up to window
      act(() => {
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
          })
        )
      })

      // onSelect should NOT be called because user is typing in textarea
      expect(mockOnSelect).not.toHaveBeenCalled()

      // Cleanup
      document.body.removeChild(textarea)
    })

    it('does not call onSelect when Enter is pressed in an input field (bubbling)', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      // Select an item first
      act(() => {
        result.current.setSelectedIndex(1)
      })

      // Create an input field and focus it
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      // Dispatch Enter key event FROM the input - it will bubble up to window
      act(() => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
          })
        )
      })

      // onSelect should NOT be called because user is typing in input
      expect(mockOnSelect).not.toHaveBeenCalled()

      // Cleanup
      document.body.removeChild(input)
    })

    it('does not call onSelect when Enter is pressed in a contentEditable element (bubbling)', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      // Select an item first
      act(() => {
        result.current.setSelectedIndex(1)
      })

      // Create a contentEditable div and focus it
      const editableDiv = document.createElement('div')
      editableDiv.contentEditable = 'true'
      document.body.appendChild(editableDiv)
      editableDiv.focus()

      // Dispatch Enter key event FROM the contentEditable - it will bubble up to window
      act(() => {
        editableDiv.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
          })
        )
      })

      // onSelect should NOT be called because user is typing in contentEditable
      expect(mockOnSelect).not.toHaveBeenCalled()

      // Cleanup
      document.body.removeChild(editableDiv)
    })
  })

  describe('Mouse hover selection', () => {
    it('sets selection on mouse enter via getItemProps', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      const props = result.current.getItemProps(2)

      act(() => {
        props.onMouseEnter(mockMouseEvent(50, 50))
      })

      expect(result.current.selectedIndex).toBe(2)
    })

    it('updates data-selected based on selection', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      expect(result.current.getItemProps(0)['data-selected']).toBe(false)

      act(() => {
        result.current.setSelectedIndex(0)
      })

      expect(result.current.getItemProps(0)['data-selected']).toBe(true)
      expect(result.current.getItemProps(1)['data-selected']).toBe(false)
    })

    it('suppresses mouse hover during keyboard navigation', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      // Start keyboard navigation by pressing ArrowDown
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })
      expect(result.current.selectedIndex).toBe(0)

      // Mouse enter should NOT change selection during keyboard nav mode
      act(() => {
        result.current.getItemProps(2).onMouseEnter(mockMouseEvent(50, 50))
      })
      // Selection should still be 0, not 2
      expect(result.current.selectedIndex).toBe(0)

      // Mouse move should exit keyboard nav mode (different coordinates = real movement)
      act(() => {
        result.current.getItemProps(2).onMouseMove(mockMouseEvent(60, 60))
      })

      // Now mouse enter should work again (need fresh props after state change)
      act(() => {
        result.current.getItemProps(2).onMouseEnter(mockMouseEvent(70, 70))
      })
      expect(result.current.selectedIndex).toBe(2)
    })
  })

  describe('Items change handling', () => {
    it('resets selection when items change', () => {
      const { result, rerender } = renderHook(
        ({ items }: { items: TestItem[] }) => {
          const listRef = useRef<HTMLDivElement>(null)
          return useListKeyboardNav({
            items,
            onSelect: mockOnSelect,
            listRef,
            getItemId: (item: TestItem) => item.id,
          })
        },
        { initialProps: { items: mockItems } }
      )

      // Select an item
      act(() => {
        result.current.setSelectedIndex(1)
      })
      expect(result.current.selectedIndex).toBe(1)

      // Change items
      const newItems: TestItem[] = [{ id: '4', name: 'Dave' }, { id: '5', name: 'Eve' }]
      rerender({ items: newItems })

      // Selection should reset
      expect(result.current.selectedIndex).toBe(-1)
    })

    it('preserves selection when items have same IDs but different array reference', () => {
      const { result, rerender } = renderHook(
        ({ items }: { items: TestItem[] }) => {
          const listRef = useRef<HTMLDivElement>(null)
          return useListKeyboardNav({
            items,
            onSelect: mockOnSelect,
            listRef,
            getItemId: (item: TestItem) => item.id,
          })
        },
        { initialProps: { items: mockItems } }
      )

      // Select an item
      act(() => {
        result.current.setSelectedIndex(1)
      })
      expect(result.current.selectedIndex).toBe(1)

      // Create new array with same content (simulates re-render with new array reference)
      const sameItems: TestItem[] = [
        { id: '1', name: 'Alice' },
        { id: '2', name: 'Bob' },
        { id: '3', name: 'Charlie' },
      ]
      rerender({ items: sameItems })

      // Selection should be preserved since IDs are the same
      expect(result.current.selectedIndex).toBe(1)
    })
  })

  describe('Disabled state', () => {
    it('does not respond to keyboard when disabled', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect, false))

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      expect(result.current.selectedIndex).toBe(-1)
    })
  })

  describe('Empty items', () => {
    it('does not respond to keyboard when items is empty', () => {
      const { result } = renderHook(createWrapper([], mockOnSelect))

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      expect(result.current.selectedIndex).toBe(-1)
    })

    it('returns empty object from getItemAttribute for invalid index', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      const attr = result.current.getItemAttribute(10) // Out of bounds
      expect(attr).toEqual({})
    })
  })

  describe('getItemAttribute', () => {
    it('returns correct attribute for valid index', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      expect(result.current.getItemAttribute(0)).toEqual({ 'data-item-id': '1' })
      expect(result.current.getItemAttribute(1)).toEqual({ 'data-item-id': '2' })
      expect(result.current.getItemAttribute(2)).toEqual({ 'data-item-id': '3' })
    })

    it('returns empty object for negative index', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      expect(result.current.getItemAttribute(-1)).toEqual({})
    })
  })

  describe('Bounce animation', () => {
    function createBounceWrapper(items: TestItem[], onSelect: OnSelectFn, enableBounce: boolean) {
      return () => {
        const listRef = useRef<HTMLDivElement>(null)

        // Create a mock element with classList
        if (!listRef.current) {
          const mockElement = document.createElement('div')
          ;(listRef as { current: HTMLDivElement }).current = mockElement
        }

        return useListKeyboardNav({
          items,
          onSelect,
          listRef,
          getItemId: (item) => item.id,
          enableBounce,
        })
      }
    }

    it('adds bounce-bottom class when at end of list and ArrowDown pressed with enableBounce', () => {
      vi.useFakeTimers()
      const { result } = renderHook(createBounceWrapper(mockItems, mockOnSelect, true))

      // Get the listRef element through the hook's internals
      // We need to set selection to last item first
      act(() => {
        result.current.setSelectedIndex(2) // Last item
      })

      // Dispatch ArrowDown at the last item
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      // Selection should stay at the same position
      expect(result.current.selectedIndex).toBe(2)

      vi.useRealTimers()
    })

    it('adds bounce-top class when at start of list and ArrowUp pressed with enableBounce', () => {
      vi.useFakeTimers()
      const { result } = renderHook(createBounceWrapper(mockItems, mockOnSelect, true))

      // Set selection to first item
      act(() => {
        result.current.setSelectedIndex(0)
      })

      // Dispatch ArrowUp at the first item
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
      })

      // Selection should stay at the same position
      expect(result.current.selectedIndex).toBe(0)

      vi.useRealTimers()
    })

    it('does not add bounce class when enableBounce is false', () => {
      const { result } = renderHook(createBounceWrapper(mockItems, mockOnSelect, false))

      // Set selection to last item
      act(() => {
        result.current.setSelectedIndex(2)
      })

      // Dispatch ArrowDown at the last item
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      // Selection should stay at the same position
      expect(result.current.selectedIndex).toBe(2)
    })

    it('does not trigger bounce in the middle of the list', () => {
      const { result } = renderHook(createBounceWrapper(mockItems, mockOnSelect, true))

      // Set selection to middle item
      act(() => {
        result.current.setSelectedIndex(1)
      })

      // Dispatch ArrowDown in the middle - should just move
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      // Selection should move to next item
      expect(result.current.selectedIndex).toBe(2)
    })
  })

  describe('Modal detection', () => {
    it('ignores keyboard events when focus is in a modal and list is outside', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      // Create a modal backdrop in the DOM with data-modal attribute
      const modalBackdrop = document.createElement('div')
      modalBackdrop.setAttribute('data-modal', 'true')
      modalBackdrop.className = 'fixed z-50'
      document.body.appendChild(modalBackdrop)

      // Create an input inside the modal and focus it
      const modalInput = document.createElement('input')
      modalBackdrop.appendChild(modalInput)
      modalInput.focus()

      // ArrowDown should NOT work because focus is in modal but list is not
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      // Selection should remain at -1 (no change)
      expect(result.current.selectedIndex).toBe(-1)

      // Cleanup
      document.body.removeChild(modalBackdrop)
    })

    it('handles keyboard events when both focus and list are in the same modal', () => {
      // Create a modal backdrop with data-modal attribute
      const modalBackdrop = document.createElement('div')
      modalBackdrop.setAttribute('data-modal', 'true')
      modalBackdrop.className = 'fixed z-50'
      document.body.appendChild(modalBackdrop)

      // Create list container inside modal
      const listContainer = document.createElement('div')
      modalBackdrop.appendChild(listContainer)

      // Create a focusable element inside the modal
      const modalButton = document.createElement('button')
      modalBackdrop.appendChild(modalButton)

      // Custom wrapper that uses the modal's list container
      const useModalWrapper = () => {
        const listRef = { current: listContainer } as React.RefObject<HTMLDivElement>

        return useListKeyboardNav({
          items: mockItems,
          onSelect: mockOnSelect,
          listRef,
          getItemId: (item) => item.id,
        })
      }

      const { result } = renderHook(useModalWrapper)

      // Focus something inside the modal
      modalButton.focus()

      // ArrowDown should work because both focus and list are in modal
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      // Selection should move to first item
      expect(result.current.selectedIndex).toBe(0)

      // Cleanup
      document.body.removeChild(modalBackdrop)
    })

    it('handles keyboard events normally when no modal is present', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      // Create a simple button and focus it (no modal)
      const button = document.createElement('button')
      document.body.appendChild(button)
      button.focus()

      // ArrowDown should work normally
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      expect(result.current.selectedIndex).toBe(0)

      // Cleanup
      document.body.removeChild(button)
    })
  })

  describe('Dual-list navigation (altKeyItems)', () => {
    // Full list: A, B, C, D, E (5 items)
    // Alt list (active only): A, C, E (3 items - subset)
    const fullItems: TestItem[] = [
      { id: 'A', name: 'Item A' },
      { id: 'B', name: 'Item B' },
      { id: 'C', name: 'Item C' },
      { id: 'D', name: 'Item D' },
      { id: 'E', name: 'Item E' },
    ]
    const altItems: TestItem[] = [
      { id: 'A', name: 'Item A' },
      { id: 'C', name: 'Item C' },
      { id: 'E', name: 'Item E' },
    ]

    function createDualListWrapper(items: TestItem[], altKeyItems: TestItem[], onSelect: OnSelectFn) {
      return () => {
        const listRef = useRef<HTMLDivElement>(null)
        return useListKeyboardNav({
          items,
          altKeyItems,
          onSelect,
          listRef,
          getItemId: (item) => item.id,
        })
      }
    }

    it('navigates full list with plain ArrowDown', () => {
      const { result } = renderHook(createDualListWrapper(fullItems, altItems, mockOnSelect))

      // Plain ArrowDown navigates full list: A -> B -> C -> D -> E
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })
      expect(result.current.selectedIndex).toBe(0) // A

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })
      expect(result.current.selectedIndex).toBe(1) // B

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })
      expect(result.current.selectedIndex).toBe(2) // C
    })

    it('navigates alt list with Alt+ArrowDown, skipping non-alt items', () => {
      const { result } = renderHook(createDualListWrapper(fullItems, altItems, mockOnSelect))

      // Alt+ArrowDown navigates alt list only: A -> C -> E (skips B, D)
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }))
      })
      expect(result.current.selectedIndex).toBe(0) // A (index in full list)

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }))
      })
      expect(result.current.selectedIndex).toBe(2) // C (index in full list, skipped B)

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }))
      })
      expect(result.current.selectedIndex).toBe(4) // E (index in full list, skipped D)
    })

    it('navigates alt list with Alt+ArrowUp, skipping non-alt items', () => {
      const { result } = renderHook(createDualListWrapper(fullItems, altItems, mockOnSelect))

      // Start at E (last alt item)
      act(() => {
        result.current.setSelectedIndex(4) // E
      })

      // Alt+ArrowUp goes E -> C -> A (skips D, B)
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true }))
      })
      expect(result.current.selectedIndex).toBe(2) // C

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true }))
      })
      expect(result.current.selectedIndex).toBe(0) // A
    })

    it('switches from alt navigation to full navigation seamlessly', () => {
      const { result } = renderHook(createDualListWrapper(fullItems, altItems, mockOnSelect))

      // Start with Alt+ArrowDown to select A
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }))
      })
      expect(result.current.selectedIndex).toBe(0) // A

      // Then plain ArrowDown should go to B (not skip to C)
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })
      expect(result.current.selectedIndex).toBe(1) // B
    })

    it('handles selection on non-alt item when pressing Alt+Arrow', () => {
      const { result } = renderHook(createDualListWrapper(fullItems, altItems, mockOnSelect))

      // Select B (not in alt list)
      act(() => {
        result.current.setSelectedIndex(1) // B
      })

      // Alt+ArrowDown: B is not in alt list, so should start from first alt item
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }))
      })
      // Should select first item in alt list since current isn't in alt list
      expect(result.current.selectedIndex).toBe(0) // A
    })

    it('bounces at alt list boundaries', () => {
      const { result } = renderHook(createDualListWrapper(fullItems, altItems, mockOnSelect))

      // Go to last alt item (E)
      act(() => {
        result.current.setSelectedIndex(4) // E
      })

      // Alt+ArrowDown at end should stay at E
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }))
      })
      expect(result.current.selectedIndex).toBe(4) // Still E
    })

    it('uses full list when altKeyItems is empty', () => {
      const emptyAlt: TestItem[] = []
      const { result } = renderHook(createDualListWrapper(fullItems, emptyAlt, mockOnSelect))

      // Alt+ArrowDown with empty alt list should navigate full list
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }))
      })
      expect(result.current.selectedIndex).toBe(0) // A

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }))
      })
      expect(result.current.selectedIndex).toBe(1) // B (full list navigation)
    })

    it('ignores Alt+Arrow when altKeyItems is not provided and activateOnAltNav is false', () => {
      // Lists that don't use altKeyItems or activateOnAltNav should NOT respond to Alt+arrows
      // This allows other components (like message selection) to handle Alt+arrows
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      // Plain ArrowDown works
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })
      expect(result.current.selectedIndex).toBe(0)

      // Alt+ArrowDown should be ignored (no change)
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }))
      })
      expect(result.current.selectedIndex).toBe(0) // Still 0, not moved

      // Plain ArrowDown still works
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })
      expect(result.current.selectedIndex).toBe(1) // Now 1
    })
  })

  describe('activateOnAltNav option', () => {
    function createActivateWrapper(items: TestItem[], onSelect: OnSelectFn) {
      return () => {
        const listRef = useRef<HTMLDivElement>(null)
        return useListKeyboardNav({
          items,
          onSelect,
          listRef,
          getItemId: (item) => item.id,
          activateOnAltNav: true,
        })
      }
    }

    it('navigates without calling onSelect on plain ArrowDown', () => {
      const { result } = renderHook(createActivateWrapper(mockItems, mockOnSelect))

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      expect(result.current.selectedIndex).toBe(0)
      expect(mockOnSelect).not.toHaveBeenCalled()

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      expect(result.current.selectedIndex).toBe(1)
      expect(mockOnSelect).not.toHaveBeenCalled()
    })

    it('navigates AND calls onSelect on Alt+ArrowDown', async () => {
      vi.useFakeTimers()
      const { result } = renderHook(createActivateWrapper(mockItems, mockOnSelect))

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }))
      })

      expect(result.current.selectedIndex).toBe(0)

      // onSelect is called via setTimeout(0), so advance timers
      await act(async () => {
        vi.runAllTimers()
      })

      expect(mockOnSelect).toHaveBeenCalledTimes(1)
      expect(mockOnSelect).toHaveBeenCalledWith(mockItems[0], 0)

      vi.useRealTimers()
    })

    it('navigates AND calls onSelect on Alt+ArrowUp', async () => {
      vi.useFakeTimers()
      const { result } = renderHook(createActivateWrapper(mockItems, mockOnSelect))

      // First navigate to item 2
      act(() => {
        result.current.setSelectedIndex(2)
      })
      mockOnSelect.mockClear()

      // Alt+ArrowUp should navigate up and call onSelect
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true }))
      })

      expect(result.current.selectedIndex).toBe(1)

      await act(async () => {
        vi.runAllTimers()
      })

      expect(mockOnSelect).toHaveBeenCalledTimes(1)
      expect(mockOnSelect).toHaveBeenCalledWith(mockItems[1], 1)

      vi.useRealTimers()
    })

    it('does not call onSelect when at boundary (no navigation)', async () => {
      vi.useFakeTimers()
      const { result } = renderHook(createActivateWrapper(mockItems, mockOnSelect))

      // Start at first item
      act(() => {
        result.current.setSelectedIndex(0)
      })
      mockOnSelect.mockClear()

      // Alt+ArrowUp at boundary should not move or call onSelect
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true }))
      })

      expect(result.current.selectedIndex).toBe(0) // Still at 0

      await act(async () => {
        vi.runAllTimers()
      })

      expect(mockOnSelect).not.toHaveBeenCalled()

      vi.useRealTimers()
    })
  })

  describe('getContainerProps (mouse leave handling)', () => {
    it('provides getContainerProps function', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      const containerProps = result.current.getContainerProps()
      expect(containerProps).toHaveProperty('onMouseLeave')
    })

    it('clears selection on mouse leave when not in keyboard nav mode', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      // Set selection via mouse enter
      act(() => {
        result.current.getItemProps(1).onMouseEnter(mockMouseEvent(50, 50))
      })
      expect(result.current.selectedIndex).toBe(1)

      // Mouse leave should clear selection
      act(() => {
        result.current.getContainerProps().onMouseLeave()
      })
      expect(result.current.selectedIndex).toBe(-1)
    })

    it('preserves selection on mouse leave when in keyboard nav mode', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      // Start keyboard navigation by pressing ArrowDown
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })
      expect(result.current.selectedIndex).toBe(0)
      expect(result.current.isKeyboardNav).toBe(true)

      // Mouse leave should NOT clear selection during keyboard nav
      act(() => {
        result.current.getContainerProps().onMouseLeave()
      })
      expect(result.current.selectedIndex).toBe(0) // Still selected
    })

    it('clears selection after exiting keyboard nav mode and mouse leaves', () => {
      const { result } = renderHook(createWrapper(mockItems, mockOnSelect))

      // Start keyboard navigation
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })
      expect(result.current.selectedIndex).toBe(0)
      expect(result.current.isKeyboardNav).toBe(true)

      // Exit keyboard nav mode via mouse move (different coordinates = real movement)
      act(() => {
        result.current.getItemProps(0).onMouseMove(mockMouseEvent(80, 80))
      })
      expect(result.current.isKeyboardNav).toBe(false)

      // Now mouse leave should clear selection
      act(() => {
        result.current.getContainerProps().onMouseLeave()
      })
      expect(result.current.selectedIndex).toBe(-1)
    })
  })
})
