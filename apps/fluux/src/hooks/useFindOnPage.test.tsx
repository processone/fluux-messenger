import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFindOnPage } from './useFindOnPage'

// Mock scrollToMessage — it manipulates the DOM which isn't available in tests
vi.mock('@/components/conversation/messageGrouping', () => ({
  scrollToMessage: vi.fn(),
}))

import { scrollToMessage } from '@/components/conversation/messageGrouping'

const mockScrollToMessage = scrollToMessage as ReturnType<typeof vi.fn>

interface TestMessage {
  id: string
  body?: string
}

function makeMessages(...bodies: string[]): TestMessage[] {
  // Messages array is oldest-first (matching real store order)
  return bodies.map((body, i) => ({ id: `msg-${i + 1}`, body }))
}

describe('useFindOnPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('initial state', () => {
    it('starts closed with empty search', () => {
      const { result } = renderHook(() => useFindOnPage([]))
      expect(result.current.isOpen).toBe(false)
      expect(result.current.searchText).toBe('')
      expect(result.current.matchIds).toEqual([])
      expect(result.current.currentMatchIndex).toBe(0)
      expect(result.current.highlightTerms).toEqual([])
    })
  })

  describe('open/close', () => {
    it('opens the find bar', () => {
      const { result } = renderHook(() => useFindOnPage([]))
      act(() => result.current.open())
      expect(result.current.isOpen).toBe(true)
    })

    it('closes and clears state', () => {
      const messages = makeMessages('hello world', 'goodbye world')
      const { result } = renderHook(() => useFindOnPage(messages))

      act(() => result.current.open())
      act(() => result.current.setSearchText('world'))

      expect(result.current.matchIds.length).toBe(2)

      act(() => result.current.close())

      expect(result.current.isOpen).toBe(false)
      expect(result.current.searchText).toBe('')
      expect(result.current.matchIds).toEqual([])
      expect(result.current.currentMatchIndex).toBe(0)
    })
  })

  describe('matching', () => {
    it('finds matching messages', () => {
      const messages = makeMessages('hello world', 'foo bar', 'hello again')
      const { result } = renderHook(() => useFindOnPage(messages))

      act(() => result.current.setSearchText('hello'))

      expect(result.current.matchIds).toEqual(['msg-1', 'msg-3'])
    })

    it('returns matches in oldest-first (document) order', () => {
      const messages = makeMessages('apple pie', 'banana split', 'apple sauce')
      const { result } = renderHook(() => useFindOnPage(messages))

      act(() => result.current.setSearchText('apple'))

      // msg-1 (oldest) before msg-3 (newest)
      expect(result.current.matchIds).toEqual(['msg-1', 'msg-3'])
    })

    it('is case-insensitive', () => {
      const messages = makeMessages('Hello World', 'HELLO world', 'hello WORLD')
      const { result } = renderHook(() => useFindOnPage(messages))

      act(() => result.current.setSearchText('hello'))

      expect(result.current.matchIds).toHaveLength(3)
    })

    it('requires at least 2 characters', () => {
      const messages = makeMessages('a test', 'b test')
      const { result } = renderHook(() => useFindOnPage(messages))

      act(() => result.current.setSearchText('a'))
      expect(result.current.matchIds).toEqual([])

      act(() => result.current.setSearchText('te'))
      expect(result.current.matchIds).toHaveLength(2)
    })

    it('skips messages without body', () => {
      const messages: TestMessage[] = [
        { id: 'msg-1', body: 'hello' },
        { id: 'msg-2' }, // no body
        { id: 'msg-3', body: 'hello again' },
      ]
      const { result } = renderHook(() => useFindOnPage(messages))

      act(() => result.current.setSearchText('hello'))

      expect(result.current.matchIds).toEqual(['msg-1', 'msg-3'])
    })

    it('returns empty for no matches', () => {
      const messages = makeMessages('hello world')
      const { result } = renderHook(() => useFindOnPage(messages))

      act(() => result.current.setSearchText('xyz'))

      expect(result.current.matchIds).toEqual([])
    })

    it('trims whitespace from search text', () => {
      const messages = makeMessages('hello world')
      const { result } = renderHook(() => useFindOnPage(messages))

      act(() => result.current.setSearchText('  hello  '))

      expect(result.current.matchIds).toEqual(['msg-1'])
    })
  })

  describe('highlightTerms', () => {
    it('derives highlight terms from search text', () => {
      const { result } = renderHook(() => useFindOnPage([]))

      act(() => result.current.setSearchText('Hello'))

      expect(result.current.highlightTerms).toEqual(['hello'])
    })

    it('returns empty for short search text', () => {
      const { result } = renderHook(() => useFindOnPage([]))

      act(() => result.current.setSearchText('h'))

      expect(result.current.highlightTerms).toEqual([])
    })
  })

  describe('navigation', () => {
    it('scrolls to newest match on initial search', () => {
      const messages = makeMessages('hello', 'world', 'hello again')
      const { result } = renderHook(() => useFindOnPage(messages))

      act(() => result.current.setSearchText('hello'))

      // Starts at the last (newest) match
      expect(result.current.currentMatchIndex).toBe(1)
      expect(mockScrollToMessage).toHaveBeenCalledWith('msg-3') // newest match
    })

    it('goToNext cycles downward through matches', () => {
      const messages = makeMessages('hello A', 'hello B', 'hello C')
      const { result } = renderHook(() => useFindOnPage(messages))

      act(() => result.current.setSearchText('hello'))
      // Starts at index 2 (msg-3, newest)
      expect(result.current.currentMatchIndex).toBe(2)
      mockScrollToMessage.mockClear()

      // Wraps around to oldest
      act(() => result.current.goToNext())
      expect(result.current.currentMatchIndex).toBe(0)
      expect(mockScrollToMessage).toHaveBeenCalledWith('msg-1')

      act(() => result.current.goToNext())
      expect(result.current.currentMatchIndex).toBe(1)
      expect(mockScrollToMessage).toHaveBeenCalledWith('msg-2')

      act(() => result.current.goToNext())
      expect(result.current.currentMatchIndex).toBe(2)
      expect(mockScrollToMessage).toHaveBeenCalledWith('msg-3')
    })

    it('goToPrev cycles upward through matches', () => {
      const messages = makeMessages('hello A', 'hello B', 'hello C')
      const { result } = renderHook(() => useFindOnPage(messages))

      act(() => result.current.setSearchText('hello'))
      // Starts at index 2 (msg-3, newest)
      mockScrollToMessage.mockClear()

      act(() => result.current.goToPrev())
      expect(result.current.currentMatchIndex).toBe(1)
      expect(mockScrollToMessage).toHaveBeenCalledWith('msg-2')

      act(() => result.current.goToPrev())
      expect(result.current.currentMatchIndex).toBe(0)
      expect(mockScrollToMessage).toHaveBeenCalledWith('msg-1')

      // Wraps around to newest
      act(() => result.current.goToPrev())
      expect(result.current.currentMatchIndex).toBe(2)
      expect(mockScrollToMessage).toHaveBeenCalledWith('msg-3')
    })

    it('goToNext is no-op with no matches', () => {
      const { result } = renderHook(() => useFindOnPage([]))

      act(() => result.current.setSearchText('xyz'))
      act(() => result.current.goToNext())

      expect(result.current.currentMatchIndex).toBe(0)
      expect(mockScrollToMessage).not.toHaveBeenCalled()
    })

    it('goToPrev is no-op with no matches', () => {
      const { result } = renderHook(() => useFindOnPage([]))

      act(() => result.current.setSearchText('xyz'))
      act(() => result.current.goToPrev())

      expect(result.current.currentMatchIndex).toBe(0)
      expect(mockScrollToMessage).not.toHaveBeenCalled()
    })

    it('resets index to newest match when search text changes', () => {
      const messages = makeMessages('hello world', 'hello there', 'world peace')
      const { result } = renderHook(() => useFindOnPage(messages))

      act(() => result.current.setSearchText('hello'))
      // Starts at last match (index 1 = msg-2)
      expect(result.current.currentMatchIndex).toBe(1)

      act(() => result.current.goToPrev()) // index 0
      expect(result.current.currentMatchIndex).toBe(0)

      // Changing search text resets to newest match
      act(() => result.current.setSearchText('world'))
      // 'world' matches msg-1 and msg-3, newest is index 1 (msg-3)
      expect(result.current.currentMatchIndex).toBe(1)
    })
  })

  describe('dynamic message list', () => {
    it('updates matches when messages change', () => {
      const messages1 = makeMessages('hello')
      const { result, rerender } = renderHook(
        ({ msgs }) => useFindOnPage(msgs),
        { initialProps: { msgs: messages1 } }
      )

      act(() => result.current.setSearchText('hello'))
      expect(result.current.matchIds).toEqual(['msg-1'])

      // Add a new message
      const messages2 = [...messages1, { id: 'msg-2', body: 'hello again' }]
      rerender({ msgs: messages2 })

      expect(result.current.matchIds).toEqual(['msg-1', 'msg-2'])
    })
  })
})
