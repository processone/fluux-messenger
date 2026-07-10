import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { groupMessagesByDate, shouldShowAvatar, ownGroupKey, whisperThreadPosition, whisperCounterpartPresent, scrollToMessage, isActionMessage, canClosePoll } from './messageGrouping'
import { setActiveMessageListController } from './activeMessageListController'

// Mock CSS.escape since it's not available in JSDOM
// This implementation matches the browser's CSS.escape behavior
vi.stubGlobal('CSS', {
  escape: (str: string) => str.replace(/([/@+=])/g, '\\$1'),
})

describe('groupMessagesByDate', () => {
  it('should group messages by date', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T11:00:00'), from: 'bob' },
      { id: '3', timestamp: new Date('2024-01-16T09:00:00'), from: 'alice' },
    ]

    const groups = groupMessagesByDate(messages)

    expect(groups).toHaveLength(2)
    expect(groups[0].date).toBe('2024-01-15')
    expect(groups[0].messages).toHaveLength(2)
    expect(groups[1].date).toBe('2024-01-16')
    expect(groups[1].messages).toHaveLength(1)
  })

  it('should return empty array for empty messages', () => {
    const groups = groupMessagesByDate([])
    expect(groups).toHaveLength(0)
  })

  it('should handle single message', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
    ]

    const groups = groupMessagesByDate(messages)

    expect(groups).toHaveLength(1)
    expect(groups[0].date).toBe('2024-01-15')
    expect(groups[0].messages).toHaveLength(1)
  })

  it('should preserve message order within groups', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T11:00:00'), from: 'bob' },
      { id: '3', timestamp: new Date('2024-01-15T12:00:00'), from: 'charlie' },
    ]

    const groups = groupMessagesByDate(messages)

    expect(groups[0].messages[0].id).toBe('1')
    expect(groups[0].messages[1].id).toBe('2')
    expect(groups[0].messages[2].id).toBe('3')
  })

  it('should handle multiple days', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-13T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-14T10:00:00'), from: 'bob' },
      { id: '3', timestamp: new Date('2024-01-15T10:00:00'), from: 'charlie' },
    ]

    const groups = groupMessagesByDate(messages)

    expect(groups).toHaveLength(3)
    expect(groups[0].date).toBe('2024-01-13')
    expect(groups[1].date).toBe('2024-01-14')
    expect(groups[2].date).toBe('2024-01-15')
  })

  /**
   * REGRESSION: Messages can arrive out of chronological order (e.g., delayed messages
   * arriving after newer messages). This creates multiple groups with the same date.
   *
   * MessageList must use `${group.date}-${groupIndex}` as the React key to avoid
   * duplicate key warnings when the same date appears in multiple groups.
   */
  it('should consolidate out-of-order messages from same date into single group', () => {
    // Simulate delayed message scenario:
    // 1. Messages from Jan 23 arrive
    // 2. Messages from Jan 24 arrive
    // 3. A delayed message from Jan 23 arrives late (out of order in array)
    const messages = [
      { id: '1', timestamp: new Date('2024-01-23T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-24T09:00:00'), from: 'bob' },
      { id: '3', timestamp: new Date('2024-01-23T11:00:00'), from: 'charlie' }, // Out of order
    ]

    const groups = groupMessagesByDate(messages)

    // Now consolidates into 2 groups (one per date), sorted chronologically
    expect(groups).toHaveLength(2)
    expect(groups[0].date).toBe('2024-01-23')
    expect(groups[1].date).toBe('2024-01-24')

    // Jan 23 group contains both messages, sorted by timestamp
    expect(groups[0].messages).toHaveLength(2)
    expect(groups[0].messages[0].id).toBe('1') // 10:00
    expect(groups[0].messages[1].id).toBe('3') // 11:00

    // Jan 24 group contains its message
    expect(groups[1].messages).toHaveLength(1)
    expect(groups[1].messages[0].id).toBe('2')
  })
})

