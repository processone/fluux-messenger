// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useEmojiAutocomplete } from './useEmojiAutocomplete'

// Mock the emoji database with a smaller subset of test emojis
vi.mock('@emoji-mart/data', () => ({
  default: {
    emojis: {
      '+1': {
        name: 'Thumbs Up',
        skins: [{ native: '👍' }],
        keywords: ['thumbsup', 'agree', 'like', 'plusone'],
      },
      'heart': {
        name: 'Red Heart',
        skins: [{ native: '❤️' }],
        keywords: ['love', 'like'],
      },
      'smile': {
        name: 'Smiling Face',
        skins: [{ native: '😊' }],
        keywords: ['happy', 'joy'],
      },
    },
  },
}))

describe('useEmojiAutocomplete', () => {
  describe('trigger detection', () => {
    it('should not be active when no colon is typed', () => {
      const { result } = renderHook(() => useEmojiAutocomplete('hello world', 11))
      expect(result.current.state.isActive).toBe(false)
    })

    it('should not be active when a bare colon is typed', () => {
      const { result } = renderHook(() => useEmojiAutocomplete(':', 1))
      expect(result.current.state.isActive).toBe(false)
    })

    it('should be active when colon and characters are typed at start of text after data loads', async () => {
      const { result } = renderHook(() => useEmojiAutocomplete(':+', 2))
      
      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })
      expect(result.current.state.query).toBe('+')
      expect(result.current.state.triggerIndex).toBe(0)
    })

    it('should be active when colon is typed after whitespace after data loads', async () => {
      const { result } = renderHook(() => useEmojiAutocomplete('hello :hea', 10))
      
      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })
      expect(result.current.state.query).toBe('hea')
      expect(result.current.state.triggerIndex).toBe(6)
    })

    it('should not be active when colon is in the middle of a word with no preceding space', () => {
      const { result } = renderHook(() => useEmojiAutocomplete('hello:hea', 9))
      expect(result.current.state.isActive).toBe(false)
    })

    it('should not be active when query contains whitespace', () => {
      const { result } = renderHook(() => useEmojiAutocomplete(':thumbs up', 10))
      expect(result.current.state.isActive).toBe(false)
    })
  })

  describe('matching and sorting', () => {
    it('should match and load mock emojis on active trigger', async () => {
      const { result } = renderHook(() => useEmojiAutocomplete(':hea', 4))
      
      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })

      expect(result.current.state.matches.length).toBe(1)
      expect(result.current.state.matches[0]).toEqual({
        id: 'heart',
        name: 'Red Heart',
        native: '❤️',
      })
    })

    it('should match multiple emojis by keyword', async () => {
      const { result } = renderHook(() => useEmojiAutocomplete(':lik', 4))
      
      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })

      const ids = result.current.state.matches.map(m => m.id)
      expect(ids).toContain('+1')
      expect(ids).toContain('heart')
    })
  })

  describe('selection and keyboard navigation', () => {
    it('should replace target string with selected emoji', async () => {
      const { result } = renderHook(() => useEmojiAutocomplete('check this :hea and continue', 15))
      
      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })

      const { newText, newCursorPosition } = result.current.selectMatch(0)
      expect(newText).toBe('check this ❤️ and continue')
      expect(newCursorPosition).toBe(13) // trigger index (11) + ❤️ length (2)
    })

    it('should allow cycle keyboard navigation', async () => {
      const { result } = renderHook(() => useEmojiAutocomplete(':lik', 4))
      
      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })

      expect(result.current.state.selectedIndex).toBe(0)

      act(() => {
        result.current.moveSelection('down')
      })
      expect(result.current.state.selectedIndex).toBe(1)

      act(() => {
        result.current.moveSelection('down')
      })
      expect(result.current.state.selectedIndex).toBe(0) // wrapped

      act(() => {
        result.current.moveSelection('up')
      })
      expect(result.current.state.selectedIndex).toBe(1) // wrapped back
    })

    it('should allow dismissing selection', async () => {
      const { result, rerender } = renderHook(
        ({ text, cursor }) => useEmojiAutocomplete(text, cursor),
        { initialProps: { text: ':hea', cursor: 4 } }
      )

      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })

      act(() => {
        result.current.dismiss()
      })
      expect(result.current.state.isActive).toBe(false)

      // Rerendering with same trigger shouldn't reactivate it
      rerender({ text: ':heart', cursor: 6 })
      expect(result.current.state.isActive).toBe(false)
    })
  })
})
