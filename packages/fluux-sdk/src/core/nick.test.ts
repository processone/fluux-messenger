import { describe, it, expect } from 'vitest'
import { stripNickWhitespace, splitNickForDisplay } from './nick'

describe('stripNickWhitespace', () => {
  it('leaves a clean nick unchanged', () => {
    expect(stripNickWhitespace('admin')).toBe('admin')
  })

  it('preserves internal spaces', () => {
    expect(stripNickWhitespace('ad min')).toBe('ad min')
  })

  it('trims leading and trailing ASCII spaces', () => {
    expect(stripNickWhitespace('  admin  ')).toBe('admin')
    expect(stripNickWhitespace('admin ')).toBe('admin')
    expect(stripNickWhitespace(' admin')).toBe('admin')
  })

  it('trims tabs and newlines at the edges', () => {
    expect(stripNickWhitespace('\tadmin\n')).toBe('admin')
  })

  it('trims Unicode whitespace (NBSP, en-quad, ideographic space)', () => {
    expect(stripNickWhitespace(' admin ')).toBe('admin')
    expect(stripNickWhitespace(' admin　')).toBe('admin')
    expect(stripNickWhitespace('admin ')).toBe('admin')
  })

  it('removes zero-width characters anywhere in the nick', () => {
    expect(stripNickWhitespace('admin​')).toBe('admin')
    expect(stripNickWhitespace('ad​min')).toBe('admin')
    expect(stripNickWhitespace('﻿admin')).toBe('admin')
  })

  it('removes bidi control and soft-hyphen characters', () => {
    expect(stripNickWhitespace('ad‮min')).toBe('admin')
    expect(stripNickWhitespace('admin­')).toBe('admin')
  })

  it('returns empty string for all-whitespace / all-invisible input', () => {
    expect(stripNickWhitespace('   ')).toBe('')
    expect(stripNickWhitespace('​​')).toBe('')
  })
})

describe('splitNickForDisplay', () => {
  it('returns a clean nick as core with no edges', () => {
    expect(splitNickForDisplay('admin')).toEqual({
      leading: '', core: 'admin', trailing: '', hasHiddenChars: false,
    })
  })

  it('keeps internal spaces in the core', () => {
    expect(splitNickForDisplay('ad min')).toEqual({
      leading: '', core: 'ad min', trailing: '', hasHiddenChars: false,
    })
  })

  it('splits leading whitespace', () => {
    expect(splitNickForDisplay(' admin')).toEqual({
      leading: ' ', core: 'admin', trailing: '', hasHiddenChars: false,
    })
  })

  it('splits trailing whitespace', () => {
    expect(splitNickForDisplay('admin ')).toEqual({
      leading: '', core: 'admin', trailing: ' ', hasHiddenChars: false,
    })
  })

  it('splits both edges including NBSP', () => {
    expect(splitNickForDisplay(' admin  ')).toEqual({
      leading: ' ', core: 'admin', trailing: '  ', hasHiddenChars: false,
    })
  })

  it('flags hidden characters without treating them as edges', () => {
    const result = splitNickForDisplay('admin​')
    expect(result.hasHiddenChars).toBe(true)
    expect(result.core).toContain('admin')
  })

  it('does not double-count an all-whitespace nick', () => {
    const result = splitNickForDisplay('   ')
    expect(result.leading).toBe('   ')
    expect(result.core).toBe('')
    expect(result.trailing).toBe('')
  })
})
