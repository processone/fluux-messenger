// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import {
  loadEmojiAutocompleteData,
  matchEmojiAutocomplete,
  matchEmojiAutocompleteTrigger,
  useEmojiAutocomplete,
} from './useEmojiAutocomplete'

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
    it.each([
      [':Hea', 4, 0],
      ['hello :Hea', 10, 6],
    ])('finds a trigger at a supported boundary in %j', (text, cursor, triggerIndex) => {
      expect(matchEmojiAutocompleteTrigger(text, cursor)).toMatchObject({
        query: 'hea',
        triggerIndex,
        token: 'Hea',
      })
    })

    it('parses a trigger into a stable position-and-token identity', () => {
      expect(matchEmojiAutocompleteTrigger('hello :Hea', 10)).toEqual({
        query: 'hea',
        closed: false,
        triggerIndex: 6,
        token: 'Hea',
        identity: JSON.stringify([6, 'Hea']),
      })
    })

    it('uses the caret rather than the end of the message to locate the trigger', () => {
      expect(matchEmojiAutocompleteTrigger('say :hea and continue', 8)).toEqual({
        query: 'hea',
        closed: false,
        triggerIndex: 4,
        token: 'hea',
        identity: JSON.stringify([4, 'hea']),
      })
    })

    it('should not be active when no colon is typed', () => {
      const { result } = renderHook(() => useEmojiAutocomplete('hello world', 11))
      expect(result.current.state.isActive).toBe(false)
    })

    it('should not be active when a bare colon is typed', () => {
      const { result } = renderHook(() => useEmojiAutocomplete(':', 1))
      expect(result.current.state.isActive).toBe(false)
    })

    // `:D`, `:p`, `:3` and friends are emoticons, not shortcode prefixes. A
    // one-character token matches dozens of emojis, and completion would then
    // swallow the Enter that was meant to send the message.
    it.each([':d', ':D', ':p', ':o', ':v', ':x', ':3', 'haha :D'])(
      'ignores the one-character token in %j so the emoticon can still be sent',
      (text) => {
        expect(matchEmojiAutocompleteTrigger(text, text.length)).toBeNull()
      }
    )

    it('closes completion once the token shrinks back to a single character', async () => {
      const { result, rerender } = renderHook(
        ({ text, cursor }) => useEmojiAutocomplete(text, cursor),
        { initialProps: { text: ':he', cursor: 3 } }
      )

      // Waiting for the active state proves the emoji data finished loading, so
      // the assertion below cannot pass merely because matching had not started.
      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })

      rerender({ text: ':h', cursor: 2 })
      expect(result.current.state.isActive).toBe(false)
    })

    it('should be active when colon and characters are typed at start of text after data loads', async () => {
      const { result } = renderHook(() => useEmojiAutocomplete(':+1', 3))

      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })
      expect(result.current.state.query).toBe('+1')
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

    it('reads a closing colon as part of the shortcode rather than the query', () => {
      expect(matchEmojiAutocompleteTrigger('say :+1:', 8)).toMatchObject({
        query: '+1',
        closed: true,
        triggerIndex: 4,
        token: '+1:',
      })
    })

    it('marks an unterminated shortcode as open', () => {
      expect(matchEmojiAutocompleteTrigger('say :+1', 7)).toMatchObject({
        query: '+1',
        closed: false,
      })
    })

    // A closed shortcode carries no emoticon ambiguity — nobody types `:v:` as a
    // smiley — so the two-character floor only applies while it is still open.
    it('accepts a single-character query once the shortcode is closed', () => {
      expect(matchEmojiAutocompleteTrigger(':v:', 3)).toMatchObject({ query: 'v', closed: true })
      expect(matchEmojiAutocompleteTrigger(':v', 2)).toBeNull()
    })
  })

  describe('matching and sorting', () => {
    it('keeps an exact shortcode first when more than eight broader matches precede it', () => {
      const broadMatches = Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          `broad_${index}`,
          {
            name: `Heart symbol ${index}`,
            skins: [{ native: `symbol-${index}` }],
            keywords: [],
          },
        ])
      )

      const matches = matchEmojiAutocomplete({
        emojis: {
          ...broadMatches,
          heart: {
            name: 'Red Heart',
            skins: [{ native: '❤️' }],
            keywords: ['love'],
          },
        },
      }, 'heart')

      expect(matches).toHaveLength(8)
      expect(matches[0]).toEqual({ id: 'heart', name: 'Red Heart', native: '❤️' })
    })

    it('ranks shortcode prefixes ahead of keyword and name matches', () => {
      const matches = matchEmojiAutocomplete({
        emojis: {
          named: {
            name: 'Heart symbol',
            skins: [{ native: '🫀' }],
            keywords: [],
          },
          keyword: {
            name: 'Love Letter',
            skins: [{ native: '💌' }],
            keywords: ['heartfelt'],
          },
          heart_eyes: {
            name: 'Smiling Face with Heart-Eyes',
            skins: [{ native: '😍' }],
            keywords: ['love'],
          },
          heart: {
            name: 'Red Heart',
            skins: [{ native: '❤️' }],
            keywords: ['love'],
          },
        },
      }, 'heart')

      expect(matches.map((match) => match.id)).toEqual([
        'heart',
        'heart_eyes',
        'keyword',
        'named',
      ])
    })

    // Ties used to fall back to `id.localeCompare`, which put :-1: 👎 ahead of
    // :+1: 👍 for "thumbs" purely because "-" sorts before "+".
    it('breaks a keyword tie on how much of the keyword the query covers', () => {
      const matches = matchEmojiAutocomplete({
        emojis: {
          '-1': {
            name: 'Thumbs Down',
            skins: [{ native: '👎' }],
            keywords: ['-1', 'thumbsdown', 'no', 'dislike'],
          },
          '+1': {
            name: 'Thumbs Up',
            skins: [{ native: '👍' }],
            keywords: ['+1', 'thumbsup', 'yes', 'good'],
          },
        },
      }, 'thumbs')

      expect(matches.map((match) => match.id)).toEqual(['+1', '-1'])
    })

    it('breaks a shortcode-prefix tie on the shortest matching shortcode', () => {
      const matches = matchEmojiAutocomplete({
        emojis: {
          headphones: { name: 'Headphone', skins: [{ native: '🎧' }], keywords: [] },
          headstone: { name: 'Headstone', skins: [{ native: '🪦' }], keywords: [] },
          heart_decoration: { name: 'Heart Decoration', skins: [{ native: '💟' }], keywords: [] },
          heart: { name: 'Red Heart', skins: [{ native: '❤️' }], keywords: [] },
        },
      }, 'hea')

      expect(matches.map((match) => match.id)).toEqual([
        'heart',
        'headstone',
        'headphones',
        'heart_decoration',
      ])
    })

    it('normalizes case and canonically equivalent Unicode before matching', () => {
      const matches = matchEmojiAutocomplete({
        emojis: {
          'cafe\u0301': {
            name: 'Cafe\u0301',
            skins: [{ native: '☕' }],
            keywords: ['COFFEE'],
          },
        },
      }, 'CAFÉ')

      expect(matches).toEqual([{ id: 'cafe\u0301', name: 'Cafe\u0301', native: '☕' }])
    })

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

  describe('closed shortcode completion', () => {
    /** Completion only resolves once the emoji data is in memory. */
    async function renderLoadedHook(text: string, cursor: number) {
      const { result } = renderHook(
        ({ text: t, cursor: c }) => useEmojiAutocomplete(t, c),
        { initialProps: { text, cursor } }
      )
      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })
      return result
    }

    it('resolves an exact shortcode once the closing colon is typed', async () => {
      const result = await renderLoadedHook('love :hea', 9)

      expect(result.current.completeClosedShortcode('love :heart:', 12)).toEqual({
        newText: 'love ❤️',
        newCursorPosition: 5 + '❤️'.length,
      })
    })

    it('leaves a closed shortcode alone when nothing matches it exactly', async () => {
      const result = await renderLoadedHook('love :hea', 9)

      expect(result.current.completeClosedShortcode('love :hea:', 10)).toBeNull()
    })

    it('ignores a shortcode that is still open', async () => {
      const result = await renderLoadedHook('love :hea', 9)

      expect(result.current.completeClosedShortcode('love :heart', 11)).toBeNull()
    })
  })

  describe('data loading', () => {
    it('silently disables autocomplete when emoji data fails to load', async () => {
      const data = await loadEmojiAutocompleteData(() => Promise.reject(new Error('chunk unavailable')))

      expect(data).toBeNull()
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

    it('leaves text and cursor unchanged for an invalid selection', async () => {
      const { result } = renderHook(() => useEmojiAutocomplete('say :hea later', 8))

      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })

      expect(result.current.selectMatch(-1)).toEqual({
        newText: 'say :hea later',
        newCursorPosition: 8,
      })
      expect(result.current.selectMatch(99)).toEqual({
        newText: 'say :hea later',
        newCursorPosition: 8,
      })
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

    it('keeps the dismissed token closed until its identity changes', async () => {
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

      rerender({ text: ':hea', cursor: 4 })
      expect(result.current.state.isActive).toBe(false)

      // Extending the token creates a new trigger identity and re-enables matching.
      rerender({ text: ':heart', cursor: 6 })
      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })
    })

    it('treats the same token at a different position as a new trigger', async () => {
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

      rerender({ text: 'x :hea', cursor: 6 })
      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })
    })

    it('reactivates a dismissed token after the trigger disappears', async () => {
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
      rerender({ text: '', cursor: 0 })
      await waitFor(() => {
        expect(result.current.state.query).toBe('')
      })

      rerender({ text: ':hea', cursor: 4 })
      await waitFor(() => {
        expect(result.current.state.isActive).toBe(true)
      })
    })
  })
})
