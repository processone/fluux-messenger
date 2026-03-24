import { describe, it, expect } from 'vitest'
import { generateMatchSnippet } from './searchUtils'

describe('generateMatchSnippet', () => {
  it('should find exact phrase match and return snippet', () => {
    const result = generateMatchSnippet('Hello world, how are you doing today?', 'world')

    expect(result).not.toBeNull()
    expect(result!.text).toContain('world')
    expect(result!.matchStart).toBeLessThan(result!.matchEnd)
    // The match text should be extractable from the snippet
    expect(result!.text.slice(result!.matchStart, result!.matchEnd)).toBe('world')
  })

  it('should be case-insensitive', () => {
    const result = generateMatchSnippet('Hello WORLD today', 'world')

    expect(result).not.toBeNull()
    expect(result!.text.slice(result!.matchStart, result!.matchEnd)).toBe('WORLD')
  })

  it('should return null when no match found', () => {
    const result = generateMatchSnippet('Hello world', 'nonexistent')
    expect(result).toBeNull()
  })

  it('should return null for empty body', () => {
    expect(generateMatchSnippet('', 'test')).toBeNull()
  })

  it('should return null for empty query', () => {
    expect(generateMatchSnippet('Hello world', '')).toBeNull()
  })

  it('should add leading ellipsis when match is not at the start', () => {
    const longText = 'A'.repeat(100) + ' target word here'
    const result = generateMatchSnippet(longText, 'target', 10)

    expect(result).not.toBeNull()
    expect(result!.text.startsWith('…')).toBe(true)
  })

  it('should add trailing ellipsis when match is not at the end', () => {
    const longText = 'target word here ' + 'B'.repeat(100)
    const result = generateMatchSnippet(longText, 'target', 10)

    expect(result).not.toBeNull()
    expect(result!.text.endsWith('…')).toBe(true)
  })

  it('should not add ellipsis when match covers the whole body', () => {
    const result = generateMatchSnippet('hello', 'hello', 60)

    expect(result).not.toBeNull()
    expect(result!.text).toBe('hello')
    expect(result!.matchStart).toBe(0)
    expect(result!.matchEnd).toBe(5)
  })

  it('should handle match at the very beginning of body', () => {
    const result = generateMatchSnippet('Hello world and more text', 'Hello', 10)

    expect(result).not.toBeNull()
    expect(result!.matchStart).toBe(0)
    expect(result!.text.slice(result!.matchStart, result!.matchEnd)).toBe('Hello')
  })

  it('should handle match at the very end of body', () => {
    const result = generateMatchSnippet('Some text ending with target', 'target', 10)

    expect(result).not.toBeNull()
    expect(result!.text.slice(result!.matchStart, result!.matchEnd)).toBe('target')
    // No trailing ellipsis since match extends to end
    expect(result!.text.endsWith('…')).toBe(false)
  })

  it('should fall back to matching individual words when phrase not found', () => {
    const result = generateMatchSnippet('The quick brown fox jumps over', 'brown lazy')

    // 'brown lazy' as a phrase doesn't exist, but 'brown' does
    expect(result).not.toBeNull()
    expect(result!.text).toContain('brown')
  })

  it('should respect contextChars parameter', () => {
    const body = 'A'.repeat(50) + ' match ' + 'B'.repeat(50)
    const shortContext = generateMatchSnippet(body, 'match', 5)
    const longContext = generateMatchSnippet(body, 'match', 40)

    expect(shortContext).not.toBeNull()
    expect(longContext).not.toBeNull()
    // Longer context should produce a longer snippet
    expect(longContext!.text.length).toBeGreaterThan(shortContext!.text.length)
  })

  it('should handle multi-word query matching first word', () => {
    const result = generateMatchSnippet(
      'The quarterly report is ready for review',
      'quarterly report'
    )

    expect(result).not.toBeNull()
    // Should find the exact phrase 'quarterly report'
    expect(result!.text.slice(result!.matchStart, result!.matchEnd)).toBe('quarterly report')
  })

  // Phrase-aware snippet generation
  describe('with phrases parameter', () => {
    it('should prioritize phrase match over full query match', () => {
      const body = 'The quarterly report and annual review are ready'
      const result = generateMatchSnippet(body, '"quarterly report"', 60, ['quarterly report'])

      expect(result).not.toBeNull()
      expect(result!.text.slice(result!.matchStart, result!.matchEnd)).toBe('quarterly report')
    })

    it('should highlight the first matching phrase', () => {
      const body = 'The annual review and quarterly report are ready'
      const result = generateMatchSnippet(body, 'query text', 60, ['quarterly report'])

      expect(result).not.toBeNull()
      expect(result!.text.slice(result!.matchStart, result!.matchEnd)).toBe('quarterly report')
    })

    it('should fall back to word matching when phrase not found', () => {
      const body = 'The report for quarterly earnings is ready'
      const result = generateMatchSnippet(body, 'quarterly report', 60, ['quarterly report'])

      // Phrase "quarterly report" not contiguous in body, falls back to word match
      expect(result).not.toBeNull()
      expect(result!.text).toContain('report')
    })

    it('should work without phrases param (backward compat)', () => {
      const result = generateMatchSnippet('Hello world', 'world')
      expect(result).not.toBeNull()
      expect(result!.text.slice(result!.matchStart, result!.matchEnd)).toBe('world')
    })
  })
})
