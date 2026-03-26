/**
 * Poll module tests — verifies stanza construction, vote enforcement,
 * IQ handling, and poll closing behavior at the XMPPClient integration level.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
  type MockXmppClient,
  type MockStoreBindings
} from '../test-utils'
import { NS_POLL } from '../namespaces'

let mockXmppClientInstance: MockXmppClient

// Mock @xmpp/client module
vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => mockXmppClientInstance),
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
    name,
    attrs: attrs || {},
    children: children.flat().filter(Boolean),
    toString: () => `<${name}/>`,
  })),
}))

// Mock @xmpp/debug
vi.mock('@xmpp/debug', () => ({
  default: vi.fn(),
}))

vi.mock('../../utils/uuid', () => ({
  generateUUID: vi.fn(() => 'test-uuid-123'),
}))

// Import after mocking
import { client as xmppClientFactory } from '@xmpp/client'

describe('Poll module', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function connectClient() {
    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
    vi.clearAllMocks()
  }

  function getLastSentStanza() {
    const calls = vi.mocked(mockXmppClientInstance.send).mock.calls
    return calls[calls.length - 1]?.[0]
  }

  describe('sendPoll', () => {
    it('should send a groupchat message to the room', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conference.example.com', 'What for lunch?', ['Pizza', 'Sushi'])

      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)
      const stanza = getLastSentStanza()

      expect(stanza.name).toBe('message')
      expect(stanza.attrs.to).toBe('room@conference.example.com')
      expect(stanza.attrs.type).toBe('groupchat')
      expect(stanza.attrs.id).toBe('test-uuid-123')
    })

    it('should include poll element with title and options', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Favorite?', ['A', 'B', 'C'])

      const stanza = getLastSentStanza()
      const pollEl = stanza.children.find((c: any) => c.name === 'poll')

      expect(pollEl).toBeDefined()
      expect(pollEl.attrs.xmlns).toBe(NS_POLL)

      // Title element
      const titleEl = pollEl.children.find((c: any) => c.name === 'title')
      expect(titleEl).toBeDefined()

      // Options
      const optionEls = pollEl.children.filter((c: any) => c.name === 'option')
      expect(optionEls).toHaveLength(3)
    })

    it('should include description element when provided', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll(
        'room@conf.example.com', 'Team Lunch', ['Pizza', 'Sushi'], {}, 'Pick your favorite for Friday',
      )

      const stanza = getLastSentStanza()
      const pollEl = stanza.children.find((c: any) => c.name === 'poll')
      const descEl = pollEl.children.find((c: any) => c.name === 'description')

      expect(descEl).toBeDefined()
    })

    it('should not include description element when omitted', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'])

      const stanza = getLastSentStanza()
      const pollEl = stanza.children.find((c: any) => c.name === 'poll')
      const descEl = pollEl.children.find((c: any) => c.name === 'description')

      expect(descEl).toBeUndefined()
    })

    it('should include fallback body and store hints', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'])

      const stanza = getLastSentStanza()
      const bodyEl = stanza.children.find((c: any) => c.name === 'body')
      const fallback = stanza.children.find((c: any) => c.name === 'fallback')
      const store = stanza.children.find((c: any) => c.name === 'store')

      expect(bodyEl).toBeDefined()
      expect(fallback).toBeDefined()
      expect(fallback.attrs.for).toBe(NS_POLL)
      expect(store).toBeDefined()
    })

    it('should set allow-multiple attribute when enabled', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'], { allowMultiple: true })

      const stanza = getLastSentStanza()
      const pollEl = stanza.children.find((c: any) => c.name === 'poll')

      expect(pollEl.attrs['allow-multiple']).toBe('true')
    })

    it('should not set allow-multiple attribute when disabled', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'])

      const stanza = getLastSentStanza()
      const pollEl = stanza.children.find((c: any) => c.name === 'poll')

      expect(pollEl.attrs['allow-multiple']).toBeUndefined()
    })

    it('should set hide-results attribute when enabled', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'], { hideResultsBeforeVote: true })

      const stanza = getLastSentStanza()
      const pollEl = stanza.children.find((c: any) => c.name === 'poll')

      expect(pollEl.attrs['hide-results']).toBe('true')
    })

    it('should not set hide-results attribute when disabled', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'])

      const stanza = getLastSentStanza()
      const pollEl = stanza.children.find((c: any) => c.name === 'poll')

      expect(pollEl.attrs['hide-results']).toBeUndefined()
    })

    it('should return the message ID', async () => {
      await connectClient()

      const id = await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'])

      expect(id).toBe('test-uuid-123')
    })

    it('should use custom emojis when provided', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll(
        'room@conf.example.com', 'Favorite?', ['Cats', 'Dogs'],
        {}, undefined, undefined, ['🐱', '🐶'],
      )

      const stanza = getLastSentStanza()
      const pollEl = stanza.children.find((c: any) => c.name === 'poll')
      const optionEls = pollEl.children.filter((c: any) => c.name === 'option')

      expect(optionEls[0].attrs.emoji).toBe('🐱')
      expect(optionEls[1].attrs.emoji).toBe('🐶')
    })
  })

  describe('vote', () => {
    it('should delegate to chat.sendReaction in single-vote mode', async () => {
      await connectClient()
      const sendReactionSpy = vi.spyOn(xmppClient.chat, 'sendReaction').mockResolvedValue()

      const poll = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
      }

      await xmppClient.poll.vote('room@conf.example.com', 'msg-1', '2️⃣', [], poll)

      expect(sendReactionSpy).toHaveBeenCalledWith(
        'room@conf.example.com', 'msg-1', ['2️⃣'], 'groupchat',
      )
    })

    it('should enforce single-vote: remove previous poll vote', async () => {
      await connectClient()
      const sendReactionSpy = vi.spyOn(xmppClient.chat, 'sendReaction').mockResolvedValue()

      const poll = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
      }

      await xmppClient.poll.vote('room@conf.example.com', 'msg-1', '2️⃣', ['1️⃣'], poll)

      expect(sendReactionSpy).toHaveBeenCalledWith(
        'room@conf.example.com', 'msg-1', ['2️⃣'], 'groupchat',
      )
    })

    it('should preserve non-poll reactions in single-vote mode', async () => {
      await connectClient()
      const sendReactionSpy = vi.spyOn(xmppClient.chat, 'sendReaction').mockResolvedValue()

      const poll = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
      }

      await xmppClient.poll.vote('room@conf.example.com', 'msg-1', '2️⃣', ['👍', '1️⃣'], poll)

      expect(sendReactionSpy).toHaveBeenCalledWith(
        'room@conf.example.com', 'msg-1', ['👍', '2️⃣'], 'groupchat',
      )
    })

    it('should toggle off vote in single-vote mode', async () => {
      await connectClient()
      const sendReactionSpy = vi.spyOn(xmppClient.chat, 'sendReaction').mockResolvedValue()

      const poll = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
      }

      await xmppClient.poll.vote('room@conf.example.com', 'msg-1', '1️⃣', ['1️⃣'], poll)

      expect(sendReactionSpy).toHaveBeenCalledWith(
        'room@conf.example.com', 'msg-1', [], 'groupchat',
      )
    })

    it('should toggle vote in multi-vote mode', async () => {
      await connectClient()
      const sendReactionSpy = vi.spyOn(xmppClient.chat, 'sendReaction').mockResolvedValue()

      const poll = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
          { emoji: '3️⃣', label: 'C' },
        ],
        settings: { allowMultiple: true, hideResultsBeforeVote: false },
      }

      await xmppClient.poll.vote('room@conf.example.com', 'msg-1', '2️⃣', ['1️⃣'], poll)

      expect(sendReactionSpy).toHaveBeenCalledWith(
        'room@conf.example.com', 'msg-1', ['1️⃣', '2️⃣'], 'groupchat',
      )
    })

    it('should toggle off in multi-vote mode', async () => {
      await connectClient()
      const sendReactionSpy = vi.spyOn(xmppClient.chat, 'sendReaction').mockResolvedValue()

      const poll = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: true, hideResultsBeforeVote: false },
      }

      await xmppClient.poll.vote('room@conf.example.com', 'msg-1', '1️⃣', ['1️⃣', '2️⃣'], poll)

      expect(sendReactionSpy).toHaveBeenCalledWith(
        'room@conf.example.com', 'msg-1', ['2️⃣'], 'groupchat',
      )
    })
  })

  describe('closePoll', () => {
    it('should return null for unknown poll', async () => {
      await connectClient()

      const result = await xmppClient.poll.closePoll('room@conf.example.com', 'unknown-id')

      expect(result).toBeNull()
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })

    it('should return null for wrong room', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room1@conf.example.com', 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      const result = await xmppClient.poll.closePoll('room2@conf.example.com', 'test-uuid-123')

      expect(result).toBeNull()
    })

    it('should send poll-closed message for known poll', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        reactions: {
          '1️⃣': ['alice', 'bob'],
          '2️⃣': ['carol'],
        },
      } as any)

      const resultId = await xmppClient.poll.closePoll('room@conf.example.com', 'test-uuid-123')

      expect(resultId).toBe('test-uuid-123')
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)

      const stanza = getLastSentStanza()
      expect(stanza.name).toBe('message')
      expect(stanza.attrs.type).toBe('groupchat')
      expect(stanza.attrs.to).toBe('room@conf.example.com')

      const pollClosedEl = stanza.children.find((c: any) => c.name === 'poll-closed')
      expect(pollClosedEl).toBeDefined()
      expect(pollClosedEl.attrs['message-id']).toBe('test-uuid-123')
    })

    it('should include description in poll-closed when original poll had one', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Team Lunch', ['A', 'B'], {}, 'Friday plans')
      vi.clearAllMocks()

      vi.mocked(mockStores.room.getMessage).mockReturnValue({ reactions: {} } as any)

      await xmppClient.poll.closePoll('room@conf.example.com', 'test-uuid-123')

      const stanza = getLastSentStanza()
      const pollClosedEl = stanza.children.find((c: any) => c.name === 'poll-closed')
      const descEl = pollClosedEl.children.find((c: any) => c.name === 'description')

      expect(descEl).toBeDefined()
    })
  })

  describe('handle (IQ poll-results)', () => {
    it('should not handle non-IQ stanzas', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', { from: 'someone@example.com' })
      const handled = xmppClient.poll.handle(messageStanza)

      expect(handled).toBe(false)
    })

    it('should not handle IQ stanzas without poll-results', async () => {
      await connectClient()

      const iq = createMockElement('iq', { type: 'get', from: 'someone@example.com', id: 'q1' }, [
        { name: 'query', attrs: { xmlns: 'jabber:iq:version' } },
      ])
      const handled = xmppClient.poll.handle(iq)

      expect(handled).toBe(false)
    })

    it('should handle IQ get with poll-results and send error for unknown poll', async () => {
      await connectClient()

      const iq = createMockElement('iq', { type: 'get', from: 'requester@example.com/res', id: 'q1' }, [
        { name: 'poll-results', attrs: { xmlns: NS_POLL, 'message-id': 'unknown-poll' } },
      ])

      const handled = xmppClient.poll.handle(iq)

      expect(handled).toBe(true)

      // Wait for async handlePollResultQuery to send
      await vi.advanceTimersByTimeAsync(10)

      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)

      const response = getLastSentStanza()
      expect(response.name).toBe('iq')
      expect(response.attrs.type).toBe('error')
      expect(response.attrs.to).toBe('requester@example.com/res')
    })

    it('should respond with tally for known poll', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        reactions: {
          '1️⃣': ['alice', 'bob'],
          '2️⃣': ['carol'],
        },
      } as any)

      const iq = createMockElement('iq', { type: 'get', from: 'requester@example.com/res', id: 'q1' }, [
        { name: 'poll-results', attrs: { xmlns: NS_POLL, 'message-id': 'test-uuid-123' } },
      ])

      xmppClient.poll.handle(iq)

      await vi.advanceTimersByTimeAsync(10)

      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)

      const response = getLastSentStanza()
      expect(response.name).toBe('iq')
      expect(response.attrs.type).toBe('result')
      expect(response.attrs.to).toBe('requester@example.com/res')
      expect(response.attrs.id).toBe('q1')

      const pollResults = response.children.find((c: any) => c.name === 'poll-results')
      expect(pollResults).toBeDefined()
      expect(pollResults.attrs['message-id']).toBe('test-uuid-123')
      expect(pollResults.attrs.closed).toBe('false')
    })

    it('should report closed=true after closePoll', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      vi.mocked(mockStores.room.getMessage).mockReturnValue({ reactions: {} } as any)

      await xmppClient.poll.closePoll('room@conf.example.com', 'test-uuid-123')
      vi.clearAllMocks()

      const iq = createMockElement('iq', { type: 'get', from: 'requester@example.com/res', id: 'q2' }, [
        { name: 'poll-results', attrs: { xmlns: NS_POLL, 'message-id': 'test-uuid-123' } },
      ])

      xmppClient.poll.handle(iq)

      await vi.advanceTimersByTimeAsync(10)

      const response = getLastSentStanza()
      const pollResults = response.children.find((c: any) => c.name === 'poll-results')
      expect(pollResults.attrs.closed).toBe('true')
    })
  })

  describe('sendPoll with deadline', () => {
    it('should include deadline attribute on poll element', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll(
        'room@conf.example.com', 'Q?', ['A', 'B'], {}, undefined, '2026-12-31T23:59:00.000Z',
      )

      const stanza = getLastSentStanza()
      const pollEl = stanza.children.find((c: any) => c.name === 'poll')

      expect(pollEl.attrs.deadline).toBe('2026-12-31T23:59:00.000Z')
    })

    it('should not include deadline attribute when not provided', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'])

      const stanza = getLastSentStanza()
      const pollEl = stanza.children.find((c: any) => c.name === 'poll')

      expect(pollEl.attrs.deadline).toBeUndefined()
    })
  })

  describe('vote with deadline enforcement', () => {
    it('should reject vote on expired poll', async () => {
      await connectClient()

      const poll = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
        deadline: '2020-01-01T00:00:00.000Z', // in the past
      }

      await expect(
        xmppClient.poll.vote('room@conf.example.com', 'msg-1', '1️⃣', [], poll),
      ).rejects.toThrow('Poll has expired')
    })

    it('should allow vote on poll with future deadline', async () => {
      await connectClient()
      const sendReactionSpy = vi.spyOn(xmppClient.chat, 'sendReaction').mockResolvedValue()

      const poll = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
        deadline: '2099-12-31T23:59:00.000Z',
      }

      await xmppClient.poll.vote('room@conf.example.com', 'msg-1', '1️⃣', [], poll)

      expect(sendReactionSpy).toHaveBeenCalled()
    })

    it('should allow vote on poll without deadline', async () => {
      await connectClient()
      const sendReactionSpy = vi.spyOn(xmppClient.chat, 'sendReaction').mockResolvedValue()

      const poll = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
      }

      await xmppClient.poll.vote('room@conf.example.com', 'msg-1', '1️⃣', [], poll)

      expect(sendReactionSpy).toHaveBeenCalled()
    })
  })

  // ── Edge cases & bug regression tests ──────────────────────────────

  describe('closePoll edge cases', () => {
    it('should not send duplicate close message when called twice', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      vi.mocked(mockStores.room.getMessage).mockReturnValue({ reactions: {} } as any)

      const result1 = await xmppClient.poll.closePoll('room@conf.example.com', 'test-uuid-123')
      expect(result1).not.toBeNull()

      // Second call should be rejected because poll is already closed
      const result2 = await xmppClient.poll.closePoll('room@conf.example.com', 'test-uuid-123')
      expect(result2).toBeNull()
      // Only one close message should have been sent
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)
    })

    it('should handle store returning undefined for getMessage', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      // Store returns undefined — message not found
      vi.mocked(mockStores.room.getMessage).mockReturnValue(undefined as any)

      const result = await xmppClient.poll.closePoll('room@conf.example.com', 'test-uuid-123')
      // Should still succeed (with zero votes) — not crash
      expect(result).not.toBeNull()
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)
    })

    it('should close a poll loaded from MAM history (not in localPolls)', async () => {
      await connectClient()

      // Poll was NOT created via sendPoll() this session — simulate MAM-loaded poll
      const pollData = {
        title: 'Lunch?',
        options: [
          { emoji: '1️⃣', label: 'Pizza' },
          { emoji: '2️⃣', label: 'Sushi' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
      }

      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        poll: pollData,
        reactions: {
          '1️⃣': ['alice'],
          '2️⃣': ['bob', 'carol'],
        },
      } as any)

      const result = await xmppClient.poll.closePoll('room@conf.example.com', 'mam-msg-42')

      expect(result).not.toBeNull()
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)

      const stanza = getLastSentStanza()
      expect(stanza.attrs.type).toBe('groupchat')
      const pollClosedEl = stanza.children.find((c: any) => c.name === 'poll-closed')
      expect(pollClosedEl).toBeDefined()
      expect(pollClosedEl.attrs['message-id']).toBe('mam-msg-42')

      // Verify tally values
      const tallies = pollClosedEl.children.filter((c: any) => c.name === 'tally')
      expect(tallies).toHaveLength(2)
      expect(tallies[0].attrs.count).toBe('1')
      expect(tallies[1].attrs.count).toBe('2')
    })
  })

  describe('vote edge cases', () => {
    it('should reject vote with emoji not in poll options', async () => {
      await connectClient()
      vi.spyOn(xmppClient.chat, 'sendReaction').mockResolvedValue()

      const poll = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
      }

      // Voting with a non-poll emoji should be rejected
      await expect(
        xmppClient.poll.vote('room@conf.example.com', 'msg-1', '🎉', [], poll),
      ).rejects.toThrow('not a valid poll option')
    })

    it('should handle voting on closed poll (already closed by closePoll)', async () => {
      await connectClient()
      vi.spyOn(xmppClient.chat, 'sendReaction').mockResolvedValue()

      // closePoll marks the poll as closed in localPolls, but vote() receives
      // PollData directly — it doesn't check localPolls. This test documents
      // that close-poll enforcement is UI-side (PollCard disables voting when expired).
      const poll = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
      }

      // Vote should succeed — poll module only checks deadline, not closed state
      await xmppClient.poll.vote('room@conf.example.com', 'msg-1', '1️⃣', [], poll)
      expect(xmppClient.chat.sendReaction).toHaveBeenCalled()
    })

    it('should reject vote when isClosed=true is passed', async () => {
      await connectClient()
      vi.spyOn(xmppClient.chat, 'sendReaction').mockResolvedValue()

      const poll = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
      }

      await expect(
        xmppClient.poll.vote('room@conf.example.com', 'msg-1', '1️⃣', [], poll, true),
      ).rejects.toThrow('Poll is closed')
    })

    it('should allow vote when isClosed is undefined', async () => {
      await connectClient()
      const sendReactionSpy = vi.spyOn(xmppClient.chat, 'sendReaction').mockResolvedValue()

      const poll = {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
      }

      await xmppClient.poll.vote('room@conf.example.com', 'msg-1', '1️⃣', [], poll, undefined)
      expect(sendReactionSpy).toHaveBeenCalled()
    })
  })

  describe('IQ handling edge cases', () => {
    it('should not handle IQ set (only IQ get)', async () => {
      await connectClient()

      const iq = createMockElement('iq', { type: 'set', from: 'someone@example.com', id: 'q1' }, [
        { name: 'poll-results', attrs: { xmlns: NS_POLL, 'message-id': 'msg-1' } },
      ])

      expect(xmppClient.poll.handle(iq)).toBe(false)
    })

    it('should not handle IQ result (only IQ get)', async () => {
      await connectClient()

      const iq = createMockElement('iq', { type: 'result', from: 'someone@example.com', id: 'q1' }, [
        { name: 'poll-results', attrs: { xmlns: NS_POLL, 'message-id': 'msg-1' } },
      ])

      expect(xmppClient.poll.handle(iq)).toBe(false)
    })

    it('should handle IQ without from attribute gracefully', async () => {
      await connectClient()

      await xmppClient.poll.sendPoll('room@conf.example.com', 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      const iq = createMockElement('iq', { type: 'get', id: 'q1' }, [
        { name: 'poll-results', attrs: { xmlns: NS_POLL, 'message-id': 'test-uuid-123' } },
      ])

      const handled = xmppClient.poll.handle(iq)
      expect(handled).toBe(true)

      await vi.advanceTimersByTimeAsync(10)
      // Should not crash, just silently skip (no from to reply to)
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })
  })

  describe('poll-closed creator verification', () => {
    const roomJid = 'room@conf.example.com'
    let emitSDKSpy: ReturnType<typeof vi.spyOn>

    function setupRoomWithPollMessage(creatorNick: string, creatorOccupantId?: string) {
      // Room must exist for processRoomMessage to proceed
      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'me',
        occupants: new Map(),
        isJoined: true,
      } as any)

      // The original poll message in the store
      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        id: 'poll-msg-1',
        type: 'groupchat',
        roomJid,
        nick: creatorNick,
        from: `${roomJid}/${creatorNick}`,
        body: '',
        timestamp: new Date(),
        isOutgoing: false,
        poll: {
          title: 'Lunch?',
          options: [{ emoji: '1️⃣', label: 'Pizza' }, { emoji: '2️⃣', label: 'Sushi' }],
          settings: { allowMultiple: false, hideResultsBeforeVote: false },
          ...(creatorOccupantId ? { creatorId: creatorOccupantId } : {}),
        },
        ...(creatorOccupantId ? { occupantId: creatorOccupantId } : {}),
      } as any)
    }

    function buildPollClosedStanza(
      senderNick: string,
      senderOccupantId?: string,
      overrides?: { title?: string; tallies?: Array<{ emoji: string; label: string; count: string }> }
    ) {
      const title = overrides?.title ?? 'Lunch?'
      const tallies = overrides?.tallies ?? [
        { emoji: '1️⃣', label: 'Pizza', count: '3' },
        { emoji: '2️⃣', label: 'Sushi', count: '1' },
      ]
      const children: any[] = [
        { name: 'body', text: `Poll closed: ${title}` },
        {
          name: 'poll-closed',
          attrs: { xmlns: 'urn:fluux:poll:0', 'message-id': 'poll-msg-1' },
          children: [
            { name: 'title', text: title },
            ...tallies.map(t => ({ name: 'tally', attrs: { emoji: t.emoji, label: t.label, count: t.count } })),
          ],
        },
      ]
      if (senderOccupantId) {
        children.push({ name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: senderOccupantId } })
      }
      return createMockElement('message', {
        from: `${roomJid}/${senderNick}`,
        to: 'user@example.com',
        type: 'groupchat',
        id: 'close-msg-1',
      }, children)
    }

    function getEmittedRoomMessage() {
      const roomCalls = emitSDKSpy.mock.calls.filter((call: unknown[]) => call[0] === 'room:message')
      if (roomCalls.length === 0) return undefined
      return (roomCalls[0][1] as any).message
    }

    it('should accept poll-closed from the poll creator (nick match)', async () => {
      await connectClient()
      emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
      setupRoomWithPollMessage('alice')

      const stanza = buildPollClosedStanza('alice')
      mockXmppClientInstance._emit('stanza', stanza)

      const message = getEmittedRoomMessage()
      expect(message).toBeDefined()
      expect(message.pollClosed).toBeDefined()
      expect(message.pollClosed.title).toBe('Lunch?')
    })

    it('should reject poll-closed from a different user (nick mismatch)', async () => {
      await connectClient()
      emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
      setupRoomWithPollMessage('alice')

      const stanza = buildPollClosedStanza('eve')
      mockXmppClientInstance._emit('stanza', stanza)

      const message = getEmittedRoomMessage()
      expect(message).toBeDefined()
      expect(message.pollClosed).toBeUndefined()
    })

    it('should accept poll-closed from the creator (occupant-id match)', async () => {
      await connectClient()
      emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
      setupRoomWithPollMessage('alice', 'occ-abc')

      // Nick changed but occupant-id matches
      const stanza = buildPollClosedStanza('alice-renamed', 'occ-abc')
      mockXmppClientInstance._emit('stanza', stanza)

      const message = getEmittedRoomMessage()
      expect(message).toBeDefined()
      expect(message.pollClosed).toBeDefined()
    })

    it('should reject poll-closed with wrong occupant-id', async () => {
      await connectClient()
      emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
      setupRoomWithPollMessage('alice', 'occ-abc')

      const stanza = buildPollClosedStanza('alice', 'occ-eve')
      mockXmppClientInstance._emit('stanza', stanza)

      const message = getEmittedRoomMessage()
      expect(message).toBeDefined()
      expect(message.pollClosed).toBeUndefined()
    })

    it('should reject poll-closed with mismatched title', async () => {
      await connectClient()
      emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
      setupRoomWithPollMessage('alice')

      const stanza = buildPollClosedStanza('alice', undefined, { title: 'Fake title' })
      mockXmppClientInstance._emit('stanza', stanza)

      const message = getEmittedRoomMessage()
      expect(message).toBeDefined()
      expect(message.pollClosed).toBeUndefined()
    })

    it('should reject poll-closed with unknown emojis not in original poll', async () => {
      await connectClient()
      emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
      setupRoomWithPollMessage('alice')

      const stanza = buildPollClosedStanza('alice', undefined, {
        tallies: [
          { emoji: '1️⃣', label: 'Pizza', count: '3' },
          { emoji: '🎉', label: 'Party', count: '2' },  // Not in original poll
        ],
      })
      mockXmppClientInstance._emit('stanza', stanza)

      const message = getEmittedRoomMessage()
      expect(message).toBeDefined()
      expect(message.pollClosed).toBeUndefined()
    })

    it('should accept poll-closed with a subset of original emojis', async () => {
      await connectClient()
      emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
      setupRoomWithPollMessage('alice')

      // Only reporting results for option 1 (subset is OK — option 2 might have 0 votes)
      const stanza = buildPollClosedStanza('alice', undefined, {
        tallies: [{ emoji: '1️⃣', label: 'Pizza', count: '3' }],
      })
      mockXmppClientInstance._emit('stanza', stanza)

      const message = getEmittedRoomMessage()
      expect(message).toBeDefined()
      expect(message.pollClosed).toBeDefined()
    })

    it('should accept poll-closed when original poll is not in store (joined late)', async () => {
      await connectClient()
      emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
      // Room exists but getMessage returns undefined (original poll not loaded)
      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'me',
        occupants: new Map(),
        isJoined: true,
      } as any)
      vi.mocked(mockStores.room.getMessage).mockReturnValue(undefined)

      const stanza = buildPollClosedStanza('eve')
      mockXmppClientInstance._emit('stanza', stanza)

      const message = getEmittedRoomMessage()
      expect(message).toBeDefined()
      expect(message.pollClosed).toBeDefined()
    })
  })

  describe('auto-checkpoint (onRoomReaction / maybeAutoCheckpoint)', () => {
    const roomJid = 'room@conf.example.com'

    function makePollData() {
      return {
        title: 'Q?',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
      }
    }

    function setupStoreMessage(reactions: Record<string, string[]>) {
      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        poll: makePollData(),
        reactions,
      } as any)
    }

    it('should not trigger checkpoint for polls not created locally', async () => {
      await connectClient()
      setupStoreMessage({ '1️⃣': ['a', 'b', 'c', 'd', 'e'] })

      // onRoomReaction for a message not in localPolls — should no-op
      xmppClient.poll.onRoomReaction(roomJid, 'unknown-msg')

      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })

    it('should not trigger checkpoint for closed polls', async () => {
      await connectClient()
      const pollId = await xmppClient.poll.sendPoll(roomJid, 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      // Close the poll
      setupStoreMessage({ '1️⃣': ['a', 'b', 'c', 'd', 'e'] })
      await xmppClient.poll.closePoll(roomJid, pollId)
      vi.clearAllMocks()

      // Now trigger reaction — should be ignored because poll is closed
      xmppClient.poll.onRoomReaction(roomJid, pollId)
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })

    it('should not trigger checkpoint for wrong room', async () => {
      await connectClient()
      const pollId = await xmppClient.poll.sendPoll(roomJid, 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      setupStoreMessage({ '1️⃣': ['a', 'b', 'c', 'd', 'e'] })

      // Different room — should be ignored
      xmppClient.poll.onRoomReaction('other-room@conf.example.com', pollId)
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })

    it('should not trigger checkpoint when total voters < 5', async () => {
      await connectClient()
      const pollId = await xmppClient.poll.sendPoll(roomJid, 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      // Only 4 voters — below CHECKPOINT_MIN_TOTAL_VOTERS (5)
      setupStoreMessage({ '1️⃣': ['a', 'b'], '2️⃣': ['c', 'd'] })

      xmppClient.poll.onRoomReaction(roomJid, pollId)
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })

    it('should not trigger checkpoint when vote delta < 3', async () => {
      await connectClient()
      const pollId = await xmppClient.poll.sendPoll(roomJid, 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      // 6 voters — above threshold
      setupStoreMessage({ '1️⃣': ['a', 'b', 'c'], '2️⃣': ['d', 'e', 'f'] })

      // Send first checkpoint to set lastCheckpointVoteCount = 6
      await xmppClient.poll.sendCheckpoint(roomJid, pollId)
      vi.clearAllMocks()

      // Now only 7 voters — delta of 1, below CHECKPOINT_MIN_VOTE_DELTA (3)
      setupStoreMessage({ '1️⃣': ['a', 'b', 'c'], '2️⃣': ['d', 'e', 'f', 'g'] })

      xmppClient.poll.onRoomReaction(roomJid, pollId)
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })

    it('should trigger checkpoint when all conditions are met', async () => {
      await connectClient()
      const pollId = await xmppClient.poll.sendPoll(roomJid, 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      // 5 voters, no previous checkpoint → delta=5 >= 3, total=5 >= 5
      setupStoreMessage({ '1️⃣': ['a', 'b', 'c'], '2️⃣': ['d', 'e'] })

      xmppClient.poll.onRoomReaction(roomJid, pollId)

      // Should have sent a checkpoint stanza
      await vi.advanceTimersByTimeAsync(10)
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)
      const stanza = mockXmppClientInstance.send.mock.calls[0][0]
      const checkpointEl = stanza.children.find((c: any) => c.name === 'poll-checkpoint')
      expect(checkpointEl).toBeDefined()
    })

    it('should debounce checkpoint within interval window', async () => {
      await connectClient()
      const pollId = await xmppClient.poll.sendPoll(roomJid, 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      // First checkpoint — triggers immediately
      setupStoreMessage({ '1️⃣': ['a', 'b', 'c'], '2️⃣': ['d', 'e'] })
      xmppClient.poll.onRoomReaction(roomJid, pollId)
      await vi.advanceTimersByTimeAsync(10)
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)
      vi.clearAllMocks()

      // Second reaction immediately after — should be debounced (within 60s interval)
      setupStoreMessage({ '1️⃣': ['a', 'b', 'c', 'f', 'g', 'h'], '2️⃣': ['d', 'e'] })
      xmppClient.poll.onRoomReaction(roomJid, pollId)
      await vi.advanceTimersByTimeAsync(10)
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()

      // After the interval expires, the debounced timer fires
      await vi.advanceTimersByTimeAsync(61_000)
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)
    })

    it('should not trigger when store returns no poll data for the message', async () => {
      await connectClient()
      const pollId = await xmppClient.poll.sendPoll(roomJid, 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      // Store returns message without poll data
      vi.mocked(mockStores.room.getMessage).mockReturnValue({ reactions: {} } as any)

      xmppClient.poll.onRoomReaction(roomJid, pollId)
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })
  })

  describe('sendCheckpoint edge cases', () => {
    const roomJid = 'room@conf.example.com'

    it('should return null when poll message not found in store and not in localPolls', async () => {
      await connectClient()

      vi.mocked(mockStores.room.getMessage).mockReturnValue(undefined as any)

      const result = await xmppClient.poll.sendCheckpoint(roomJid, 'unknown-msg')
      expect(result).toBeNull()
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })

    it('should return null when store returns message without poll data and not in localPolls', async () => {
      await connectClient()

      vi.mocked(mockStores.room.getMessage).mockReturnValue({ reactions: {} } as any)

      const result = await xmppClient.poll.sendCheckpoint(roomJid, 'msg-no-poll')
      expect(result).toBeNull()
    })

    it('should send checkpoint for locally created poll', async () => {
      await connectClient()
      const pollId = await xmppClient.poll.sendPoll(roomJid, 'Q?', ['A', 'B'])
      vi.clearAllMocks()

      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        poll: {
          title: 'Q?',
          options: [
            { emoji: '1️⃣', label: 'A' },
            { emoji: '2️⃣', label: 'B' },
          ],
          settings: { allowMultiple: false, hideResultsBeforeVote: false },
        },
        reactions: { '1️⃣': ['alice', 'bob'], '2️⃣': ['carol'] },
      } as any)

      const resultId = await xmppClient.poll.sendCheckpoint(roomJid, pollId)
      expect(resultId).not.toBeNull()
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)

      const stanza = mockXmppClientInstance.send.mock.calls[0][0]
      const checkpointEl = stanza.children.find((c: any) => c.name === 'poll-checkpoint')
      expect(checkpointEl).toBeDefined()
      expect(checkpointEl.attrs['message-id']).toBe(pollId)
      expect(checkpointEl.attrs.ts).toBeDefined()
    })

    it('should send checkpoint for MAM-loaded poll (not in localPolls)', async () => {
      await connectClient()

      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        poll: {
          title: 'Lunch?',
          options: [
            { emoji: '1️⃣', label: 'Pizza' },
            { emoji: '2️⃣', label: 'Sushi' },
          ],
          settings: { allowMultiple: false, hideResultsBeforeVote: false },
        },
        reactions: { '1️⃣': ['alice'] },
      } as any)

      const resultId = await xmppClient.poll.sendCheckpoint(roomJid, 'mam-poll-42')
      expect(resultId).not.toBeNull()
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)
    })

    it('should emit room:message-updated to reconcile reactions on sender side', async () => {
      await connectClient()
      const emitSpy = vi.spyOn(xmppClient, 'emitSDK')

      const pollId = await xmppClient.poll.sendPoll(roomJid, 'Q?', ['A', 'B'])
      emitSpy.mockClear()

      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        poll: {
          title: 'Q?',
          options: [
            { emoji: '1️⃣', label: 'A' },
            { emoji: '2️⃣', label: 'B' },
          ],
          settings: { allowMultiple: false, hideResultsBeforeVote: false },
        },
        reactions: { '1️⃣': ['alice', 'bob'] },
      } as any)

      await xmppClient.poll.sendCheckpoint(roomJid, pollId)

      const updateCall = emitSpy.mock.calls.find(
        (c: unknown[]) => c[0] === 'room:message-updated'
          && (c[1] as { messageId: string }).messageId === pollId
          && (c[1] as { updates: { reactions?: unknown } }).updates.reactions
      )
      expect(updateCall).toBeDefined()
    })
  })
})
