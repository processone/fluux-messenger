import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFocusZones, type FocusZoneRefs } from './useFocusZones'

// Helper to create mock refs with focusable elements
function createMockRefs(): FocusZoneRefs {
  const sidebarEl = document.createElement('div')
  sidebarEl.tabIndex = 0
  const mainContentEl = document.createElement('div')
  mainContentEl.tabIndex = 0
  const composerEl = document.createElement('div')
  composerEl.tabIndex = 0

  document.body.appendChild(sidebarEl)
  document.body.appendChild(mainContentEl)
  document.body.appendChild(composerEl)

  return {
    sidebarList: { current: sidebarEl },
    mainContent: { current: mainContentEl },
    composer: { current: composerEl },
  }
}

function cleanupMockRefs(refs: FocusZoneRefs) {
  refs.sidebarList.current?.remove()
  refs.mainContent.current?.remove()
  refs.composer.current?.remove()
}

describe('useFocusZones', () => {
  let refs: FocusZoneRefs

  beforeEach(() => {
    refs = createMockRefs()
  })

  afterEach(() => {
    cleanupMockRefs(refs)
  })

  describe('Tab key cycling', () => {
    it('should focus sidebar when Tab pressed outside any zone', () => {
      renderHook(() => useFocusZones(refs))

      // Focus is not in any zone initially
      document.body.focus()

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
      })

      expect(document.activeElement).toBe(refs.sidebarList.current)
    })

    it('should cycle to next zone on Tab', () => {
      renderHook(() => useFocusZones(refs))

      // Start in sidebar
      refs.sidebarList.current?.focus()

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
      })

      expect(document.activeElement).toBe(refs.mainContent.current)
    })

    it('should cycle to previous zone on Shift+Tab', () => {
      renderHook(() => useFocusZones(refs))

      // Start in mainContent
      refs.mainContent.current?.focus()

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))
      })

      expect(document.activeElement).toBe(refs.sidebarList.current)
    })

    it('should wrap around from composer to sidebar on Tab', () => {
      renderHook(() => useFocusZones(refs))

      // Start in composer
      refs.composer.current?.focus()

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
      })

      expect(document.activeElement).toBe(refs.sidebarList.current)
    })
  })

  describe('Arrow key handling outside zones', () => {
    it('should focus sidebar when ArrowDown pressed outside any zone', () => {
      renderHook(() => useFocusZones(refs))

      // Focus is not in any zone
      document.body.focus()

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      expect(document.activeElement).toBe(refs.sidebarList.current)
    })

    it('should focus sidebar when ArrowUp pressed outside any zone', () => {
      renderHook(() => useFocusZones(refs))

      // Focus is not in any zone
      document.body.focus()

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
      })

      expect(document.activeElement).toBe(refs.sidebarList.current)
    })

    it('should NOT intercept arrow keys when focus is in a textarea outside zones', () => {
      renderHook(() => useFocusZones(refs))

      // Create a textarea outside any zone (e.g., XMPP console input)
      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      textarea.focus()

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
      })

      // Focus should stay on textarea, not move to sidebar
      expect(document.activeElement).toBe(textarea)
      expect(document.activeElement).not.toBe(refs.sidebarList.current)

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      expect(document.activeElement).toBe(textarea)
      expect(document.activeElement).not.toBe(refs.sidebarList.current)

      document.body.removeChild(textarea)
    })

    it('should NOT intercept arrow keys when focus is in an input outside zones', () => {
      renderHook(() => useFocusZones(refs))

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
      })

      expect(document.activeElement).toBe(input)
      expect(document.activeElement).not.toBe(refs.sidebarList.current)

      document.body.removeChild(input)
    })

    it('should NOT intercept arrow keys when inside a zone', () => {
      renderHook(() => useFocusZones(refs))

      // Focus inside mainContent zone
      refs.mainContent.current?.focus()

      const preventDefaultSpy = vi.fn()
      const event = new KeyboardEvent('keydown', { key: 'ArrowDown' })
      Object.defineProperty(event, 'preventDefault', { value: preventDefaultSpy })

      act(() => {
        window.dispatchEvent(event)
      })

      // Should NOT call preventDefault - let the zone handle it
      expect(preventDefaultSpy).not.toHaveBeenCalled()
      // Focus should stay in mainContent
      expect(document.activeElement).toBe(refs.mainContent.current)
    })

    it('should NOT intercept arrow keys for a textarea inside the composer zone', () => {
      renderHook(() => useFocusZones(refs))

      // Create a textarea inside the composer zone (like MessageComposer)
      const composerTextarea = document.createElement('textarea')
      refs.composer.current!.appendChild(composerTextarea)
      composerTextarea.focus()

      const preventDefaultSpy = vi.fn()
      const event = new KeyboardEvent('keydown', { key: 'ArrowUp' })
      Object.defineProperty(event, 'preventDefault', { value: preventDefaultSpy })

      act(() => {
        window.dispatchEvent(event)
      })

      // Should NOT call preventDefault - the zone (and React handler) handle it
      // This allows MessageComposer's ArrowUp-to-edit-last-message to work
      expect(preventDefaultSpy).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(composerTextarea)
      expect(document.activeElement).not.toBe(refs.sidebarList.current)

      refs.composer.current!.removeChild(composerTextarea)
    })

    it('should NOT intercept arrow keys when focus is in the XMPP console log', () => {
      renderHook(() => useFocusZones(refs))

      // Create a div with xmpp-console-log class outside any zone
      const consoleLog = document.createElement('div')
      consoleLog.className = 'xmpp-console-log'
      consoleLog.tabIndex = 0
      document.body.appendChild(consoleLog)
      consoleLog.focus()

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      expect(document.activeElement).toBe(consoleLog)
      expect(document.activeElement).not.toBe(refs.sidebarList.current)

      document.body.removeChild(consoleLog)
    })
  })

  describe('disabled state', () => {
    it('should not handle keys when disabled', () => {
      renderHook(() => useFocusZones(refs, false))

      document.body.focus()

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
      })

      // Should not focus any zone when disabled
      expect(document.activeElement).not.toBe(refs.sidebarList.current)
    })
  })

  describe('getCurrentZone', () => {
    it('should return correct zone when element is focused', () => {
      const { result } = renderHook(() => useFocusZones(refs))

      refs.mainContent.current?.focus()

      expect(result.current.getCurrentZone()).toBe('mainContent')
    })

    it('should return null when outside all zones', () => {
      const { result } = renderHook(() => useFocusZones(refs))

      document.body.focus()

      expect(result.current.getCurrentZone()).toBeNull()
    })
  })

  describe('focusZone', () => {
    it('should focus the specified zone', () => {
      const { result } = renderHook(() => useFocusZones(refs))

      act(() => {
        result.current.focusZone('composer')
      })

      expect(document.activeElement).toBe(refs.composer.current)
    })

    it('should return true when zone is focused successfully', () => {
      const { result } = renderHook(() => useFocusZones(refs))

      let success = false
      act(() => {
        success = result.current.focusZone('mainContent')
      })

      expect(success).toBe(true)
    })

    it('should return false when zone ref is null', () => {
      const emptyRefs: FocusZoneRefs = {
        sidebarList: { current: null },
        mainContent: { current: null },
        composer: { current: null },
      }

      const { result } = renderHook(() => useFocusZones(emptyRefs))

      let success = true
      act(() => {
        success = result.current.focusZone('sidebarList')
      })

      expect(success).toBe(false)
    })
  })

  describe('modal detection', () => {
    it('should ignore arrow keys when focus is in a modal', () => {
      renderHook(() => useFocusZones(refs))

      // Create a modal backdrop with data-modal attribute
      const modalBackdrop = document.createElement('div')
      modalBackdrop.setAttribute('data-modal', 'true')
      modalBackdrop.className = 'fixed z-50'
      document.body.appendChild(modalBackdrop)

      // Create a button inside the modal and focus it
      const modalButton = document.createElement('button')
      modalBackdrop.appendChild(modalButton)
      modalButton.focus()

      // ArrowDown should NOT focus sidebar because focus is in modal
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      })

      // Focus should stay on modal button, not move to sidebar
      expect(document.activeElement).toBe(modalButton)
      expect(document.activeElement).not.toBe(refs.sidebarList.current)

      // Cleanup
      document.body.removeChild(modalBackdrop)
    })

    it('should ignore Tab key when focus is in a modal', () => {
      renderHook(() => useFocusZones(refs))

      // Create a modal backdrop with data-modal attribute
      const modalBackdrop = document.createElement('div')
      modalBackdrop.setAttribute('data-modal', 'true')
      modalBackdrop.className = 'fixed z-50'
      document.body.appendChild(modalBackdrop)

      // Create inputs inside the modal
      const input1 = document.createElement('input')
      const input2 = document.createElement('input')
      modalBackdrop.appendChild(input1)
      modalBackdrop.appendChild(input2)
      input1.focus()

      // Tab should NOT cycle to focus zones - let browser handle modal navigation
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
      })

      // Focus should not have moved to sidebar
      expect(document.activeElement).not.toBe(refs.sidebarList.current)
      expect(document.activeElement).not.toBe(refs.mainContent.current)
      expect(document.activeElement).not.toBe(refs.composer.current)

      // Cleanup
      document.body.removeChild(modalBackdrop)
    })
  })
})