describe('shouldShowAvatar', () => {
  it('should always show avatar for first message', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
    ]

    expect(shouldShowAvatar(messages, 0)).toBe(true)
  })

  it('should show avatar when sender changes', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'bob' },
    ]

    expect(shouldShowAvatar(messages, 1)).toBe(true)
  })

  it('should not show avatar for consecutive messages from same sender within 5 minutes', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T10:02:00'), from: 'alice' },
    ]

    expect(shouldShowAvatar(messages, 1)).toBe(false)
  })

  it('should show avatar if more than 5 minutes gap from same sender', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T10:06:00'), from: 'alice' },
    ]

    expect(shouldShowAvatar(messages, 1)).toBe(true)
  })

  it('should show avatar exactly at 5 minute boundary', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T10:05:01'), from: 'alice' },
    ]

    expect(shouldShowAvatar(messages, 1)).toBe(true)
  })

  it('should not show avatar at exactly 5 minutes', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T10:05:00'), from: 'alice' },
    ]

    expect(shouldShowAvatar(messages, 1)).toBe(false)
  })

  it('should handle multiple messages in sequence', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'alice' },
      { id: '3', timestamp: new Date('2024-01-15T10:02:00'), from: 'bob' },
      { id: '4', timestamp: new Date('2024-01-15T10:03:00'), from: 'bob' },
      { id: '5', timestamp: new Date('2024-01-15T10:10:00'), from: 'bob' },
    ]

    expect(shouldShowAvatar(messages, 0)).toBe(true)  // first message
    expect(shouldShowAvatar(messages, 1)).toBe(false) // same sender, within 5 min
    expect(shouldShowAvatar(messages, 2)).toBe(true)  // different sender
    expect(shouldShowAvatar(messages, 3)).toBe(false) // same sender, within 5 min
    expect(shouldShowAvatar(messages, 4)).toBe(true)  // same sender, but > 5 min gap
  })

  describe('/me action grouping', () => {
    // REGRESSION: a /me action renders a timestamp in the avatar column with its
    // nick inline — it never spends the avatar/name header. A non-action message
    // from the same sender that follows it must re-show the avatar, otherwise it
    // renders as a headerless continuation with no sender attribution at all and
    // reads as belonging to the PREVIOUS sender's group.
    //
    // Screenshot bug: stepforward posts, then meeson_ posts a `/me` action and a
    // reply. Both of meeson_'s messages had no avatar, so the reply appeared to be
    // written by stepforward.
    it('re-shows the avatar for a normal message following a /me action from the same sender', () => {
      const messages = [
        { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'meeson', body: '/me waves' },
        { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'meeson', body: 'This way...?' },
      ]

      expect(shouldShowAvatar(messages, 1)).toBe(true)
    })

    it('re-shows the avatar when the action opened a new sender run (full screenshot sequence)', () => {
      const messages = [
        { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'stepforward', body: '@meeson_ this way.' },
        { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'meeson', body: '/me wants a LLM in the chat' },
        { id: '3', timestamp: new Date('2024-01-15T10:02:00'), from: 'meeson', body: 'This way...?' },
      ]

      expect(shouldShowAvatar(messages, 1)).toBe(true) // sender changed → action row (nick shown inline)
      expect(shouldShowAvatar(messages, 2)).toBe(true) // emerging from the action → avatar must return
    })

    it('keeps consecutive /me actions from the same sender grouped', () => {
      const messages = [
        { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'meeson', body: '/me waves' },
        { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'meeson', body: '/me nods' },
      ]

      expect(shouldShowAvatar(messages, 1)).toBe(false)
    })
  })

  describe('security context grouping', () => {
    it('breaks the group when trust level changes', () => {
      const messages = [
        {
          id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice',
          securityContext: { protocolId: 'openpgp', trust: 'tofu' as const },
        },
        {
          id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'alice',
          securityContext: { protocolId: 'openpgp', trust: 'untrusted' as const },
        },
      ]

      expect(shouldShowAvatar(messages, 1)).toBe(true)
    })

    it('breaks the group when protocol changes', () => {
      const messages = [
        {
          id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice',
          securityContext: { protocolId: 'openpgp', trust: 'tofu' as const },
        },
        {
          id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'alice',
          securityContext: { protocolId: 'omemo:2', trust: 'tofu' as const },
        },
      ]

      expect(shouldShowAvatar(messages, 1)).toBe(true)
    })

    it('breaks the group when encryption appears', () => {
      const messages = [
        { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
        {
          id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'alice',
          securityContext: { protocolId: 'openpgp', trust: 'tofu' as const },
        },
      ]

      expect(shouldShowAvatar(messages, 1)).toBe(true)
    })

    it('breaks the group when encryption drops', () => {
      const messages = [
        {
          id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice',
          securityContext: { protocolId: 'openpgp', trust: 'tofu' as const },
        },
        { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'alice' },
      ]

      expect(shouldShowAvatar(messages, 1)).toBe(true)
    })

    it('keeps the group when security context is identical', () => {
      const ctx = { protocolId: 'openpgp', trust: 'tofu' as const }
      const messages = [
        { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice', securityContext: ctx },
        { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'alice', securityContext: ctx },
      ]

      expect(shouldShowAvatar(messages, 1)).toBe(false)
    })

    it('keeps the group when both messages are cleartext', () => {
      const messages = [
        { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
        { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'alice' },
      ]

      expect(shouldShowAvatar(messages, 1)).toBe(false)
    })
  })

  describe('whisper context grouping', () => {
    it('breaks the group when a public message is followed by a whisper', () => {
      const messages = [
        { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
        { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'alice', isPrivate: true, whisperWith: 'bob' },
      ]

      expect(shouldShowAvatar(messages, 1)).toBe(true)
    })

    it('breaks the group when a whisper is followed by a public message', () => {
      const messages = [
        { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice', isPrivate: true, whisperWith: 'bob' },
        { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'alice' },
      ]

      expect(shouldShowAvatar(messages, 1)).toBe(true)
    })

    it('breaks the group when the whisper counterpart changes', () => {
      const messages = [
        { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice', isPrivate: true, whisperWith: 'bob' },
        { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'alice', isPrivate: true, whisperWith: 'charlie' },
      ]

      expect(shouldShowAvatar(messages, 1)).toBe(true)
    })

    it('keeps the group for consecutive whispers to the same counterpart within 5 minutes', () => {
      const messages = [
        { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice', isPrivate: true, whisperWith: 'bob' },
        { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'alice', isPrivate: true, whisperWith: 'bob' },
      ]

      expect(shouldShowAvatar(messages, 1)).toBe(false)
    })
  })
})

describe('ownGroupKey', () => {
  const own = (id: string, min: number) => ({
    id,
    from: 'me',
    isOutgoing: true,
    timestamp: new Date(`2024-01-15T10:0${min}:00`),
  })
  const incoming = (id: string, min: number) => ({
    id,
    from: 'alice',
    isOutgoing: false,
    timestamp: new Date(`2024-01-15T10:0${min}:00`),
  })

  it('returns undefined for incoming messages', () => {
    const messages = [incoming('1', 0), incoming('2', 1)]
    expect(ownGroupKey(messages, 0)).toBeUndefined()
    expect(ownGroupKey(messages, 1)).toBeUndefined()
  })

  it('returns undefined for a solo own message (a group of one)', () => {
    const messages = [incoming('1', 0), own('2', 1), incoming('3', 2)]
    expect(ownGroupKey(messages, 1)).toBeUndefined()
  })

  it('returns the group-start id for every row of a multi-message own run', () => {
    const messages = [incoming('a', 0), own('b', 1), own('c', 2), own('d', 3)]
    // All three own rows resolve to the run's first id.
    expect(ownGroupKey(messages, 1)).toBe('b')
    expect(ownGroupKey(messages, 2)).toBe('b')
    expect(ownGroupKey(messages, 3)).toBe('b')
  })

  it('starts a fresh key after a >5min gap splits the own run', () => {
    const messages = [
      { id: 'b', from: 'me', isOutgoing: true, timestamp: new Date('2024-01-15T10:00:00') },
      { id: 'c', from: 'me', isOutgoing: true, timestamp: new Date('2024-01-15T10:01:00') },
      // >5min later — shouldShowAvatar breaks the group here, so a new run begins.
      { id: 'd', from: 'me', isOutgoing: true, timestamp: new Date('2024-01-15T10:10:00') },
      { id: 'e', from: 'me', isOutgoing: true, timestamp: new Date('2024-01-15T10:11:00') },
    ]
    expect(ownGroupKey(messages, 0)).toBe('b')
    expect(ownGroupKey(messages, 1)).toBe('b')
    expect(ownGroupKey(messages, 2)).toBe('d')
    expect(ownGroupKey(messages, 3)).toBe('d')
  })

  it('does not merge an own run across an incoming message', () => {
    const messages = [own('a', 0), incoming('b', 1), own('c', 2)]
    // Both own rows are solo (separated by the incoming), so neither groups.
    expect(ownGroupKey(messages, 0)).toBeUndefined()
    expect(ownGroupKey(messages, 2)).toBeUndefined()
  })
})

describe('whisperThreadPosition', () => {
  // helpers: w = whisper with a counterpart; pub = public message
  const w = (id: string, whisperWith: string, from = 'alice') => ({
    id, timestamp: new Date('2024-01-15T10:00:00'), from, isPrivate: true, whisperWith,
  })
  const pub = (id: string, from = 'alice') => ({
    id, timestamp: new Date('2024-01-15T10:00:00'), from,
  })

  it('returns null for a public message', () => {
    expect(whisperThreadPosition([pub('1')], 0)).toBeNull()
  })

  it('marks a lone whisper between public messages as solo', () => {
    const msgs = [pub('1'), w('2', 'bob'), pub('3')]
    expect(whisperThreadPosition(msgs, 1)).toBe('solo')
  })

  it('gathers a same-counterpart run across alternating senders (start/middle/end)', () => {
    const msgs = [pub('0'), w('1', 'emma', 'emma'), w('2', 'emma', 'you'), w('3', 'emma', 'emma')]
    expect(whisperThreadPosition(msgs, 1)).toBe('start')
    expect(whisperThreadPosition(msgs, 2)).toBe('middle')
    expect(whisperThreadPosition(msgs, 3)).toBe('end')
  })

  it('breaks the run when a public message interrupts', () => {
    const msgs = [w('1', 'emma'), pub('2'), w('3', 'emma')]
    expect(whisperThreadPosition(msgs, 0)).toBe('solo')
    expect(whisperThreadPosition(msgs, 2)).toBe('solo')
  })

  it('breaks the run when the counterpart changes', () => {
    const msgs = [w('1', 'emma'), w('2', 'bob')]
    expect(whisperThreadPosition(msgs, 0)).toBe('solo')
    expect(whisperThreadPosition(msgs, 1)).toBe('solo')
  })

  it('marks a two-message same-counterpart run as start then end', () => {
    const msgs = [w('1', 'emma', 'emma'), w('2', 'emma', 'you')]
    expect(whisperThreadPosition(msgs, 0)).toBe('start')
    expect(whisperThreadPosition(msgs, 1)).toBe('end')
  })

  // Thread identity prefers the stable occupant-id (XEP-0421): a recycled nick
  // must not merge two different people's whisper runs.
  const wo = (id: string, whisperWith: string, whisperWithOccupantId: string, from = 'alice') => ({
    id, timestamp: new Date('2024-01-15T10:00:00'), from, isPrivate: true, whisperWith, whisperWithOccupantId,
  })

  it('splits same-nick whispers that have different occupant-ids (recycled nick)', () => {
    const msgs = [wo('1', 'bob', 'occ-1'), wo('2', 'bob', 'occ-2')]
    expect(whisperThreadPosition(msgs, 0)).toBe('solo')
    expect(whisperThreadPosition(msgs, 1)).toBe('solo')
  })

  it('keeps same-occupant-id whispers in one thread', () => {
    const msgs = [wo('1', 'bob', 'occ-1'), wo('2', 'bob', 'occ-1')]
    expect(whisperThreadPosition(msgs, 0)).toBe('start')
    expect(whisperThreadPosition(msgs, 1)).toBe('end')
  })

  it('falls back to nick when either side lacks an occupant-id', () => {
    const legacy = { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice', isPrivate: true, whisperWith: 'bob' }
    const withId = wo('2', 'bob', 'occ-1')
    expect(whisperThreadPosition([legacy, withId], 0)).toBe('start')
    expect(whisperThreadPosition([legacy, withId], 1)).toBe('end')
  })
})

describe('whisperCounterpartPresent', () => {
  const occ = (nick: string, occupantId?: string) => ({ nick, occupantId })
  const occupantsOf = (...list: { nick: string; occupantId?: string }[]) =>
    new Map(list.map((o) => [o.nick, o] as const))

  it('is present when an occupant matches the counterpart occupant-id', () => {
    const msg = { whisperWith: 'bob', whisperWithOccupantId: 'occ-1' }
    expect(whisperCounterpartPresent(msg, occupantsOf(occ('bob', 'occ-1')))).toBe(true)
  })

  it('is absent when the nick matches but the occupant-id differs (recycled nick)', () => {
    const msg = { whisperWith: 'bob', whisperWithOccupantId: 'occ-1' }
    expect(whisperCounterpartPresent(msg, occupantsOf(occ('bob', 'occ-2')))).toBe(false)
  })

  it('falls back to nick presence when the message has no occupant-id', () => {
    const msg = { whisperWith: 'bob' }
    expect(whisperCounterpartPresent(msg, occupantsOf(occ('bob')))).toBe(true)
    expect(whisperCounterpartPresent(msg, occupantsOf(occ('carol')))).toBe(false)
  })

  it('is absent when the counterpart is no longer in the room', () => {
    const msg = { whisperWith: 'bob', whisperWithOccupantId: 'occ-1' }
    expect(whisperCounterpartPresent(msg, occupantsOf())).toBe(false)
  })
})

describe('scrollToMessage', () => {
  let mockElement: {
    scrollIntoView: ReturnType<typeof vi.fn>
    classList: {
      add: ReturnType<typeof vi.fn>
      remove: ReturnType<typeof vi.fn>
    }
  }
  let querySelectorSpy: ReturnType<typeof vi.spyOn>
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockElement = {
      scrollIntoView: vi.fn(),
      classList: {
        add: vi.fn(),
        remove: vi.fn(),
      },
    }
    querySelectorSpy = vi.spyOn(document, 'querySelector')
    vi.spyOn(document, 'querySelectorAll').mockReturnValue([] as unknown as NodeListOf<Element>)
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('should scroll to message element and add highlight class', () => {
    querySelectorSpy.mockReturnValue(mockElement as unknown as Element)

    scrollToMessage('msg-123')

    expect(querySelectorSpy).toHaveBeenCalledWith('[data-message-id="msg-123"]')
    expect(mockElement.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    })
    expect(mockElement.classList.add).toHaveBeenCalledWith('message-highlight')
  })

  it('should remove highlight class after 1.5 seconds', () => {
    querySelectorSpy.mockReturnValue(mockElement as unknown as Element)

    scrollToMessage('msg-123')

    // Highlight should not be removed yet
    expect(mockElement.classList.remove).not.toHaveBeenCalled()

    // Advance time by 1.5 seconds
    vi.advanceTimersByTime(1500)

    expect(mockElement.classList.remove).toHaveBeenCalledWith('message-highlight')
  })

  it('should not throw if message element is not found', () => {
    querySelectorSpy.mockReturnValue(null)

    // Should not throw
    expect(() => scrollToMessage('non-existent-id')).not.toThrow()

    expect(querySelectorSpy).toHaveBeenCalledWith('[data-message-id="non-existent-id"]')
    expect(mockElement.scrollIntoView).not.toHaveBeenCalled()

    // scrollToMessage retries several times via requestAnimationFrame before warning.
    // Flush all pending rAF callbacks (jsdom polyfills rAF as setTimeout ~16ms/frame).
    vi.advanceTimersByTime(300)

    // Should log warning for debugging after retries exhausted
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[scrollToMessage] Message not found in DOM: id="non-existent-id"'
    )
  })

  it('windows an off-screen (virtualized) target in via the active controller, then scrolls to it', () => {
    // The target row is NOT in the DOM until the active list mounts it — the failure mode a plain
    // querySelector retry can never recover from. scrollToMessage must ask the controller to window
    // it in, then scroll once it mounts.
    let mounted = false
    querySelectorSpy.mockImplementation(() => (mounted ? (mockElement as unknown as Element) : null))
    const ensureMessageMounted = vi.fn(() => { mounted = true })
    setActiveMessageListController({ hasMessage: () => true, ensureMessageMounted, scrollToBottom: vi.fn() })
    try {
      scrollToMessage('windowed-out-id')

      // Not in the DOM on the first pass → controller asked to window it in (exactly once).
      expect(ensureMessageMounted).toHaveBeenCalledTimes(1)
      expect(ensureMessageMounted).toHaveBeenCalledWith('windowed-out-id')

      // Next frame: the row is now mounted → scrolled + highlighted, no warning.
      vi.advanceTimersByTime(50)
      expect(mockElement.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
      expect(mockElement.classList.add).toHaveBeenCalledWith('message-highlight')
      expect(consoleWarnSpy).not.toHaveBeenCalled()
    } finally {
      setActiveMessageListController(null)
    }
  })

  it('does not ask the controller to mount an id it does not have (no churn on a truly missing id)', () => {
    querySelectorSpy.mockReturnValue(null)
    const ensureMessageMounted = vi.fn()
    setActiveMessageListController({ hasMessage: () => false, ensureMessageMounted, scrollToBottom: vi.fn() })
    try {
      scrollToMessage('unknown-id')
      vi.advanceTimersByTime(300)
      expect(ensureMessageMounted).not.toHaveBeenCalled()
      expect(consoleWarnSpy).toHaveBeenCalled()
    } finally {
      setActiveMessageListController(null)
    }
  })

  it('requests a cache slice for an out-of-window target, then windows + scrolls once it loads', async () => {
    // The target scrolled far out of the loaded window, so it is not even in the virtualizer's
    // item set (hasMessage === false) — ensureMessageMounted alone can never recover it (this is
    // issue #955: reply-quote and poll jumps silently no-op). scrollToMessage must pull the cache
    // slice around the id via loadAround, wait past its default retry budget for the async fetch,
    // then window + scroll as usual once the row enters the item set.
    let loaded = false
    let mounted = false
    querySelectorSpy.mockImplementation(() => (mounted ? (mockElement as unknown as Element) : null))
    // Resolve well past the default ~130ms retry window so the widened budget is exercised.
    const loadAround = vi.fn(
      () => new Promise<void>(resolve => setTimeout(() => { loaded = true; resolve() }, 300)),
    )
    const ensureMessageMounted = vi.fn(() => { mounted = true })
    setActiveMessageListController({
      hasMessage: () => loaded,
      ensureMessageMounted,
      loadAround,
      scrollToBottom: vi.fn(),
    })
    try {
      scrollToMessage('far-out-id')

      // First pass: not in the item set → cache slice requested exactly once.
      expect(loadAround).toHaveBeenCalledTimes(1)
      expect(loadAround).toHaveBeenCalledWith('far-out-id')

      // Slice loads (async) → id enters the item set → row windowed in → scrolled + highlighted.
      await vi.advanceTimersByTimeAsync(500)
      expect(ensureMessageMounted).toHaveBeenCalledWith('far-out-id')
      expect(mockElement.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
      expect(mockElement.classList.add).toHaveBeenCalledWith('message-highlight')
      expect(consoleWarnSpy).not.toHaveBeenCalled()

      // The slice is requested once, not per retry frame.
      expect(loadAround).toHaveBeenCalledTimes(1)
    } finally {
      setActiveMessageListController(null)
    }
  })

  it('should handle special characters in message ID by escaping them', () => {
    querySelectorSpy.mockReturnValue(mockElement as unknown as Element)

    scrollToMessage('msg-with-special/chars@123')

    // CSS.escape escapes special characters like / and @ with backslashes
    expect(querySelectorSpy).toHaveBeenCalledWith('[data-message-id="msg-with-special\\/chars\\@123"]')
    expect(mockElement.scrollIntoView).toHaveBeenCalled()
  })

  it('should escape base64 encoded message IDs', () => {
    querySelectorSpy.mockReturnValue(mockElement as unknown as Element)

    // Base64 IDs often contain +, /, and = characters
    scrollToMessage('abc+def/ghi=jkl')

    expect(querySelectorSpy).toHaveBeenCalledWith('[data-message-id="abc\\+def\\/ghi\\=jkl"]')
    expect(mockElement.scrollIntoView).toHaveBeenCalled()
  })

  it('should resolve a message by its stanza-id when the local id does not match', () => {
    // Regression: MUC replies (XEP-0461) reference the room-assigned stanza-id, but
    // DOM rows are keyed by local message id. When the reply context froze the raw
    // stanza-id (target not in the lookup at render time), scrollToMessage must fall
    // through to data-stanza-id to find the row instead of giving up.
    querySelectorSpy.mockImplementation((sel: string) =>
      sel === '[data-stanza-id="2026-06-08-b9469e60caa58b7f"]'
        ? (mockElement as unknown as Element)
        : null
    )

    scrollToMessage('2026-06-08-b9469e60caa58b7f')

    expect(querySelectorSpy).toHaveBeenCalledWith('[data-message-id="2026-06-08-b9469e60caa58b7f"]')
    expect(querySelectorSpy).toHaveBeenCalledWith('[data-stanza-id="2026-06-08-b9469e60caa58b7f"]')
    expect(mockElement.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    })
    expect(mockElement.classList.add).toHaveBeenCalledWith('message-highlight')
  })

  it('should resolve a message by its origin-id when neither local id nor stanza-id match', () => {
    // XEP-0308 corrections reference the sender-assigned origin-id.
    querySelectorSpy.mockImplementation((sel: string) =>
      sel === '[data-origin-id="origin-xyz"]' ? (mockElement as unknown as Element) : null
    )

    scrollToMessage('origin-xyz')

    expect(querySelectorSpy).toHaveBeenCalledWith('[data-origin-id="origin-xyz"]')
    expect(mockElement.scrollIntoView).toHaveBeenCalled()
  })

  it('should prefer the local-id match over stanza-id / origin-id', () => {
    // The strong local-id tier wins so a sender-controlled origin-id can never shadow
    // a real id match on a different row.
    querySelectorSpy.mockReturnValue(mockElement as unknown as Element)

    scrollToMessage('local-1')

    // First lookup is by data-message-id; since it matches, the fallbacks are skipped.
    expect(querySelectorSpy).toHaveBeenCalledWith('[data-message-id="local-1"]')
    expect(querySelectorSpy).not.toHaveBeenCalledWith('[data-stanza-id="local-1"]')
    expect(mockElement.scrollIntoView).toHaveBeenCalled()
  })
})

describe('isActionMessage', () => {
  it('should return true for /me action messages', () => {
    expect(isActionMessage('/me waves hello')).toBe(true)
    expect(isActionMessage('/me is thinking')).toBe(true)
    expect(isActionMessage('/me ')).toBe(true)
  })

  it('should return false for regular messages', () => {
    expect(isActionMessage('Hello world')).toBe(false)
    expect(isActionMessage('This is a test')).toBe(false)
    expect(isActionMessage('')).toBe(false)
  })

  it('should return false for /me without space', () => {
    expect(isActionMessage('/metest')).toBe(false)
    expect(isActionMessage('/me')).toBe(false)
  })

  it('should return false for /me in middle of message', () => {
    expect(isActionMessage('Hello /me there')).toBe(false)
    expect(isActionMessage('test /me action')).toBe(false)
  })

  it('should handle undefined and null gracefully', () => {
    expect(isActionMessage(undefined)).toBe(false)
    // @ts-expect-error - testing null handling
    expect(isActionMessage(null)).toBe(false)
  })
})

describe('canClosePoll', () => {
  const ownPoll = { isOutgoing: true, poll: { title: 'Lunch?' } }

  it('offers close for your own open poll', () => {
    expect(canClosePoll(ownPoll, false)).toBe(true)
  })

  it('hides close once the poll is closed (reactive boolean — the regression guard)', () => {
    // This is the value that must stay reactive: passing `true` here (because a
    // poll-closed message arrived) MUST flip the decision. The row receives this as
    // a plain boolean prop, never reads it from a frozen stable getter at render.
    expect(canClosePoll(ownPoll, true)).toBe(false)
  })

  it('hides close when the poll message itself is marked closed', () => {
    expect(canClosePoll({ ...ownPoll, pollClosedAt: new Date() }, false)).toBe(false)
  })

  it('never offers close on someone else’s poll', () => {
    expect(canClosePoll({ isOutgoing: false, poll: { title: 'Lunch?' } }, false)).toBe(false)
  })

  it('never offers close on a non-poll message', () => {
    expect(canClosePoll({ isOutgoing: true }, false)).toBe(false)
  })
})
