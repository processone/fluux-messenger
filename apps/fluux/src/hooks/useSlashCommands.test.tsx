import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSlashCommands } from './useSlashCommands'

describe('useSlashCommands', () => {
  describe('handleCommand', () => {
    it('should return true and call sendEasterEgg for /christmas command', async () => {
      const sendEasterEgg = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useSlashCommands({ sendEasterEgg })
      )

      let handled: boolean
      await act(async () => {
        handled = await result.current.handleCommand('/christmas')
      })

      expect(handled!).toBe(true)
      expect(sendEasterEgg).toHaveBeenCalledTimes(1)
      expect(sendEasterEgg).toHaveBeenCalledWith('christmas')
    })

    it('should be case insensitive', async () => {
      const sendEasterEgg = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useSlashCommands({ sendEasterEgg })
      )

      await act(async () => {
        await result.current.handleCommand('/CHRISTMAS')
      })
      expect(sendEasterEgg).toHaveBeenCalledTimes(1)

      await act(async () => {
        await result.current.handleCommand('/Christmas')
      })
      expect(sendEasterEgg).toHaveBeenCalledTimes(2)

      await act(async () => {
        await result.current.handleCommand('/ChRiStMaS')
      })
      expect(sendEasterEgg).toHaveBeenCalledTimes(3)
    })

    it('should handle leading/trailing whitespace', async () => {
      const sendEasterEgg = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useSlashCommands({ sendEasterEgg })
      )

      await act(async () => {
        await result.current.handleCommand('  /christmas  ')
      })

      expect(sendEasterEgg).toHaveBeenCalledTimes(1)
    })

    it('should return false for unrecognized commands', async () => {
      const sendEasterEgg = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useSlashCommands({ sendEasterEgg })
      )

      let handled: boolean
      await act(async () => {
        handled = await result.current.handleCommand('/unknown')
      })

      expect(handled!).toBe(false)
      expect(sendEasterEgg).not.toHaveBeenCalled()
    })

    it('should return false for regular messages', async () => {
      const sendEasterEgg = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useSlashCommands({ sendEasterEgg })
      )

      let handled: boolean
      await act(async () => {
        handled = await result.current.handleCommand('hello world')
      })

      expect(handled!).toBe(false)
      expect(sendEasterEgg).not.toHaveBeenCalled()
    })

    it('should return false for messages containing command as substring', async () => {
      const sendEasterEgg = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useSlashCommands({ sendEasterEgg })
      )

      let handled: boolean
      await act(async () => {
        handled = await result.current.handleCommand('I love /christmas!')
      })

      expect(handled!).toBe(false)
      expect(sendEasterEgg).not.toHaveBeenCalled()
    })

    it('should return false for command with extra text', async () => {
      const sendEasterEgg = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useSlashCommands({ sendEasterEgg })
      )

      let handled: boolean
      await act(async () => {
        handled = await result.current.handleCommand('/christmas everyone')
      })

      expect(handled!).toBe(false)
      expect(sendEasterEgg).not.toHaveBeenCalled()
    })

    it('should return false for empty string', async () => {
      const sendEasterEgg = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useSlashCommands({ sendEasterEgg })
      )

      let handled: boolean
      await act(async () => {
        handled = await result.current.handleCommand('')
      })

      expect(handled!).toBe(false)
      expect(sendEasterEgg).not.toHaveBeenCalled()
    })

    it('should return false for whitespace only', async () => {
      const sendEasterEgg = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useSlashCommands({ sendEasterEgg })
      )

      let handled: boolean
      await act(async () => {
        handled = await result.current.handleCommand('   ')
      })

      expect(handled!).toBe(false)
      expect(sendEasterEgg).not.toHaveBeenCalled()
    })
  })

})
