import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useModalManager, type ModalName } from './useModalManager'

describe('useModalManager', () => {
  describe('initial state', () => {
    it('should initialize all modals as closed', () => {
      const { result } = renderHook(() => useModalManager())

      expect(result.current.state).toEqual({
        commandPalette: false,
        shortcutHelp: false,
        presenceMenu: false,
        quickChat: false,
        addContact: false,
        joinRoom: false,
      })
    })

    it('should have isAnyOpen as false initially', () => {
      const { result } = renderHook(() => useModalManager())
      expect(result.current.isAnyOpen).toBe(false)
    })

    it('should return null escape handler when no modal is open', () => {
      const { result } = renderHook(() => useModalManager())
      expect(result.current.getEscapeHandler()).toBeNull()
    })
  })

  describe('open action', () => {
    it('should open a specific modal', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.open('commandPalette')
      })

      expect(result.current.state.commandPalette).toBe(true)
      expect(result.current.isAnyOpen).toBe(true)
    })

    it('should open multiple modals independently', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.open('commandPalette')
        result.current.actions.open('quickChat')
      })

      expect(result.current.state.commandPalette).toBe(true)
      expect(result.current.state.quickChat).toBe(true)
      expect(result.current.state.shortcutHelp).toBe(false)
    })
  })

  describe('close action', () => {
    it('should close a specific modal', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.open('shortcutHelp')
      })

      expect(result.current.state.shortcutHelp).toBe(true)

      act(() => {
        result.current.actions.close('shortcutHelp')
      })

      expect(result.current.state.shortcutHelp).toBe(false)
      expect(result.current.isAnyOpen).toBe(false)
    })

    it('should not affect other modals when closing one', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.open('commandPalette')
        result.current.actions.open('quickChat')
      })

      act(() => {
        result.current.actions.close('commandPalette')
      })

      expect(result.current.state.commandPalette).toBe(false)
      expect(result.current.state.quickChat).toBe(true)
    })
  })

  describe('toggle action', () => {
    it('should toggle a closed modal to open', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.toggle('presenceMenu')
      })

      expect(result.current.state.presenceMenu).toBe(true)
    })

    it('should toggle an open modal to closed', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.open('presenceMenu')
      })

      act(() => {
        result.current.actions.toggle('presenceMenu')
      })

      expect(result.current.state.presenceMenu).toBe(false)
    })
  })

  describe('closeAll action', () => {
    it('should close all open modals', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.open('commandPalette')
        result.current.actions.open('shortcutHelp')
        result.current.actions.open('quickChat')
      })

      expect(result.current.isAnyOpen).toBe(true)

      act(() => {
        result.current.actions.closeAll()
      })

      expect(result.current.state).toEqual({
        commandPalette: false,
        shortcutHelp: false,
        presenceMenu: false,
        quickChat: false,
        addContact: false,
        joinRoom: false,
      })
      expect(result.current.isAnyOpen).toBe(false)
    })
  })

  describe('closeTopmost action', () => {
    it('should return false when no modal is open', () => {
      const { result } = renderHook(() => useModalManager())

      let closed: boolean
      act(() => {
        closed = result.current.actions.closeTopmost()
      })

      expect(closed!).toBe(false)
    })

    it('should close the single open modal and return true', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.open('quickChat')
      })

      let closed: boolean
      act(() => {
        closed = result.current.actions.closeTopmost()
      })

      expect(closed!).toBe(true)
      expect(result.current.state.quickChat).toBe(false)
    })

    it('should close modals in priority order (commandPalette first)', () => {
      const { result } = renderHook(() => useModalManager())

      // Open in reverse priority order
      act(() => {
        result.current.actions.open('addContact')
        result.current.actions.open('quickChat')
        result.current.actions.open('presenceMenu')
        result.current.actions.open('shortcutHelp')
        result.current.actions.open('commandPalette')
      })

      // Close in priority order
      const expectedOrder: ModalName[] = [
        'commandPalette',
        'shortcutHelp',
        'presenceMenu',
        'quickChat',
        'addContact',
      ]

      for (const expectedModal of expectedOrder) {
        // Verify this modal is open
        expect(result.current.state[expectedModal]).toBe(true)

        act(() => {
          result.current.actions.closeTopmost()
        })

        // Verify it's now closed
        expect(result.current.state[expectedModal]).toBe(false)
      }

      expect(result.current.isAnyOpen).toBe(false)
    })

    it('should skip closed modals and close next in priority', () => {
      const { result } = renderHook(() => useModalManager())

      // Open only quickChat (lower priority)
      act(() => {
        result.current.actions.open('quickChat')
      })

      act(() => {
        result.current.actions.closeTopmost()
      })

      expect(result.current.state.quickChat).toBe(false)
    })
  })

  describe('getEscapeHandler', () => {
    it('should return null when no modal is open', () => {
      const { result } = renderHook(() => useModalManager())
      expect(result.current.getEscapeHandler()).toBeNull()
    })

    it('should return handler that closes the topmost modal', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.open('shortcutHelp')
      })

      const handler = result.current.getEscapeHandler()
      expect(handler).not.toBeNull()

      act(() => {
        handler!()
      })

      expect(result.current.state.shortcutHelp).toBe(false)
    })

    it('should return handler for highest priority open modal', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.open('addContact')
        result.current.actions.open('commandPalette')
      })

      const handler = result.current.getEscapeHandler()
      expect(handler).not.toBeNull()

      act(() => {
        handler!()
      })

      // Should close commandPalette (higher priority), not addContact
      expect(result.current.state.commandPalette).toBe(false)
      expect(result.current.state.addContact).toBe(true)
    })
  })

  describe('isAnyOpen', () => {
    it('should be false when all modals are closed', () => {
      const { result } = renderHook(() => useModalManager())
      expect(result.current.isAnyOpen).toBe(false)
    })

    it('should be true when at least one modal is open', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.open('addContact')
      })

      expect(result.current.isAnyOpen).toBe(true)
    })

    it('should update correctly when modals open and close', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.open('quickChat')
      })
      expect(result.current.isAnyOpen).toBe(true)

      act(() => {
        result.current.actions.close('quickChat')
      })
      expect(result.current.isAnyOpen).toBe(false)
    })
  })

  describe('joinRoom modal', () => {
    it('should open and close the joinRoom modal', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.open('joinRoom')
      })
      expect(result.current.state.joinRoom).toBe(true)

      act(() => {
        result.current.actions.close('joinRoom')
      })
      expect(result.current.state.joinRoom).toBe(false)
    })

    it('should close joinRoom via closeTopmost', () => {
      const { result } = renderHook(() => useModalManager())

      act(() => {
        result.current.actions.open('joinRoom')
      })

      let closed: boolean | undefined
      act(() => {
        closed = result.current.actions.closeTopmost()
      })

      expect(closed).toBe(true)
      expect(result.current.state.joinRoom).toBe(false)
    })
  })
})
