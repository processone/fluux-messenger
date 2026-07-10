import { describe, it, expect } from 'vitest'
import { extractLinks } from './messageStyles'

describe('extractLinks', () => {
  it('returns [] when there are no links', () => {
    expect(extractLinks('just some text')).toEqual([])
  })

  it('extracts a single link', () => {
    expect(extractLinks('see https://example.com now')).toEqual(['https://example.com'])
  })

  it('extracts multiple links in document order', () => {
    expect(extractLinks('a https://a.com b https://b.com')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })

  it('de-duplicates identical links', () => {
    expect(extractLinks('https://a.com and again https://a.com')).toEqual(['https://a.com'])
  })

  it('strips trailing sentence punctuation', () => {
    expect(extractLinks('go to https://example.com.')).toEqual(['https://example.com'])
  })
})
