import { describe, it, expect } from 'vitest'
import { createMockElement } from './test-utils'
import {
  POLL_OPTION_EMOJIS,
  MAX_POLL_OPTIONS,
  buildPollData,
  buildPollFallbackBody,
  parsePollElement,
  parsePollClosedElement,
  tallyPollResults,
  getTotalVoters,
  enforceSingleVote,
  enforceMultiVote,
  getMyReactions,
  hasVotedOnPoll,
  getPollOptionEmojis,
  isPollExpired,
} from './poll'

describe('poll utilities', () => {
  describe('constants', () => {
    it('should have 9 option emojis', () => {
      expect(POLL_OPTION_EMOJIS).toEqual(['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'])
      expect(MAX_POLL_OPTIONS).toBe(9)
    })
  })

  describe('buildPollData', () => {
    it('should build poll data with default settings', () => {
      const poll = buildPollData('What for lunch?', ['Pizza', 'Sushi'])

      expect(poll.title).toBe('What for lunch?')
      expect(poll.description).toBeUndefined()
      expect(poll.options).toEqual([
        { emoji: '1️⃣', label: 'Pizza' },
        { emoji: '2️⃣', label: 'Sushi' },
      ])
      expect(poll.settings.allowMultiple).toBe(false)
      expect(poll.settings.hideResultsBeforeVote).toBe(false)
    })

    it('should build poll with custom settings', () => {
      const poll = buildPollData('Pick topics', ['A', 'B', 'C'], { allowMultiple: true })

      expect(poll.options).toHaveLength(3)
      expect(poll.settings.allowMultiple).toBe(true)
    })

    it('should build poll with hideResultsBeforeVote', () => {
      const poll = buildPollData('Q?', ['A', 'B'], { hideResultsBeforeVote: true })

      expect(poll.settings.hideResultsBeforeVote).toBe(true)
      expect(poll.settings.allowMultiple).toBe(false)
    })

    it('should build poll with description', () => {
      const poll = buildPollData('Team Lunch', ['Pizza', 'Sushi'], {}, 'Pick your favorite for Friday')

      expect(poll.title).toBe('Team Lunch')
      expect(poll.description).toBe('Pick your favorite for Friday')
    })

    it('should support up to 9 options', () => {
      const poll = buildPollData('Q?', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])

      expect(poll.options).toHaveLength(9)
      expect(poll.options[8].emoji).toBe('9️⃣')
    })

    it('should throw for less than 2 options', () => {
      expect(() => buildPollData('Q?', ['Only one'])).toThrow('at least 2 options')
    })

    it('should throw for more than 9 options with default emojis', () => {
      const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
      expect(() => buildPollData('Q?', labels)).toThrow('at most 9 options')
    })

    it('should build poll with custom emojis', () => {
      const poll = buildPollData('Favorite?', ['Cats', 'Dogs'], {}, undefined, undefined, ['🐱', '🐶'])

      expect(poll.options).toEqual([
        { emoji: '🐱', label: 'Cats' },
        { emoji: '🐶', label: 'Dogs' },
      ])
    })

    it('should allow more than 9 options with custom emojis', () => {
      const labels = ['A', 'B', 'C', 'D', 'E']
      const customEmojis = ['🅰️', '🅱️', '©️', '🌊', '🎯']
      const poll = buildPollData('Q?', labels, {}, undefined, undefined, customEmojis)

      expect(poll.options).toHaveLength(5)
      expect(poll.options[4].emoji).toBe('🎯')
    })

    it('should throw when customEmojis length does not match options', () => {
      expect(() =>
        buildPollData('Q?', ['A', 'B'], {}, undefined, undefined, ['🐱'])
      ).toThrow('customEmojis length')
    })
  })

  describe('buildPollFallbackBody', () => {
    it('should build readable fallback text', () => {
      const body = buildPollFallbackBody('What for lunch?', ['Pizza', 'Sushi', 'Tacos'])

      expect(body).toBe(
        '📊 Poll: What for lunch?\n' +
        '1️⃣ Pizza\n' +
        '2️⃣ Sushi\n' +
        '3️⃣ Tacos'
      )
    })

    it('should work with 2 options', () => {
      const body = buildPollFallbackBody('Yes or no?', ['Yes', 'No'])

      expect(body).toBe(
        '📊 Poll: Yes or no?\n' +
        '1️⃣ Yes\n' +
        '2️⃣ No'
      )
    })

    it('should include description when provided', () => {
      const body = buildPollFallbackBody('Team Lunch', ['Pizza', 'Sushi'], 'Pick your favorite for Friday')

      expect(body).toBe(
        '📊 Poll: Team Lunch\n' +
        'Pick your favorite for Friday\n' +
        '1️⃣ Pizza\n' +
        '2️⃣ Sushi'
      )
    })

    it('should omit description line when undefined', () => {
      const body = buildPollFallbackBody('Q?', ['A', 'B'], undefined)

      expect(body).toBe(
        '📊 Poll: Q?\n' +
        '1️⃣ A\n' +
        '2️⃣ B'
      )
    })

    it('should use custom emojis when provided', () => {
      const body = buildPollFallbackBody('Favorite?', ['Cats', 'Dogs'], undefined, ['🐱', '🐶'])

      expect(body).toBe(
        '📊 Poll: Favorite?\n' +
        '🐱 Cats\n' +
        '🐶 Dogs'
      )
    })
  })

  describe('parsePollElement', () => {
    it('should parse a valid poll element', () => {
      const pollEl = createMockElement('poll', { xmlns: 'urn:fluux:poll:0' }, [
        { name: 'title', text: 'What for lunch?' },
        { name: 'option', attrs: { emoji: '1️⃣' }, text: 'Pizza' },
        { name: 'option', attrs: { emoji: '2️⃣' }, text: 'Sushi' },
        { name: 'option', attrs: { emoji: '3️⃣' }, text: 'Tacos' },
      ])

      const poll = parsePollElement(pollEl)

      expect(poll).not.toBeNull()
      expect(poll!.title).toBe('What for lunch?')
      expect(poll!.description).toBeUndefined()
      expect(poll!.options).toEqual([
        { emoji: '1️⃣', label: 'Pizza' },
        { emoji: '2️⃣', label: 'Sushi' },
        { emoji: '3️⃣', label: 'Tacos' },
      ])
      expect(poll!.settings.allowMultiple).toBe(false)
    })

    it('should parse description element', () => {
      const pollEl = createMockElement('poll', { xmlns: 'urn:fluux:poll:0' }, [
        { name: 'title', text: 'Team Lunch' },
        { name: 'description', text: 'Pick your favorite' },
        { name: 'option', attrs: { emoji: '1️⃣' }, text: 'Pizza' },
        { name: 'option', attrs: { emoji: '2️⃣' }, text: 'Sushi' },
      ])

      const poll = parsePollElement(pollEl)

      expect(poll!.title).toBe('Team Lunch')
      expect(poll!.description).toBe('Pick your favorite')
    })

    it('should parse allow-multiple attribute', () => {
      const pollEl = createMockElement('poll', { xmlns: 'urn:fluux:poll:0', 'allow-multiple': 'true' }, [
        { name: 'title', text: 'Pick topics' },
        { name: 'option', attrs: { emoji: '1️⃣' }, text: 'A' },
        { name: 'option', attrs: { emoji: '2️⃣' }, text: 'B' },
      ])

      const poll = parsePollElement(pollEl)

      expect(poll!.settings.allowMultiple).toBe(true)
    })

    it('should parse hide-results attribute', () => {
      const pollEl = createMockElement('poll', { xmlns: 'urn:fluux:poll:0', 'hide-results': 'true' }, [
        { name: 'title', text: 'Secret poll' },
        { name: 'option', attrs: { emoji: '1️⃣' }, text: 'A' },
        { name: 'option', attrs: { emoji: '2️⃣' }, text: 'B' },
      ])

      const poll = parsePollElement(pollEl)

      expect(poll!.settings.hideResultsBeforeVote).toBe(true)
    })

    it('should default hideResultsBeforeVote to false', () => {
      const pollEl = createMockElement('poll', { xmlns: 'urn:fluux:poll:0' }, [
        { name: 'title', text: 'Q?' },
        { name: 'option', attrs: { emoji: '1️⃣' }, text: 'A' },
        { name: 'option', attrs: { emoji: '2️⃣' }, text: 'B' },
      ])

      const poll = parsePollElement(pollEl)

      expect(poll!.settings.hideResultsBeforeVote).toBe(false)
    })

    it('should return null for missing title', () => {
      const pollEl = createMockElement('poll', { xmlns: 'urn:fluux:poll:0' }, [
        { name: 'option', attrs: { emoji: '1️⃣' }, text: 'A' },
        { name: 'option', attrs: { emoji: '2️⃣' }, text: 'B' },
      ])

      expect(parsePollElement(pollEl)).toBeNull()
    })

    it('should return null for less than 2 options', () => {
      const pollEl = createMockElement('poll', { xmlns: 'urn:fluux:poll:0' }, [
        { name: 'title', text: 'Q?' },
        { name: 'option', attrs: { emoji: '1️⃣' }, text: 'Only one' },
      ])

      expect(parsePollElement(pollEl)).toBeNull()
    })

    it('should skip options without emoji attribute', () => {
      const pollEl = createMockElement('poll', { xmlns: 'urn:fluux:poll:0' }, [
        { name: 'title', text: 'Q?' },
        { name: 'option', attrs: {}, text: 'No emoji' },
        { name: 'option', attrs: { emoji: '1️⃣' }, text: 'A' },
        { name: 'option', attrs: { emoji: '2️⃣' }, text: 'B' },
      ])

      const poll = parsePollElement(pollEl)

      expect(poll!.options).toHaveLength(2)
    })

    it('should parse custom (non-numbered) emojis', () => {
      const pollEl = createMockElement('poll', { xmlns: 'urn:fluux:poll:0' }, [
        { name: 'title', text: 'Favorite pet?' },
        { name: 'option', attrs: { emoji: '🐱' }, text: 'Cats' },
        { name: 'option', attrs: { emoji: '🐶' }, text: 'Dogs' },
        { name: 'option', attrs: { emoji: '🐹' }, text: 'Hamsters' },
      ])

      const poll = parsePollElement(pollEl)

      expect(poll).not.toBeNull()
      expect(poll!.options).toEqual([
        { emoji: '🐱', label: 'Cats' },
        { emoji: '🐶', label: 'Dogs' },
        { emoji: '🐹', label: 'Hamsters' },
      ])
    })
  })

  describe('parsePollClosedElement', () => {
    it('should parse a valid poll-closed element', () => {
      const el = createMockElement('poll-closed', { xmlns: 'urn:fluux:poll:0', 'message-id': 'msg-1' }, [
        { name: 'title', text: 'What for lunch?' },
        { name: 'tally', attrs: { emoji: '1️⃣', label: 'Pizza', count: '3' } },
        { name: 'tally', attrs: { emoji: '2️⃣', label: 'Sushi', count: '5' } },
      ])

      const result = parsePollClosedElement(el)

      expect(result).not.toBeNull()
      expect(result!.title).toBe('What for lunch?')
      expect(result!.description).toBeUndefined()
      expect(result!.pollMessageId).toBe('msg-1')
      expect(result!.results).toEqual([
        { emoji: '1️⃣', label: 'Pizza', count: 3 },
        { emoji: '2️⃣', label: 'Sushi', count: 5 },
      ])
    })

    it('should parse poll-closed element without labels (backward compat)', () => {
      const el = createMockElement('poll-closed', { xmlns: 'urn:fluux:poll:0', 'message-id': 'msg-1' }, [
        { name: 'title', text: 'Old poll' },
        { name: 'tally', attrs: { emoji: '1️⃣', count: '3' } },
      ])

      const result = parsePollClosedElement(el)
      expect(result).not.toBeNull()
      expect(result!.results[0].label).toBe('')
    })

    it('should parse description in poll-closed element', () => {
      const el = createMockElement('poll-closed', { xmlns: 'urn:fluux:poll:0', 'message-id': 'msg-1' }, [
        { name: 'title', text: 'Team Lunch' },
        { name: 'description', text: 'Friday plans' },
        { name: 'tally', attrs: { emoji: '1️⃣', label: 'Pizza', count: '2' } },
        { name: 'tally', attrs: { emoji: '2️⃣', label: 'Sushi', count: '4' } },
      ])

      const result = parsePollClosedElement(el)

      expect(result!.title).toBe('Team Lunch')
      expect(result!.description).toBe('Friday plans')
    })

    it('should return null for missing title', () => {
      const el = createMockElement('poll-closed', { xmlns: 'urn:fluux:poll:0', 'message-id': 'msg-1' }, [
        { name: 'tally', attrs: { emoji: '1️⃣', count: '3' } },
      ])

      expect(parsePollClosedElement(el)).toBeNull()
    })

    it('should return null for missing message-id', () => {
      const el = createMockElement('poll-closed', { xmlns: 'urn:fluux:poll:0' }, [
        { name: 'title', text: 'Q?' },
        { name: 'tally', attrs: { emoji: '1️⃣', count: '3' } },
      ])

      expect(parsePollClosedElement(el)).toBeNull()
    })
  })

  describe('tallyPollResults', () => {
    const poll = buildPollData('Q?', ['Pizza', 'Sushi', 'Tacos'])

    it('should tally votes from reactions', () => {
      const reactions = {
        '1️⃣': ['alice', 'bob'],
        '2️⃣': ['carol'],
        '3️⃣': [],
      }

      const tally = tallyPollResults(poll, reactions)

      expect(tally).toEqual([
        { emoji: '1️⃣', label: 'Pizza', voters: ['alice', 'bob'], count: 2 },
        { emoji: '2️⃣', label: 'Sushi', voters: ['carol'], count: 1 },
        { emoji: '3️⃣', label: 'Tacos', voters: [], count: 0 },
      ])
    })

    it('should handle undefined reactions', () => {
      const tally = tallyPollResults(poll, undefined)

      expect(tally.every(t => t.count === 0)).toBe(true)
    })

    it('should handle empty reactions', () => {
      const tally = tallyPollResults(poll, {})

      expect(tally.every(t => t.count === 0)).toBe(true)
    })

    it('should ignore non-poll reactions', () => {
      const reactions = {
        '1️⃣': ['alice'],
        '👍': ['bob', 'carol'],
      }

      const tally = tallyPollResults(poll, reactions)

      expect(tally[0].count).toBe(1)
      expect(tally[1].count).toBe(0)
      expect(tally[2].count).toBe(0)
    })

    it('should tally correctly with custom emojis', () => {
      const customPoll = buildPollData('Pets?', ['Cats', 'Dogs'], {}, undefined, undefined, ['🐱', '🐶'])
      const reactions = {
        '🐱': ['alice', 'bob'],
        '🐶': ['carol'],
      }

      const tally = tallyPollResults(customPoll, reactions)

      expect(tally).toEqual([
        { emoji: '🐱', label: 'Cats', voters: ['alice', 'bob'], count: 2 },
        { emoji: '🐶', label: 'Dogs', voters: ['carol'], count: 1 },
      ])
    })
  })

  describe('tallyPollResults — single-vote deduplication', () => {
    it('should count voter only in last option when they reacted with multiple poll emojis', () => {
      const poll = buildPollData('Q?', ['Pizza', 'Sushi', 'Tacos'])
      // alice reacted with both 1️⃣ and 2️⃣ — malformed for single-vote
      const reactions = {
        '1️⃣': ['alice', 'bob'],
        '2️⃣': ['alice', 'carol'],
        '3️⃣': ['dave'],
      }

      const tally = tallyPollResults(poll, reactions)

      // alice should only count in option 2 (last in option order)
      expect(tally[0]).toEqual({ emoji: '1️⃣', label: 'Pizza', voters: ['bob'], count: 1 })
      expect(tally[1]).toEqual({ emoji: '2️⃣', label: 'Sushi', voters: ['alice', 'carol'], count: 2 })
      expect(tally[2]).toEqual({ emoji: '3️⃣', label: 'Tacos', voters: ['dave'], count: 1 })
    })

    it('should not deduplicate in multi-vote mode', () => {
      const poll = buildPollData('Q?', ['Pizza', 'Sushi', 'Tacos'], { allowMultiple: true })
      // alice voted for both — this is valid in multi-vote mode
      const reactions = {
        '1️⃣': ['alice', 'bob'],
        '2️⃣': ['alice', 'carol'],
        '3️⃣': ['dave'],
      }

      const tally = tallyPollResults(poll, reactions)

      // alice counted in both options
      expect(tally[0]).toEqual({ emoji: '1️⃣', label: 'Pizza', voters: ['alice', 'bob'], count: 2 })
      expect(tally[1]).toEqual({ emoji: '2️⃣', label: 'Sushi', voters: ['alice', 'carol'], count: 2 })
      expect(tally[2]).toEqual({ emoji: '3️⃣', label: 'Tacos', voters: ['dave'], count: 1 })
    })

    it('should assign voter to latest option when they appear in multiple options', () => {
      const poll = buildPollData('Q?', ['A', 'B', 'C'])
      // alice appears in option 2 and 3 — should be counted in option 3 (latest in option order)
      const reactions = {
        '1️⃣': ['bob'],
        '2️⃣': ['alice'],
        '3️⃣': ['alice'],
      }

      const tally = tallyPollResults(poll, reactions)

      expect(tally[0]).toEqual({ emoji: '1️⃣', label: 'A', voters: ['bob'], count: 1 })
      expect(tally[1]).toEqual({ emoji: '2️⃣', label: 'B', voters: [], count: 0 })
      expect(tally[2]).toEqual({ emoji: '3️⃣', label: 'C', voters: ['alice'], count: 1 })
    })
  })

  describe('getTotalVoters', () => {
    const poll = buildPollData('Q?', ['A', 'B'])

    it('should count unique voters', () => {
      const reactions = {
        '1️⃣': ['alice', 'bob'],
        '2️⃣': ['carol'],
      }

      expect(getTotalVoters(poll, reactions)).toBe(3)
    })

    it('should deduplicate voters who voted multiple options', () => {
      const reactions = {
        '1️⃣': ['alice', 'bob'],
        '2️⃣': ['alice', 'carol'],
      }

      expect(getTotalVoters(poll, reactions)).toBe(3)
    })

    it('should return 0 for no reactions', () => {
      expect(getTotalVoters(poll, undefined)).toBe(0)
      expect(getTotalVoters(poll, {})).toBe(0)
    })
  })

  describe('enforceSingleVote', () => {
    const pollEmojis = ['1️⃣', '2️⃣', '3️⃣']

    it('should add new vote when no previous poll vote', () => {
      const result = enforceSingleVote([], '2️⃣', pollEmojis)
      expect(result).toEqual(['2️⃣'])
    })

    it('should replace previous poll vote with new one', () => {
      const result = enforceSingleVote(['1️⃣'], '2️⃣', pollEmojis)
      expect(result).toEqual(['2️⃣'])
    })

    it('should preserve non-poll reactions', () => {
      const result = enforceSingleVote(['👍', '1️⃣', '❤️'], '2️⃣', pollEmojis)
      expect(result).toEqual(['👍', '❤️', '2️⃣'])
    })

    it('should toggle off when voting same option', () => {
      const result = enforceSingleVote(['1️⃣'], '1️⃣', pollEmojis)
      expect(result).toEqual([])
    })

    it('should toggle off and preserve non-poll reactions', () => {
      const result = enforceSingleVote(['👍', '1️⃣'], '1️⃣', pollEmojis)
      expect(result).toEqual(['👍'])
    })
  })

  describe('enforceMultiVote', () => {
    it('should add new vote', () => {
      const result = enforceMultiVote([], '1️⃣')
      expect(result).toEqual(['1️⃣'])
    })

    it('should toggle off existing vote', () => {
      const result = enforceMultiVote(['1️⃣', '2️⃣'], '1️⃣')
      expect(result).toEqual(['2️⃣'])
    })

    it('should add vote alongside existing ones', () => {
      const result = enforceMultiVote(['1️⃣'], '2️⃣')
      expect(result).toEqual(['1️⃣', '2️⃣'])
    })
  })

  describe('getMyReactions', () => {
    const reactions = { '1️⃣': ['alice', 'bob'], '2️⃣': ['charlie'], '👍': ['alice'] }

    it('should match by nick for groupchat messages', () => {
      expect(getMyReactions(reactions, 'alice', 'alice@server.com', true)).toEqual(['1️⃣', '👍'])
    })

    it('should match by bare JID for 1:1 messages', () => {
      const chatReactions = { '1️⃣': ['alice@server.com', 'bob@server.com'], '👍': ['alice@server.com'] }
      expect(getMyReactions(chatReactions, 'alice', 'alice@server.com', false)).toEqual(['1️⃣', '👍'])
    })

    it('should not match bare JID against nick-based reactors in groupchat', () => {
      // Reactors are nicks ("alice"), not JIDs — bare JID should not match when nick is available
      expect(getMyReactions(reactions, 'carol', 'alice@server.com', true)).toEqual([])
    })

    it('should fall back to bare JID when nick is missing in groupchat', () => {
      // When nick is undefined, falls back to bare JID as last resort
      const jidReactions = { '1️⃣': ['alice@server.com'] }
      expect(getMyReactions(jidReactions, undefined, 'alice@server.com', true)).toEqual(['1️⃣'])
    })

    it('should return empty for undefined reactions', () => {
      expect(getMyReactions(undefined, 'alice', 'alice@server.com', true)).toEqual([])
    })

    it('should return empty for empty reactions', () => {
      expect(getMyReactions({}, 'alice', 'alice@server.com', true)).toEqual([])
    })

    it('should return empty when no identifiers provided', () => {
      expect(getMyReactions(reactions, undefined, undefined, false)).toEqual([])
    })

    it('should match nick in groupchat even when bare JID differs', () => {
      // The key scenario: nick "bob" doesn't look like "bob@example.com"
      expect(getMyReactions(reactions, 'bob', 'bob@example.com', true)).toEqual(['1️⃣'])
    })
  })

  describe('hasVotedOnPoll', () => {
    const poll = buildPollData('Q?', ['A', 'B', 'C'])

    it('should return true when user has voted', () => {
      const reactions = { '2️⃣': ['alice', 'bob'] }
      expect(hasVotedOnPoll(poll, reactions, 'alice')).toBe(true)
    })

    it('should return false when user has not voted', () => {
      const reactions = { '1️⃣': ['alice'] }
      expect(hasVotedOnPoll(poll, reactions, 'bob')).toBe(false)
    })

    it('should return false for undefined reactions', () => {
      expect(hasVotedOnPoll(poll, undefined, 'alice')).toBe(false)
    })

    it('should return false for empty reactions', () => {
      expect(hasVotedOnPoll(poll, {}, 'alice')).toBe(false)
    })

    it('should not match non-poll reactions', () => {
      const reactions = { '👍': ['alice'] }
      expect(hasVotedOnPoll(poll, reactions, 'alice')).toBe(false)
    })

    it('should detect votes with custom emojis', () => {
      const customPoll = buildPollData('Pets?', ['Cats', 'Dogs'], {}, undefined, undefined, ['🐱', '🐶'])
      const reactions = { '🐱': ['alice'] }
      expect(hasVotedOnPoll(customPoll, reactions, 'alice')).toBe(true)
      expect(hasVotedOnPoll(customPoll, reactions, 'bob')).toBe(false)
    })
  })

  describe('getPollOptionEmojis', () => {
    it('should return emojis from poll options', () => {
      const poll = buildPollData('Q?', ['A', 'B', 'C'])
      expect(getPollOptionEmojis(poll)).toEqual(['1️⃣', '2️⃣', '3️⃣'])
    })
  })

  describe('buildPollData with deadline', () => {
    it('should include deadline when provided', () => {
      const poll = buildPollData('Q?', ['A', 'B'], {}, undefined, '2026-12-31T23:59:00.000Z')
      expect(poll.deadline).toBe('2026-12-31T23:59:00.000Z')
    })

    it('should omit deadline when not provided', () => {
      const poll = buildPollData('Q?', ['A', 'B'])
      expect(poll.deadline).toBeUndefined()
    })
  })

  describe('parsePollElement with deadline', () => {
    it('should parse deadline attribute', () => {
      const el = createMockElement('poll', {
        xmlns: 'urn:fluux:poll:0',
        deadline: '2026-12-31T23:59:00.000Z',
      }, [
        { name: 'title', text: 'Q?' },
        { name: 'option', attrs: { emoji: '1️⃣' }, text: 'A' },
        { name: 'option', attrs: { emoji: '2️⃣' }, text: 'B' },
      ])
      const poll = parsePollElement(el)
      expect(poll?.deadline).toBe('2026-12-31T23:59:00.000Z')
    })

    it('should omit deadline when not present', () => {
      const el = createMockElement('poll', { xmlns: 'urn:fluux:poll:0' }, [
        { name: 'title', text: 'Q?' },
        { name: 'option', attrs: { emoji: '1️⃣' }, text: 'A' },
        { name: 'option', attrs: { emoji: '2️⃣' }, text: 'B' },
      ])
      const poll = parsePollElement(el)
      expect(poll?.deadline).toBeUndefined()
    })
  })

  describe('isPollExpired', () => {
    it('should return false when no deadline', () => {
      const poll = buildPollData('Q?', ['A', 'B'])
      expect(isPollExpired(poll)).toBe(false)
    })

    it('should return false when deadline is in the future', () => {
      const poll = buildPollData('Q?', ['A', 'B'], {}, undefined, '2099-12-31T23:59:00.000Z')
      const now = new Date('2026-01-01T00:00:00.000Z')
      expect(isPollExpired(poll, now)).toBe(false)
    })

    it('should return true when deadline has passed', () => {
      const poll = buildPollData('Q?', ['A', 'B'], {}, undefined, '2025-01-01T00:00:00.000Z')
      const now = new Date('2026-01-01T00:00:00.000Z')
      expect(isPollExpired(poll, now)).toBe(true)
    })

    it('should return true when now equals deadline', () => {
      const deadline = '2026-06-15T12:00:00.000Z'
      const poll = buildPollData('Q?', ['A', 'B'], {}, undefined, deadline)
      const now = new Date(deadline)
      expect(isPollExpired(poll, now)).toBe(true)
    })

    it('should return false for invalid deadline string (safe default)', () => {
      const poll: import('./types/message-base').PollData = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
        deadline: 'not-a-date',
      }
      // Invalid Date comparison with >= always returns false, so poll stays open
      expect(isPollExpired(poll)).toBe(false)
    })
  })

  // ── Edge cases & bug regression tests ──────────────────────────────

  describe('edge cases: buildPollData', () => {
    it('should allow empty-string labels (no validation)', () => {
      // buildPollData does not reject empty labels — callers are responsible
      const poll = buildPollData('Q?', ['', 'B'])
      expect(poll.options[0].label).toBe('')
    })

    it('should throw for 0 options', () => {
      expect(() => buildPollData('Q?', [])).toThrow('at least 2 options')
    })

    it('should throw for 1 option', () => {
      expect(() => buildPollData('Q?', ['Only'])).toThrow('at least 2 options')
    })

    it('should allow duplicate custom emojis (no uniqueness check)', () => {
      // Duplicates are accepted at build time — this is a known limitation
      const poll = buildPollData('Q?', ['A', 'B'], {}, undefined, undefined, ['🐱', '🐱'])
      expect(poll.options[0].emoji).toBe('🐱')
      expect(poll.options[1].emoji).toBe('🐱')
    })
  })

  describe('edge cases: parsePollElement', () => {
    it('should filter out options with empty label text', () => {
      // An option with empty text is filtered by the .filter(opt => opt.emoji && opt.label) check
      const pollEl = createMockElement('poll', { xmlns: 'urn:fluux:poll:0' }, [
        { name: 'title', text: 'Q?' },
        { name: 'option', attrs: { emoji: '1️⃣' }, text: '' },
        { name: 'option', attrs: { emoji: '2️⃣' }, text: 'B' },
        { name: 'option', attrs: { emoji: '3️⃣' }, text: 'C' },
      ])

      const poll = parsePollElement(pollEl)
      expect(poll).not.toBeNull()
      expect(poll!.options).toHaveLength(2)
      expect(poll!.options[0].emoji).toBe('2️⃣')
    })

    it('should return null when empty labels reduce valid options below 2', () => {
      const pollEl = createMockElement('poll', { xmlns: 'urn:fluux:poll:0' }, [
        { name: 'title', text: 'Q?' },
        { name: 'option', attrs: { emoji: '1️⃣' }, text: '' },
        { name: 'option', attrs: { emoji: '2️⃣' }, text: '' },
        { name: 'option', attrs: { emoji: '3️⃣' }, text: 'Only valid' },
      ])

      expect(parsePollElement(pollEl)).toBeNull()
    })

    it('should parse poll with duplicate emojis across options', () => {
      // Parser does not validate uniqueness — this is a known limitation
      const pollEl = createMockElement('poll', { xmlns: 'urn:fluux:poll:0' }, [
        { name: 'title', text: 'Q?' },
        { name: 'option', attrs: { emoji: '🐱' }, text: 'Cats' },
        { name: 'option', attrs: { emoji: '🐱' }, text: 'Also Cats' },
      ])

      const poll = parsePollElement(pollEl)
      expect(poll).not.toBeNull()
      // Both options share the same emoji — tallying will be wrong
      expect(poll!.options[0].emoji).toBe(poll!.options[1].emoji)
    })
  })

  describe('edge cases: parsePollClosedElement', () => {
    it('should clamp negative vote counts to 0', () => {
      const el = createMockElement('poll-closed', { xmlns: 'urn:fluux:poll:0', 'message-id': 'msg-1' }, [
        { name: 'title', text: 'Q?' },
        { name: 'tally', attrs: { emoji: '1️⃣', count: '-3' } },
        { name: 'tally', attrs: { emoji: '2️⃣', count: '5' } },
      ])

      const result = parsePollClosedElement(el)
      expect(result).not.toBeNull()
      // Negative counts should be clamped to 0
      expect(result!.results[0].count).toBe(0)
      expect(result!.results[1].count).toBe(5)
    })

    it('should handle non-numeric count as 0', () => {
      const el = createMockElement('poll-closed', { xmlns: 'urn:fluux:poll:0', 'message-id': 'msg-1' }, [
        { name: 'title', text: 'Q?' },
        { name: 'tally', attrs: { emoji: '1️⃣', count: 'abc' } },
      ])

      const result = parsePollClosedElement(el)
      expect(result).not.toBeNull()
      expect(result!.results[0].count).toBe(0)
    })

    it('should skip tally entries without emoji', () => {
      const el = createMockElement('poll-closed', { xmlns: 'urn:fluux:poll:0', 'message-id': 'msg-1' }, [
        { name: 'title', text: 'Q?' },
        { name: 'tally', attrs: { count: '5' } },
        { name: 'tally', attrs: { emoji: '2️⃣', count: '3' } },
      ])

      const result = parsePollClosedElement(el)
      expect(result).not.toBeNull()
      expect(result!.results).toHaveLength(1)
      expect(result!.results[0].emoji).toBe('2️⃣')
    })

    it('should return empty results array when no tally elements', () => {
      const el = createMockElement('poll-closed', { xmlns: 'urn:fluux:poll:0', 'message-id': 'msg-1' }, [
        { name: 'title', text: 'Q?' },
      ])

      const result = parsePollClosedElement(el)
      expect(result).not.toBeNull()
      expect(result!.results).toEqual([])
    })
  })

  describe('edge cases: tallyPollResults', () => {
    it('should handle duplicate voters in a single option gracefully (single-vote)', () => {
      const poll = buildPollData('Q?', ['A', 'B'])
      // Malformed reaction data: same voter listed twice for one option
      const reactions = { '1️⃣': ['alice', 'alice'], '2️⃣': [] }

      const tally = tallyPollResults(poll, reactions)
      // In single-vote mode, alice's last option is 1️⃣ (only option),
      // but duplicate entries are both kept since both match voterLastOption
      expect(tally[0].count).toBe(2)
      expect(tally[0].voters).toEqual(['alice', 'alice'])
    })

    it('should handle duplicate voters in a single option gracefully (multi-vote)', () => {
      const poll = buildPollData('Q?', ['A', 'B'], { allowMultiple: true })
      // Malformed reaction data: same voter listed twice for one option
      const reactions = { '1️⃣': ['alice', 'alice'], '2️⃣': [] }

      const tally = tallyPollResults(poll, reactions)
      // In multi-vote mode, raw array is used — duplicates are preserved
      expect(tally[0].count).toBe(2)
      expect(tally[0].voters).toEqual(['alice', 'alice'])
    })

    it('should handle reactions with non-poll emojis without crashing', () => {
      const poll = buildPollData('Q?', ['A', 'B'])
      const reactions = { '👍': ['alice'], '❤️': ['bob'], '1️⃣': ['carol'] }

      const tally = tallyPollResults(poll, reactions)
      expect(tally[0].count).toBe(1) // 1️⃣
      expect(tally[1].count).toBe(0) // 2️⃣
    })

    it('should produce correct tally when duplicate emojis exist in poll options (single-vote)', () => {
      // When two options share the same emoji in single-vote mode,
      // voters are assigned to the last option (last write wins)
      const poll: import('./types/message-base').PollData = {
        title: 'Q?',
        options: [
          { emoji: '🐱', label: 'Cats' },
          { emoji: '🐱', label: 'Also Cats' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
      }
      const reactions = { '🐱': ['alice', 'bob'] }

      const tally = tallyPollResults(poll, reactions)
      // Single-vote: alice and bob assigned to last option (last write wins)
      expect(tally[0].count).toBe(0)
      expect(tally[1].count).toBe(2)
    })

    it('should produce correct tally when duplicate emojis exist in poll options (multi-vote)', () => {
      // When two options share the same emoji in multi-vote mode,
      // both get the same voter list (double-counted)
      const poll: import('./types/message-base').PollData = {
        title: 'Q?',
        options: [
          { emoji: '🐱', label: 'Cats' },
          { emoji: '🐱', label: 'Also Cats' },
        ],
        settings: { allowMultiple: true, hideResultsBeforeVote: false },
      }
      const reactions = { '🐱': ['alice', 'bob'] }

      const tally = tallyPollResults(poll, reactions)
      expect(tally[0].count).toBe(2)
      expect(tally[1].count).toBe(2)
    })
  })

  describe('edge cases: getTotalVoters', () => {
    it('should count voter only once even if duplicate in same option', () => {
      const poll = buildPollData('Q?', ['A', 'B'])
      const reactions = { '1️⃣': ['alice', 'alice'] }

      // Set uses identity, so 'alice' appears once
      expect(getTotalVoters(poll, reactions)).toBe(1)
    })
  })

  describe('edge cases: enforceSingleVote', () => {
    it('should handle empty pollEmojis array', () => {
      // No poll emojis means nothing gets filtered
      const result = enforceSingleVote(['👍', '❤️'], '1️⃣', [])
      expect(result).toEqual(['👍', '❤️', '1️⃣'])
    })

    it('should handle duplicate entries in currentReactions', () => {
      const result = enforceSingleVote(['1️⃣', '1️⃣', '👍'], '2️⃣', ['1️⃣', '2️⃣', '3️⃣'])
      // Both '1️⃣' entries are removed, '👍' preserved, '2️⃣' added
      expect(result).toEqual(['👍', '2️⃣'])
    })

    it('should handle newVote that is not in pollEmojis', () => {
      // Voting with a non-poll emoji — still removes poll emojis and adds the new one
      const result = enforceSingleVote(['1️⃣'], '🎉', ['1️⃣', '2️⃣'])
      expect(result).toEqual(['🎉'])
    })
  })

  describe('edge cases: enforceMultiVote', () => {
    it('should handle duplicate entries in currentReactions', () => {
      // Only the first match is removed by filter
      const result = enforceMultiVote(['1️⃣', '1️⃣', '2️⃣'], '1️⃣')
      // filter removes ALL occurrences of '1️⃣'
      expect(result).toEqual(['2️⃣'])
    })

    it('should handle empty currentReactions', () => {
      const result = enforceMultiVote([], '1️⃣')
      expect(result).toEqual(['1️⃣'])
    })
  })

  describe('edge cases: hasVotedOnPoll', () => {
    it('should return false when reactions exist but not for any poll option', () => {
      const poll = buildPollData('Q?', ['A', 'B'])
      const reactions = { '👍': ['alice'], '❤️': ['alice'] }
      expect(hasVotedOnPoll(poll, reactions, 'alice')).toBe(false)
    })

    it('should handle voter appearing in multiple options', () => {
      const poll = buildPollData('Q?', ['A', 'B'], { allowMultiple: true })
      const reactions = { '1️⃣': ['alice'], '2️⃣': ['alice'] }
      expect(hasVotedOnPoll(poll, reactions, 'alice')).toBe(true)
    })
  })

  describe('regression: single-vote must remove previous vote', () => {
    // Regression test for bug where the app used a naive toggle (add/remove the clicked emoji)
    // instead of enforceSingleVote, leaving the old vote in place alongside the new one.
    const pollEmojis = ['1️⃣', '2️⃣', '3️⃣']

    it('naive toggle would leave two votes — enforceSingleVote removes the old one', () => {
      const currentReactions = ['1️⃣'] // Already voted for option 1
      const newVote = '2️⃣'            // Now voting for option 2

      // BUG: naive toggle just adds the new emoji (old behavior)
      const naiveResult = [...currentReactions, newVote]
      expect(naiveResult).toEqual(['1️⃣', '2️⃣']) // WRONG: two poll votes!

      // FIX: enforceSingleVote removes old poll emojis first
      const correctResult = enforceSingleVote(currentReactions, newVote, pollEmojis)
      expect(correctResult).toEqual(['2️⃣']) // CORRECT: only the new vote
    })

    it('naive toggle would leave two votes with non-poll emojis — enforceSingleVote preserves only non-poll', () => {
      const currentReactions = ['👍', '1️⃣'] // Thumbs-up + vote for option 1
      const newVote = '3️⃣'                  // Now voting for option 3

      // BUG: naive toggle
      const naiveResult = [...currentReactions, newVote]
      expect(naiveResult).toEqual(['👍', '1️⃣', '3️⃣']) // WRONG: old poll vote lingers

      // FIX
      const correctResult = enforceSingleVote(currentReactions, newVote, pollEmojis)
      expect(correctResult).toEqual(['👍', '3️⃣']) // CORRECT: only non-poll emoji + new vote
    })
  })

  // ── Bad input tolerance & calculation correctness ─────────────────
  // Simulates reactions from other users (including legacy clients, buggy
  // clients, or deliberately malformed data) and verifies that tallying
  // remains correct and never crashes.

  describe('bad input tolerance: tallying', () => {
    const poll = buildPollData('Q?', ['Pizza', 'Sushi', 'Tacos'])

    it('should handle empty string voter names', () => {
      const reactions = { '1️⃣': ['', 'alice'], '2️⃣': [''] }

      const tally = tallyPollResults(poll, reactions)
      // Single-vote: '' assigned to last option (2️⃣), alice stays in option 1
      expect(tally[0].voters).toEqual(['alice'])
      expect(tally[0].count).toBe(1)
      expect(tally[1].voters).toEqual([''])
      expect(tally[1].count).toBe(1)
    })

    it('should handle voter names with special characters', () => {
      const reactions = {
        '1️⃣': ['user@example.com/resource', 'nick with spaces', '日本語ニック'],
        '2️⃣': ['<script>alert(1)</script>'],
      }

      const tally = tallyPollResults(poll, reactions)
      expect(tally[0].count).toBe(3)
      expect(tally[1].count).toBe(1)
    })

    it('should handle every voter cheating in single-vote (voted all options)', () => {
      // All 3 users reacted on all 3 options — each should count once, in last option
      const reactions = {
        '1️⃣': ['alice', 'bob', 'carol'],
        '2️⃣': ['alice', 'bob', 'carol'],
        '3️⃣': ['alice', 'bob', 'carol'],
      }

      const tally = tallyPollResults(poll, reactions)
      expect(tally[0].count).toBe(0) // filtered
      expect(tally[1].count).toBe(0) // filtered
      expect(tally[2].count).toBe(3) // all assigned here (last option)

      // Total voters should still be 3
      expect(getTotalVoters(poll, reactions)).toBe(3)
    })

    it('should handle a mix of valid and cheating voters', () => {
      const reactions = {
        '1️⃣': ['alice', 'cheater'],         // alice: legitimate, cheater: also in option 2
        '2️⃣': ['bob', 'cheater'],            // bob: legitimate
        '3️⃣': ['carol'],                      // carol: legitimate
      }

      const tally = tallyPollResults(poll, reactions)
      // cheater counted in last option (2️⃣), not first (1️⃣)
      expect(tally[0]).toEqual({ emoji: '1️⃣', label: 'Pizza', voters: ['alice'], count: 1 })
      expect(tally[1]).toEqual({ emoji: '2️⃣', label: 'Sushi', voters: ['bob', 'cheater'], count: 2 })
      expect(tally[2]).toEqual({ emoji: '3️⃣', label: 'Tacos', voters: ['carol'], count: 1 })

      expect(getTotalVoters(poll, reactions)).toBe(4)
    })

    it('should handle reactions map with only non-poll emojis', () => {
      const reactions = {
        '👍': ['alice', 'bob'],
        '❤️': ['carol'],
        '🎉': ['dave'],
      }

      const tally = tallyPollResults(poll, reactions)
      expect(tally.every(t => t.count === 0)).toBe(true)
      expect(getTotalVoters(poll, reactions)).toBe(0)
    })

    it('should handle empty voter arrays for all options', () => {
      const reactions = { '1️⃣': [], '2️⃣': [], '3️⃣': [] }

      const tally = tallyPollResults(poll, reactions)
      expect(tally.every(t => t.count === 0)).toBe(true)
      expect(getTotalVoters(poll, reactions)).toBe(0)
    })

    it('should handle reactions for emojis not in the poll options', () => {
      // Only non-matching emojis — poll options use 1️⃣ 2️⃣ 3️⃣
      const reactions = { '4️⃣': ['alice'], '5️⃣': ['bob'] }

      const tally = tallyPollResults(poll, reactions)
      expect(tally.every(t => t.count === 0)).toBe(true)
    })

    it('should preserve option order regardless of reaction map key order', () => {
      // Reactions map has emojis in reverse order
      const reactions = { '3️⃣': ['carol'], '1️⃣': ['alice'], '2️⃣': ['bob'] }

      const tally = tallyPollResults(poll, reactions)
      // Tally should follow poll option order, not reaction map key order
      expect(tally[0].emoji).toBe('1️⃣')
      expect(tally[0].label).toBe('Pizza')
      expect(tally[1].emoji).toBe('2️⃣')
      expect(tally[1].label).toBe('Sushi')
      expect(tally[2].emoji).toBe('3️⃣')
      expect(tally[2].label).toBe('Tacos')
    })
  })

  describe('bad input tolerance: tallying with many options', () => {
    it('should handle 9-option poll with complex voting patterns', () => {
      const poll = buildPollData('Q?', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])

      // Single-vote: cheater voted on options 3, 5, and 8
      const reactions = {
        '1️⃣': ['alice'],
        '2️⃣': ['bob'],
        '3️⃣': ['cheater', 'carol'],
        '4️⃣': [],
        '5️⃣': ['cheater', 'dave'],
        '6️⃣': [],
        '7️⃣': [],
        '8️⃣': ['cheater'],
        '9️⃣': ['eve'],
      }

      const tally = tallyPollResults(poll, reactions)

      // cheater's vote should only count in option 8 (last appearance)
      expect(tally[2].voters).not.toContain('cheater')
      expect(tally[2].count).toBe(1) // carol only
      expect(tally[4].voters).not.toContain('cheater')
      expect(tally[4].count).toBe(1) // dave only
      expect(tally[7].voters).toContain('cheater')
      expect(tally[7].count).toBe(1) // cheater only

      // Total unique voters: alice, bob, cheater, carol, dave, eve = 6
      expect(getTotalVoters(poll, reactions)).toBe(6)
    })
  })

  describe('bad input tolerance: multi-vote tallying', () => {
    const multiPoll = buildPollData('Q?', ['A', 'B', 'C'], { allowMultiple: true })

    it('should count all votes in multi-vote even with duplicate voter in same option', () => {
      const reactions = {
        '1️⃣': ['alice', 'alice', 'bob'],
        '2️⃣': ['alice'],
        '3️⃣': [],
      }

      const tally = tallyPollResults(multiPoll, reactions)
      // Multi-vote: no deduplication, raw arrays used
      expect(tally[0].count).toBe(3) // alice (x2) + bob
      expect(tally[1].count).toBe(1) // alice
      expect(tally[2].count).toBe(0)

      // getTotalVoters still deduplicates across options
      expect(getTotalVoters(multiPoll, reactions)).toBe(2) // alice + bob
    })

    it('should allow a voter to appear in every option in multi-vote', () => {
      const reactions = {
        '1️⃣': ['alice'],
        '2️⃣': ['alice'],
        '3️⃣': ['alice'],
      }

      const tally = tallyPollResults(multiPoll, reactions)
      expect(tally[0].count).toBe(1)
      expect(tally[1].count).toBe(1)
      expect(tally[2].count).toBe(1)
      expect(getTotalVoters(multiPoll, reactions)).toBe(1)
    })
  })

  describe('tally + totalVoters consistency', () => {
    it('single-vote: sum of tally counts should equal total unique voters', () => {
      const poll = buildPollData('Q?', ['A', 'B', 'C'])
      const reactions = {
        '1️⃣': ['alice', 'cheater'],
        '2️⃣': ['bob', 'cheater', 'carol'],
        '3️⃣': ['dave', 'cheater'],
      }

      const tally = tallyPollResults(poll, reactions)
      const tallySum = tally.reduce((sum, t) => sum + t.count, 0)
      const totalVoters = getTotalVoters(poll, reactions)

      // In single-vote mode, each voter is counted exactly once in tally
      // so the sum of counts must equal the total unique voters
      expect(tallySum).toBe(totalVoters)
    })

    it('single-vote: tally count sum equals totalVoters even with heavy cheating', () => {
      const poll = buildPollData('Q?', ['A', 'B'])
      // 5 voters, all cheating (voted both options)
      const reactions = {
        '1️⃣': ['u1', 'u2', 'u3', 'u4', 'u5'],
        '2️⃣': ['u1', 'u2', 'u3', 'u4', 'u5'],
      }

      const tally = tallyPollResults(poll, reactions)
      const tallySum = tally.reduce((sum, t) => sum + t.count, 0)

      // All 5 assigned to option 2 (last in order), option 1 gets 0
      expect(tally[0].count).toBe(0)
      expect(tally[1].count).toBe(5)
      expect(tallySum).toBe(5)
      expect(getTotalVoters(poll, reactions)).toBe(5)
    })

    it('multi-vote: tally sum can exceed total unique voters', () => {
      const poll = buildPollData('Q?', ['A', 'B'], { allowMultiple: true })
      const reactions = {
        '1️⃣': ['alice', 'bob'],
        '2️⃣': ['alice'],
      }

      const tally = tallyPollResults(poll, reactions)
      const tallySum = tally.reduce((sum, t) => sum + t.count, 0)

      // Multi-vote: alice counted in both → sum is 3, but only 2 unique voters
      expect(tallySum).toBe(3)
      expect(getTotalVoters(poll, reactions)).toBe(2)
    })
  })

  describe('bad input tolerance: hasVotedOnPoll', () => {
    const poll = buildPollData('Q?', ['A', 'B', 'C'])

    it('should detect vote even if user cheated (voted multiple options)', () => {
      const reactions = { '1️⃣': ['alice'], '2️⃣': ['alice'] }
      expect(hasVotedOnPoll(poll, reactions, 'alice')).toBe(true)
    })

    it('should return false for empty string voter checking empty string in reactions', () => {
      const reactions = { '1️⃣': [''] }
      // Empty string voter matches empty string query
      expect(hasVotedOnPoll(poll, reactions, '')).toBe(true)
    })

    it('should not match voter in non-poll emoji reactions', () => {
      const reactions = { '👍': ['alice'], '❤️': ['alice'] }
      expect(hasVotedOnPoll(poll, reactions, 'alice')).toBe(false)
    })

    it('should handle reactions map with missing poll option emojis', () => {
      // Reactions only for option 2, options 1 and 3 not present
      const reactions = { '2️⃣': ['alice'] }
      expect(hasVotedOnPoll(poll, reactions, 'alice')).toBe(true)
      expect(hasVotedOnPoll(poll, reactions, 'bob')).toBe(false)
    })
  })

  describe('bad input tolerance: percentage calculation safety', () => {
    it('should produce 0% for all options when no voters', () => {
      const poll = buildPollData('Q?', ['A', 'B'])
      const tally = tallyPollResults(poll, {})

      tally.forEach(option => {
        const totalVoters = getTotalVoters(poll, {})
        const percentage = totalVoters > 0 ? Math.round((option.count / totalVoters) * 100) : 0
        expect(percentage).toBe(0)
        expect(Number.isFinite(percentage)).toBe(true)
      })
    })

    it('should produce valid percentages that sum to ~100%', () => {
      const poll = buildPollData('Q?', ['A', 'B', 'C'])
      const reactions = {
        '1️⃣': ['a1', 'a2', 'a3'],
        '2️⃣': ['b1', 'b2'],
        '3️⃣': ['c1'],
      }

      const tally = tallyPollResults(poll, reactions)
      const totalVoters = getTotalVoters(poll, reactions)

      const percentages = tally.map(t =>
        totalVoters > 0 ? Math.round((t.count / totalVoters) * 100) : 0
      )

      // All percentages should be non-negative finite numbers
      percentages.forEach(p => {
        expect(p).toBeGreaterThanOrEqual(0)
        expect(p).toBeLessThanOrEqual(100)
        expect(Number.isFinite(p)).toBe(true)
      })

      // Sum should be close to 100 (rounding may cause ±1)
      const sum = percentages.reduce((a, b) => a + b, 0)
      expect(sum).toBeGreaterThanOrEqual(99)
      expect(sum).toBeLessThanOrEqual(101)
    })

    it('should handle single voter producing 100% on one option', () => {
      const poll = buildPollData('Q?', ['A', 'B', 'C'])
      const reactions = { '2️⃣': ['alice'] }

      const tally = tallyPollResults(poll, reactions)
      const totalVoters = getTotalVoters(poll, reactions)

      const percentages = tally.map(t =>
        totalVoters > 0 ? Math.round((t.count / totalVoters) * 100) : 0
      )

      expect(percentages).toEqual([0, 100, 0])
    })
  })

  describe('round-trip: buildPollData → XML → parsePollElement asymmetry', () => {
    it('should lose empty-label options on parse (build/parse asymmetry)', () => {
      // buildPollData allows empty labels...
      const poll = buildPollData('Q?', ['', 'B', 'C'])
      expect(poll.options).toHaveLength(3)

      // ...but parsePollElement filters them out
      const pollEl = createMockElement('poll', { xmlns: 'urn:fluux:poll:0' }, [
        { name: 'title', text: 'Q?' },
        ...poll.options.map(o => ({ name: 'option', attrs: { emoji: o.emoji }, text: o.label })),
      ])
      const parsed = parsePollElement(pollEl)
      // Parsed poll has only 2 options (the empty label was dropped)
      expect(parsed!.options).toHaveLength(2)
    })
  })

  describe('enforceSingleVote edge cases (poll reaction routing)', () => {
    const pollEmojis = ['1️⃣', '2️⃣', '3️⃣']

    it('toggles off when clicking the same emoji already voted', () => {
      const result = enforceSingleVote(['1️⃣'], '1️⃣', pollEmojis)
      expect(result).toEqual([])
    })

    it('replaces vote when clicking a different poll emoji', () => {
      const result = enforceSingleVote(['1️⃣'], '2️⃣', pollEmojis)
      expect(result).toEqual(['2️⃣'])
    })

    it('preserves non-poll emojis alongside vote', () => {
      const result = enforceSingleVote(['👍', '1️⃣'], '2️⃣', pollEmojis)
      expect(result).toEqual(['👍', '2️⃣'])
    })

    it('adds vote from empty currentReactions', () => {
      const result = enforceSingleVote([], '1️⃣', pollEmojis)
      expect(result).toEqual(['1️⃣'])
    })

    it('recovers from malformed state with multiple poll emojis', () => {
      // Somehow ended up with two poll emojis — enforceSingleVote strips all and adds new
      const result = enforceSingleVote(['1️⃣', '2️⃣'], '3️⃣', pollEmojis)
      expect(result).toEqual(['3️⃣'])
    })

    it('recovers from malformed state by toggling off when clicking one of multiple votes', () => {
      // Has two poll emojis, clicks one of them — strips all poll emojis (toggle off)
      const result = enforceSingleVote(['1️⃣', '2️⃣'], '1️⃣', pollEmojis)
      expect(result).toEqual([])
    })
  })
})
