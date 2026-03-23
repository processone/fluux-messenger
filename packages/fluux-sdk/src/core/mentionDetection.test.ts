import { describe, it, expect } from 'vitest'
import { checkForMention, findMentionRanges } from './mentionDetection'

describe('checkForMention', () => {
  describe('@nick pattern (anywhere in message)', () => {
    it('detects @nick at start of message', () => {
      expect(checkForMention('@alice check this', 'alice')).toBe(true)
    })

    it('detects @nick in middle of message', () => {
      expect(checkForMention('hey @alice check this', 'alice')).toBe(true)
    })

    it('detects @nick at end of message', () => {
      expect(checkForMention('hey @alice', 'alice')).toBe(true)
    })

    it('detects @nick followed by punctuation', () => {
      expect(checkForMention('hey @alice!', 'alice')).toBe(true)
      expect(checkForMention('hey @alice, check', 'alice')).toBe(true)
    })

    it('is case insensitive', () => {
      expect(checkForMention('hey @Alice', 'alice')).toBe(true)
      expect(checkForMention('hey @ALICE', 'alice')).toBe(true)
      expect(checkForMention('hey @alice', 'Alice')).toBe(true)
    })
  })

  describe('nick: pattern (start of message)', () => {
    it('detects nick: at start', () => {
      expect(checkForMention('alice: can you check this?', 'alice')).toBe(true)
    })

    it('detects nick: with no content after', () => {
      expect(checkForMention('alice:', 'alice')).toBe(true)
    })

    it('is case insensitive', () => {
      expect(checkForMention('Alice: check this', 'alice')).toBe(true)
      expect(checkForMention('ALICE: check this', 'alice')).toBe(true)
    })

    it('does NOT detect nick: mid-sentence', () => {
      expect(checkForMention('I told alice: do this', 'alice')).toBe(false)
    })
  })

  describe('nick, pattern (start of message)', () => {
    it('detects nick, at start', () => {
      expect(checkForMention('alice, look at this', 'alice')).toBe(true)
    })

    it('detects nick, with no content after', () => {
      expect(checkForMention('alice,', 'alice')).toBe(true)
    })

    it('is case insensitive', () => {
      expect(checkForMention('Alice, check this', 'alice')).toBe(true)
    })

    it('does NOT detect nick, mid-sentence', () => {
      expect(checkForMention('I saw alice, she left', 'alice')).toBe(false)
    })
  })

  describe('bare nick pattern (start of message, 5+ chars)', () => {
    it('detects bare nick at start when 5+ chars', () => {
      expect(checkForMention('alice look at this', 'alice')).toBe(true)
    })

    it('does NOT detect bare nick when shorter than 5 chars', () => {
      expect(checkForMention('bob look at this', 'bob')).toBe(false)
      expect(checkForMention('alex look at this', 'alex')).toBe(false)
    })

    it('detects bare nick exactly 5 chars', () => {
      expect(checkForMention('bruce check this', 'bruce')).toBe(true)
    })

    it('is case insensitive', () => {
      expect(checkForMention('Alice look at this', 'alice')).toBe(true)
    })

    it('does NOT detect bare nick mid-sentence', () => {
      expect(checkForMention('I saw alice today', 'alice')).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('returns false for empty body', () => {
      expect(checkForMention('', 'alice')).toBe(false)
    })

    it('returns false for empty nickname', () => {
      expect(checkForMention('hello', '')).toBe(false)
    })

    it('returns false for no match', () => {
      expect(checkForMention('hello world', 'alice')).toBe(false)
    })

    it('handles nickname with regex special characters', () => {
      expect(checkForMention('@user.name check', 'user.name')).toBe(true)
      expect(checkForMention('user.name: check', 'user.name')).toBe(true)
    })

    it('handles nickname with brackets', () => {
      expect(checkForMention('@nick[1] hey', 'nick[1]')).toBe(true)
    })

    it('does not match nick as substring of another word', () => {
      expect(checkForMention('malice aforethought', 'alice')).toBe(false)
    })

    it('handles unicode nicknames', () => {
      expect(checkForMention('@München hello', 'München')).toBe(true)
      expect(checkForMention('München: hello', 'München')).toBe(true)
    })
  })
})

describe('findMentionRanges', () => {
  it('returns empty array for no match', () => {
    expect(findMentionRanges('hello world', 'alice')).toEqual([])
  })

  it('returns empty array for empty inputs', () => {
    expect(findMentionRanges('', 'alice')).toEqual([])
    expect(findMentionRanges('hello', '')).toEqual([])
  })

  it('finds @nick range including the @', () => {
    const ranges = findMentionRanges('hey @alice check', 'alice')
    expect(ranges).toEqual([{ begin: 4, end: 10 }])
  })

  it('finds nick: range (just the nick, not the colon)', () => {
    const ranges = findMentionRanges('alice: check this', 'alice')
    expect(ranges).toEqual([{ begin: 0, end: 5 }])
  })

  it('finds nick, range (just the nick, not the comma)', () => {
    const ranges = findMentionRanges('alice, check this', 'alice')
    expect(ranges).toEqual([{ begin: 0, end: 5 }])
  })

  it('finds bare nick range at start (5+ chars)', () => {
    const ranges = findMentionRanges('alice check this', 'alice')
    expect(ranges).toEqual([{ begin: 0, end: 5 }])
  })

  it('finds multiple ranges (nick: at start + @nick later)', () => {
    const ranges = findMentionRanges('alice: hey @alice check', 'alice')
    expect(ranges).toEqual([
      { begin: 0, end: 5 },
      { begin: 11, end: 17 },
    ])
  })

  it('does not return bare nick range for short nicknames', () => {
    const ranges = findMentionRanges('bob check this', 'bob')
    expect(ranges).toEqual([])
  })

  it('does not duplicate range when nick: and bare nick both match', () => {
    // nick: takes priority, bare nick should not also match
    const ranges = findMentionRanges('alice: check', 'alice')
    expect(ranges).toEqual([{ begin: 0, end: 5 }])
  })
})
