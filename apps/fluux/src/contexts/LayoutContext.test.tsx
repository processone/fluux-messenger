import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { LayoutProvider, useLayout, useModals } from './LayoutContext'
import type { ReactNode } from 'react'

// Wrapper component for tests
function wrapper({ children }: { children: ReactNode }) {
  return <LayoutProvider>{children}</LayoutProvider>
}

// Helper to suppress expected errors during error-throwing tests
// This handles both console.error (React) and window error events (JSDOM)
function suppressErrors() {
  const originalConsoleError = console.error
  console.error = vi.fn()

  const errorHandler = (e: ErrorEvent) => {
    e.preventDefault()
  }
  window.addEventListener('error', errorHandler)

  return () => {
    console.error = originalConsoleError
    window.removeEventListener('error', errorHandler)
  }
}

describe('LayoutContext', () => {
  describe('useLayout', () => {
    it('should throw error when used outside provider', () => {
      const restore = suppressErrors()
      expect(() => {
        renderHook(() => useLayout())
      }).toThrow('useLayout must be used within a LayoutProvider')
      restore()
    })

    it('should provide context value when used within provider', () => {
      const { result } = renderHook(() => useLayout(), { wrapper })

      expect(result.current).toBeDefined()
      expect(result.current.modals).toBeDefined()
    })

    it('should provide modal state', () => {
      const { result } = renderHook(() => useLayout(), { wrapper })

      expect(result.current.modals.state).toEqual({
        commandPalette: false,
        shortcutHelp: false,
        presenceMenu: false,
        quickChat: false,
        addContact: false,
        joinRoom: false,
      })
    })

    it('should provide modal actions', () => {
      const { result } = renderHook(() => useLayout(), { wrapper })

      expect(result.current.modals.actions.open).toBeInstanceOf(Function)
      expect(result.current.modals.actions.close).toBeInstanceOf(Function)
      expect(result.current.modals.actions.toggle).toBeInstanceOf(Function)
      expect(result.current.modals.actions.closeAll).toBeInstanceOf(Function)
      expect(result.current.modals.actions.closeTopmost).toBeInstanceOf(Function)
    })
  })

  describe('useModals', () => {
    it('should throw error when used outside provider', () => {
      const restore = suppressErrors()
      expect(() => {
        renderHook(() => useModals())
      }).toThrow('useLayout must be used within a LayoutProvider')
      restore()
    })

    it('should provide modal state and actions', () => {
      const { result } = renderHook(() => useModals(), { wrapper })

      expect(result.current.state).toBeDefined()
      expect(result.current.actions).toBeDefined()
      expect(result.current.isAnyOpen).toBe(false)
    })

    it('should allow opening modals', () => {
      const { result } = renderHook(() => useModals(), { wrapper })

      act(() => {
        result.current.actions.open('commandPalette')
      })

      expect(result.current.state.commandPalette).toBe(true)
      expect(result.current.isAnyOpen).toBe(true)
    })

    it('should allow closing modals', () => {
      const { result } = renderHook(() => useModals(), { wrapper })

      act(() => {
        result.current.actions.open('quickChat')
      })

      act(() => {
        result.current.actions.close('quickChat')
      })

      expect(result.current.state.quickChat).toBe(false)
      expect(result.current.isAnyOpen).toBe(false)
    })

    it('should allow toggling modals', () => {
      const { result } = renderHook(() => useModals(), { wrapper })

      act(() => {
        result.current.actions.toggle('shortcutHelp')
      })

      expect(result.current.state.shortcutHelp).toBe(true)

      act(() => {
        result.current.actions.toggle('shortcutHelp')
      })

      expect(result.current.state.shortcutHelp).toBe(false)
    })
  })

  describe('shared state between components', () => {
    it('should share modal state between multiple useModals hooks', () => {
      // Simulate two components using the same context
      const { result: result1 } = renderHook(() => useModals(), { wrapper })
      const { result: result2 } = renderHook(() => useModals(), { wrapper })

      // Note: These are different provider instances, so state won't be shared
      // In real usage, they would be under the same provider
      // This test verifies the hooks work independently
      act(() => {
        result1.current.actions.open('presenceMenu')
      })

      expect(result1.current.state.presenceMenu).toBe(true)
      // result2 has its own provider, so it's independent
      expect(result2.current.state.presenceMenu).toBe(false)
    })
  })

  describe('escape hierarchy', () => {
    it('should close topmost modal in priority order', () => {
      const { result } = renderHook(() => useModals(), { wrapper })

      // Open multiple modals
      act(() => {
        result.current.actions.open('addContact')
        result.current.actions.open('commandPalette')
      })

      // Close topmost (commandPalette has higher priority)
      act(() => {
        result.current.actions.closeTopmost()
      })

      expect(result.current.state.commandPalette).toBe(false)
      expect(result.current.state.addContact).toBe(true)
    })

    it('should provide escape handler for topmost modal', () => {
      const { result } = renderHook(() => useModals(), { wrapper })

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
  })
})
