/**
 * Tests for XEP-0428 Fallback Utilities
 *
 * Covers: single/multiple fallback elements, priority ordering,
 * entire-body fallbacks (reactions), range-based fallbacks (reply, OOB, correction),
 * legacy namespace support, and edge cases.
 */
import { describe, it, expect } from 'vitest'
import { getFallbackElement, getAllFallbackElements, isEntireBodyFallback, processFallback } from './fallbackUtils'
import { createMockElement } from '../core/test-utils'

describe('fallbackUtils', () => {
  describe('getFallbackElement', () => {
    it('should return null when no fallback element exists', () => {
      const stanza = createMockElement('message', {}, [
        { name: 'body', text: 'Hello' },
      ])
      expect(getFallbackElement(stanza)).toBeNull()
    })

    it('should find fallback element with standard namespace', () => {
      const stanza = createMockElement('message', {}, [
        { name: 'body', text: 'Hello' },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [],
        },
      ])
      const result = getFallbackElement(stanza)
      expect(result).not.toBeNull()
      expect(result?.namespace).toBe('urn:xmpp:fallback:0')
    })

    it('should find fallback element with legacy namespace', () => {
      const stanza = createMockElement('message', {}, [
        { name: 'body', text: 'Hello' },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:feature-fallback:0', for: 'urn:xmpp:reply:0' },
          children: [],
        },
      ])
      const result = getFallbackElement(stanza)
      expect(result).not.toBeNull()
      expect(result?.namespace).toBe('urn:xmpp:feature-fallback:0')
    })

    it('should prefer standard namespace over legacy', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [],
        },
      ])
      const result = getFallbackElement(stanza)
      expect(result?.namespace).toBe('urn:xmpp:fallback:0')
    })
  })

  describe('getAllFallbackElements', () => {
    it('should return empty array when no fallbacks exist', () => {
      const stanza = createMockElement('message', {}, [
        { name: 'body', text: 'Hello' },
      ])
      expect(getAllFallbackElements(stanza)).toEqual([])
    })

    it('should return all standard namespace fallbacks', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '50' } },
          ],
        },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reactions:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0' } },
          ],
        },
      ])
      const results = getAllFallbackElements(stanza)
      expect(results).toHaveLength(2)
      expect(results[0].element.attrs.for).toBe('urn:xmpp:reply:0')
      expect(results[1].element.attrs.for).toBe('urn:xmpp:reactions:0')
    })

    it('should not mix standard and legacy namespace elements', () => {
      // When standard namespace fallbacks exist, legacy ones should be ignored
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [],
        },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:feature-fallback:0', for: 'urn:xmpp:reactions:0' },
          children: [],
        },
      ])
      const results = getAllFallbackElements(stanza)
      expect(results).toHaveLength(1)
      expect(results[0].namespace).toBe('urn:xmpp:fallback:0')
    })

    it('should fall back to legacy namespace when no standard ones exist', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:feature-fallback:0', for: 'urn:xmpp:reply:0' },
          children: [],
        },
      ])
      const results = getAllFallbackElements(stanza)
      expect(results).toHaveLength(1)
      expect(results[0].namespace).toBe('urn:xmpp:feature-fallback:0')
    })

    it('should ignore non-fallback elements', () => {
      const stanza = createMockElement('message', {}, [
        { name: 'body', text: 'Hello' },
        { name: 'reply', attrs: { xmlns: 'urn:xmpp:reply:0', id: '123' } },
      ])
      expect(getAllFallbackElements(stanza)).toEqual([])
    })
  })

  describe('isEntireBodyFallback', () => {
    it('should return false when no fallback exists', () => {
      const stanza = createMockElement('message', {}, [
        { name: 'body', text: 'Hello' },
      ])
      expect(isEntireBodyFallback(stanza, 'urn:xmpp:reactions:0')).toBe(false)
    })

    it('should return true for reactions fallback with <body/> (no range)', () => {
      const stanza = createMockElement('message', {}, [
        { name: 'body', text: '👍' },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reactions:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0' } },
          ],
        },
      ])
      expect(isEntireBodyFallback(stanza, 'urn:xmpp:reactions:0')).toBe(true)
    })

    it('should return false for fallback with range', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '50' } },
          ],
        },
      ])
      expect(isEntireBodyFallback(stanza, 'urn:xmpp:reply:0')).toBe(false)
    })

    it('should return false when fallback targets a different namespace', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0' } },
          ],
        },
      ])
      expect(isEntireBodyFallback(stanza, 'urn:xmpp:reactions:0')).toBe(false)
    })

    it('should return false when fallback has no body child', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reactions:0' },
          children: [],
        },
      ])
      expect(isEntireBodyFallback(stanza, 'urn:xmpp:reactions:0')).toBe(false)
    })

    it('should detect entire-body fallback among multiple fallbacks', () => {
      // Stanza with both reply fallback (ranged) and reactions fallback (entire body)
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '329' } },
          ],
        },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reactions:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0' } },
          ],
        },
      ])
      expect(isEntireBodyFallback(stanza, 'urn:xmpp:reactions:0')).toBe(true)
      expect(isEntireBodyFallback(stanza, 'urn:xmpp:reply:0')).toBe(false)
    })

    it('should work with legacy namespace', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:feature-fallback:0', for: 'urn:xmpp:reactions:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:feature-fallback:0' } },
          ],
        },
      ])
      expect(isEntireBodyFallback(stanza, 'urn:xmpp:reactions:0')).toBe(true)
    })
  })

  describe('processFallback', () => {
    it('should return original body when no fallback element exists', () => {
      const stanza = createMockElement('message', {}, [
        { name: 'body', text: 'Hello world' },
      ])
      const result = processFallback(stanza, 'Hello world', {
        validTargets: ['urn:xmpp:reply:0'],
      })
      expect(result.processedBody).toBe('Hello world')
    })

    it('should return original body when fallback target not in validTargets', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:other:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '5' } },
          ],
        },
      ])
      const result = processFallback(stanza, 'Hello world', {
        validTargets: ['urn:xmpp:reply:0'],
      })
      expect(result.processedBody).toBe('Hello world')
    })

    it('should strip fallback text for correction', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:message-correct:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '12' } },
          ],
        },
      ])
      const result = processFallback(stanza, '[Corrected] Actual text', {
        validTargets: ['urn:xmpp:message-correct:0'],
        trimMode: 'leading-newlines',
      })
      expect(result.processedBody).toBe('Actual text')
    })

    it('should strip fallback text for reply', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            // '> Bob: quoted text\n' is 19 characters
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '19' } },
          ],
        },
      ])
      const result = processFallback(stanza, '> Bob: quoted text\nMy reply', {
        validTargets: ['urn:xmpp:reply:0'],
      })
      expect(result.processedBody).toBe('My reply')
    })

    it('should extract fallbackBody for replies when replyTo provided', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            // '> Bob: quoted text\n' is 19 characters
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '19' } },
          ],
        },
      ])
      const result = processFallback(
        stanza,
        '> Bob: quoted text\nMy reply',
        { validTargets: ['urn:xmpp:reply:0'] },
        { id: 'original-msg-id', to: 'bob@example.com' }
      )
      expect(result.fallbackBody).toBe('quoted text')
    })

    it('should handle invalid range gracefully', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '100', end: '200' } },
          ],
        },
      ])
      const result = processFallback(stanza, 'Short text', {
        validTargets: ['urn:xmpp:reply:0'],
      })
      // Should return original body when range is invalid
      expect(result.processedBody).toBe('Short text')
    })

    it('should use full trim mode by default', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '10' } },
          ],
        },
      ])
      const result = processFallback(stanza, '> quoted\n\n  My reply  \n', {
        validTargets: ['urn:xmpp:reply:0'],
      })
      expect(result.processedBody).toBe('My reply')
    })

    it('should use leading-newlines trim mode when specified', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:message-correct:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '12' } },
          ],
        },
      ])
      const result = processFallback(stanza, '[Corrected]\nActual text  ', {
        validTargets: ['urn:xmpp:message-correct:0'],
        trimMode: 'leading-newlines',
      })
      // Only leading newlines trimmed, trailing space preserved
      expect(result.processedBody).toBe('Actual text  ')
    })

    it('should work with legacy namespace', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:feature-fallback:0', for: 'urn:xmpp:message-correct:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:feature-fallback:0', start: '0', end: '12' } },
          ],
        },
      ])
      const result = processFallback(stanza, '[Corrected] Fixed text', {
        validTargets: ['urn:xmpp:message-correct:0'],
        trimMode: 'leading-newlines',
      })
      expect(result.processedBody).toBe('Fixed text')
    })

    // --- Multi-fallback tests ---

    it('should return empty body for entire-body fallback (reactions)', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reactions:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0' } },
          ],
        },
      ])
      const result = processFallback(stanza, '👍', {
        validTargets: ['urn:xmpp:reactions:0'],
      })
      expect(result.processedBody).toBe('')
    })

    it('should process reply fallback and skip reactions fallback when reactions not in validTargets', () => {
      // Stanza with both reply and reactions fallbacks (like the real-world example)
      // When the client supports replies but NOT reactions, only the reply fallback is processed
      const body = '> zeank: Even if ejabberd wants to support...\n\n👍'
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '46' } },
          ],
        },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reactions:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0' } },
          ],
        },
      ])
      const result = processFallback(stanza, body, {
        validTargets: ['urn:xmpp:reply:0'],
      })
      // Only reply fallback stripped, reactions fallback ignored
      expect(result.processedBody).toBe('👍')
    })

    it('should process the first matching fallback among multiple (reactions takes precedence)', () => {
      const body = '> zeank: Original message\n\n👍'
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '26' } },
          ],
        },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reactions:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0' } },
          ],
        },
      ])
      // When both are in validTargets, entire-body fallback (reactions) takes precedence
      const result = processFallback(stanza, body, {
        validTargets: ['urn:xmpp:reply:0', 'urn:xmpp:reactions:0'],
      })
      expect(result.processedBody).toBe('')
    })

    it('should process multiple range-based fallbacks correctly', () => {
      // Simulate a message with both reply and OOB fallbacks (both ranged)
      // Body: "> Alice: Hi\nCheck this https://example.com/file.pdf"
      //        ^--- reply ---^                ^--- OOB URL ---^
      const body = '> Alice: Hi\nCheck this https://example.com/file.pdf'
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '12' } },
          ],
        },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'jabber:x:oob' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '23', end: '51' } },
          ],
        },
      ])
      const result = processFallback(stanza, body, {
        validTargets: ['urn:xmpp:reply:0', 'jabber:x:oob'],
      })
      // Both ranges stripped (end-to-start order preserves indices)
      expect(result.processedBody).toBe('Check this')
    })

    it('should skip fallback with missing body child element', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [], // No body child
        },
      ])
      const result = processFallback(stanza, 'Original body', {
        validTargets: ['urn:xmpp:reply:0'],
      })
      expect(result.processedBody).toBe('Original body')
    })

    it('should skip fallback with negative start range', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '-1', end: '10' } },
          ],
        },
      ])
      const result = processFallback(stanza, 'Hello world', {
        validTargets: ['urn:xmpp:reply:0'],
      })
      expect(result.processedBody).toBe('Hello world')
    })

    it('should skip fallback with start >= end', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '10', end: '5' } },
          ],
        },
      ])
      const result = processFallback(stanza, 'Hello world', {
        validTargets: ['urn:xmpp:reply:0'],
      })
      expect(result.processedBody).toBe('Hello world')
    })

    it('should skip fallback with end beyond body length', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '999' } },
          ],
        },
      ])
      const result = processFallback(stanza, 'Short', {
        validTargets: ['urn:xmpp:reply:0'],
      })
      expect(result.processedBody).toBe('Short')
    })

    it('should skip fallback with non-numeric range attributes', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: 'abc', end: 'xyz' } },
          ],
        },
      ])
      const result = processFallback(stanza, 'Hello world', {
        validTargets: ['urn:xmpp:reply:0'],
      })
      expect(result.processedBody).toBe('Hello world')
    })

    it('should not produce fallbackBody when no replyTo is provided', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '19' } },
          ],
        },
      ])
      const result = processFallback(stanza, '> Bob: quoted text\nMy reply', {
        validTargets: ['urn:xmpp:reply:0'],
      })
      expect(result.processedBody).toBe('My reply')
      expect(result.fallbackBody).toBeUndefined()
    })

    it('should handle empty body string', () => {
      const stanza = createMockElement('message', {}, [
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '5' } },
          ],
        },
      ])
      const result = processFallback(stanza, '', {
        validTargets: ['urn:xmpp:reply:0'],
      })
      // Range is invalid (end > body.length), so body is returned unchanged
      expect(result.processedBody).toBe('')
    })
  })
})
