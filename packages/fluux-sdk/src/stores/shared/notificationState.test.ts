import { describe, it, expect } from 'vitest'
import {
  onMessageReceived,
  onActivate,
  onDeactivate,
  onMarkAsRead,
  onClearMarker,
  onWindowBecameVisible,
  onMessageSeen,
  shouldNotifyConversation,
  shouldNotifyRoom,
  computeBadgeCount,
  createInitialNotificationState,
  type EntityNotificationState,
  type NotificationMessage,
  type EntityContext,
} from './notificationState'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default timestamp is "now" so freshness checks pass in shouldNotify tests. */
function makeMsg(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    id: 'msg-1',
    timestamp: new Date(),
    isOutgoing: false,
    isDelayed: false,
    ...overrides,
  }
}

function makeState(overrides: Partial<EntityNotificationState> = {}): EntityNotificationState {
  return {
    ...createInitialNotificationState(),
    ...overrides,
  }
}

const ACTIVE_VISIBLE: EntityContext = { isActive: true, windowVisible: true }
const ACTIVE_HIDDEN: EntityContext = { isActive: true, windowVisible: false }
const INACTIVE_VISIBLE: EntityContext = { isActive: false, windowVisible: true }
const INACTIVE_HIDDEN: EntityContext = { isActive: false, windowVisible: false }

// ---------------------------------------------------------------------------
// onMessageReceived
// ---------------------------------------------------------------------------

describe('onMessageReceived', () => {
  describe('outgoing messages', () => {
    it('clears unread, mentions, and marker', () => {
      const state = makeState({ unreadCount: 3, mentionsCount: 1, firstNewMessageId: 'old-marker' })
      const msg = makeMsg({ isOutgoing: true })
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE)
      expect(result.unreadCount).toBe(0)
      expect(result.mentionsCount).toBe(0)
      expect(result.firstNewMessageId).toBeUndefined()
      expect(result.lastReadAt).toEqual(msg.timestamp)
    })

    it('clears state regardless of window visibility', () => {
      const state = makeState({ unreadCount: 5 })
      const msg = makeMsg({ isOutgoing: true })
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN)
      expect(result.unreadCount).toBe(0)
      expect(result.firstNewMessageId).toBeUndefined()
    })

    it('preserves lastSeenMessageId', () => {
      const state = makeState({ lastSeenMessageId: 'seen-1' })
      const msg = makeMsg({ isOutgoing: true })
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE)
      expect(result.lastSeenMessageId).toBe('seen-1')
    })
  })

  describe('delayed/historical messages', () => {
    it('returns state unchanged', () => {
      const state = makeState({ unreadCount: 2 })
      const msg = makeMsg({ isDelayed: true })
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN)
      expect(result).toBe(state) // same reference
    })
  })

  describe('incoming message — user sees it', () => {
    it('keeps unread at 0 and updates lastReadAt', () => {
      const state = makeState()
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE)
      expect(result.unreadCount).toBe(0)
      expect(result.mentionsCount).toBe(0)
      expect(result.lastReadAt).toEqual(msg.timestamp)
    })

    it('preserves existing marker', () => {
      const state = makeState({ firstNewMessageId: 'marker-1' })
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, ACTIVE_VISIBLE)
      expect(result.firstNewMessageId).toBe('marker-1')
    })
  })

  describe('incoming message — user does not see it', () => {
    it('increments unreadCount for inactive conversation', () => {
      const state = makeState({ unreadCount: 2 })
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_VISIBLE)
      expect(result.unreadCount).toBe(3)
    })

    it('increments unreadCount for active but hidden window', () => {
      const state = makeState()
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, ACTIVE_HIDDEN)
      expect(result.unreadCount).toBe(1)
    })

    it('sets firstNewMessageId when active + hidden + no existing marker', () => {
      const state = makeState()
      const msg = makeMsg({ id: 'new-msg' })
      const result = onMessageReceived(state, msg, ACTIVE_HIDDEN)
      expect(result.firstNewMessageId).toBe('new-msg')
    })

    it('does not overwrite existing marker', () => {
      const state = makeState({ firstNewMessageId: 'existing-marker' })
      const msg = makeMsg({ id: 'new-msg' })
      const result = onMessageReceived(state, msg, ACTIVE_HIDDEN)
      expect(result.firstNewMessageId).toBe('existing-marker')
    })

    it('does not set marker for inactive entity', () => {
      const state = makeState()
      const msg = makeMsg({ id: 'new-msg' })
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN)
      expect(result.firstNewMessageId).toBeUndefined()
    })

    it('initializes lastReadAt to epoch when undefined', () => {
      const state = makeState({ lastReadAt: undefined })
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN)
      expect(result.lastReadAt).toEqual(new Date(0))
    })

    it('preserves existing lastReadAt', () => {
      const existing = new Date('2025-01-10T00:00:00Z')
      const state = makeState({ lastReadAt: existing })
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN)
      expect(result.lastReadAt).toBe(existing)
    })
  })

  describe('room-specific options', () => {
    it('increments mentionsCount when incrementMentions is true', () => {
      const state = makeState()
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN, { incrementMentions: true })
      expect(result.mentionsCount).toBe(1)
      expect(result.unreadCount).toBe(1)
    })

    it('does not increment unread when incrementUnread is false', () => {
      const state = makeState()
      const msg = makeMsg()
      const result = onMessageReceived(state, msg, INACTIVE_HIDDEN, { incrementUnread: false })
      expect(result.unreadCount).toBe(0)
    })

    it('handles multiple increments correctly', () => {
      let state = makeState()
      state = onMessageReceived(state, makeMsg({ id: 'm1' }), INACTIVE_HIDDEN, { incrementMentions: true })
      state = onMessageReceived(state, makeMsg({ id: 'm2' }), INACTIVE_HIDDEN, { incrementMentions: false })
      state = onMessageReceived(state, makeMsg({ id: 'm3' }), INACTIVE_HIDDEN, { incrementMentions: true })
      expect(state.unreadCount).toBe(3)
      expect(state.mentionsCount).toBe(2)
    })
  })
})

// ---------------------------------------------------------------------------
// onActivate
// ---------------------------------------------------------------------------

describe('onActivate', () => {
  const messages: NotificationMessage[] = [
    makeMsg({ id: 'msg-1', timestamp: new Date('2025-01-15T09:00:00Z') }),
    makeMsg({ id: 'msg-2', timestamp: new Date('2025-01-15T09:30:00Z') }),
    makeMsg({ id: 'msg-3', timestamp: new Date('2025-01-15T10:00:00Z'), isOutgoing: true }),
    makeMsg({ id: 'msg-4', timestamp: new Date('2025-01-15T10:30:00Z') }),
    makeMsg({ id: 'msg-5', timestamp: new Date('2025-01-15T11:00:00Z') }),
  ]

  it('sets marker at first incoming message after lastSeenMessageId', () => {
    const state = makeState({ lastSeenMessageId: 'msg-2', unreadCount: 2 })
    const result = onActivate(state, messages)
    // msg-3 is outgoing, so marker should be at msg-4
    expect(result.firstNewMessageId).toBe('msg-4')
  })

  it('skips outgoing messages when finding marker position', () => {
    const state = makeState({ lastSeenMessageId: 'msg-2' })
    const result = onActivate(state, messages)
    expect(result.firstNewMessageId).toBe('msg-4') // skips msg-3 (outgoing)
  })

  it('skips delayed messages when finding marker position', () => {
    const msgs: NotificationMessage[] = [
      makeMsg({ id: 'a', timestamp: new Date('2025-01-15T09:00:00Z') }),
      makeMsg({ id: 'b', timestamp: new Date('2025-01-15T09:30:00Z'), isDelayed: true }),
      makeMsg({ id: 'c', timestamp: new Date('2025-01-15T10:00:00Z') }),
    ]
    const state = makeState({ lastSeenMessageId: 'a' })
    const result = onActivate(state, msgs)
    expect(result.firstNewMessageId).toBe('c')
  })

  it('sets no marker when lastSeenMessageId is the last message', () => {
    const state = makeState({ lastSeenMessageId: 'msg-5' })
    const result = onActivate(state, messages)
    expect(result.firstNewMessageId).toBeUndefined()
  })

  it('clears unreadCount and mentionsCount', () => {
    const state = makeState({ unreadCount: 5, mentionsCount: 2, lastSeenMessageId: 'msg-2' })
    const result = onActivate(state, messages)
    expect(result.unreadCount).toBe(0)
    expect(result.mentionsCount).toBe(0)
  })

  it('updates lastReadAt to last message timestamp', () => {
    const state = makeState({ lastSeenMessageId: 'msg-2' })
    const result = onActivate(state, messages)
    expect(result.lastReadAt).toEqual(new Date('2025-01-15T11:00:00Z'))
  })

  it('preserves lastSeenMessageId', () => {
    const state = makeState({ lastSeenMessageId: 'msg-2' })
    const result = onActivate(state, messages)
    expect(result.lastSeenMessageId).toBe('msg-2')
  })

  it('handles empty messages array', () => {
    const state = makeState({ lastSeenMessageId: 'msg-1', unreadCount: 3 })
    const result = onActivate(state, [])
    expect(result.firstNewMessageId).toBeUndefined()
    expect(result.unreadCount).toBe(0)
  })

  describe('when lastSeenMessageId not in loaded messages (older than memory)', () => {
    it('sets marker to first incoming when there are unread', () => {
      const state = makeState({ lastSeenMessageId: 'very-old-msg', unreadCount: 3 })
      const result = onActivate(state, messages)
      expect(result.firstNewMessageId).toBe('msg-1') // first non-outgoing, non-delayed
    })

    it('sets no marker when no unread', () => {
      const state = makeState({ lastSeenMessageId: 'very-old-msg', unreadCount: 0 })
      const result = onActivate(state, messages)
      expect(result.firstNewMessageId).toBeUndefined()
    })
  })

  describe('migration path (no lastSeenMessageId, fall back to lastReadAt)', () => {
    it('finds marker using lastReadAt when no lastSeenMessageId', () => {
      const state = makeState({ lastReadAt: new Date('2025-01-15T09:15:00Z') })
      const result = onActivate(state, messages)
      // First message with timestamp > 09:15 and not outgoing = msg-2 (09:30)
      expect(result.firstNewMessageId).toBe('msg-2')
    })

    it('handles no lastReadAt and no lastSeenMessageId', () => {
      const state = makeState()
      const result = onActivate(state, messages)
      expect(result.firstNewMessageId).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// onDeactivate
// ---------------------------------------------------------------------------

describe('onDeactivate', () => {
  it('clears firstNewMessageId', () => {
    const state = makeState({ firstNewMessageId: 'marker-1', unreadCount: 0 })
    const result = onDeactivate(state)
    expect(result.firstNewMessageId).toBeUndefined()
  })

  it('returns same reference when no marker to clear', () => {
    const state = makeState()
    const result = onDeactivate(state)
    expect(result).toBe(state)
  })

  it('preserves other fields', () => {
    const state = makeState({
      unreadCount: 3,
      mentionsCount: 1,
      lastReadAt: new Date(),
      lastSeenMessageId: 'seen-1',
      firstNewMessageId: 'marker-1',
    })
    const result = onDeactivate(state)
    expect(result.unreadCount).toBe(3)
    expect(result.mentionsCount).toBe(1)
    expect(result.lastSeenMessageId).toBe('seen-1')
  })
})

// ---------------------------------------------------------------------------
// onMarkAsRead
// ---------------------------------------------------------------------------

describe('onMarkAsRead', () => {
  it('clears unreadCount and mentionsCount', () => {
    const state = makeState({ unreadCount: 5, mentionsCount: 2 })
    const ts = new Date('2025-01-15T12:00:00Z')
    const result = onMarkAsRead(state, ts)
    expect(result.unreadCount).toBe(0)
    expect(result.mentionsCount).toBe(0)
    expect(result.lastReadAt).toEqual(ts)
  })

  it('preserves firstNewMessageId', () => {
    const state = makeState({ firstNewMessageId: 'marker-1', unreadCount: 1 })
    const result = onMarkAsRead(state, new Date())
    expect(result.firstNewMessageId).toBe('marker-1')
  })

  it('returns same reference when nothing to change', () => {
    const ts = new Date('2025-01-15T12:00:00Z')
    const state = makeState({ unreadCount: 0, mentionsCount: 0, lastReadAt: ts })
    const result = onMarkAsRead(state, ts)
    expect(result).toBe(state)
  })

  it('uses current time when no timestamp provided', () => {
    const before = Date.now()
    const state = makeState({ unreadCount: 1 })
    const result = onMarkAsRead(state)
    const after = Date.now()
    expect(result.lastReadAt!.getTime()).toBeGreaterThanOrEqual(before)
    expect(result.lastReadAt!.getTime()).toBeLessThanOrEqual(after)
  })
})

// ---------------------------------------------------------------------------
// onClearMarker
// ---------------------------------------------------------------------------

describe('onClearMarker', () => {
  it('clears firstNewMessageId', () => {
    const state = makeState({ firstNewMessageId: 'marker-1' })
    const result = onClearMarker(state)
    expect(result.firstNewMessageId).toBeUndefined()
  })

  it('returns same reference when no marker', () => {
    const state = makeState()
    const result = onClearMarker(state)
    expect(result).toBe(state)
  })

  it('preserves other fields', () => {
    const state = makeState({
      unreadCount: 3,
      lastSeenMessageId: 'seen-1',
      firstNewMessageId: 'marker-1',
    })
    const result = onClearMarker(state)
    expect(result.unreadCount).toBe(3)
    expect(result.lastSeenMessageId).toBe('seen-1')
  })
})

// ---------------------------------------------------------------------------
// onWindowBecameVisible
// ---------------------------------------------------------------------------

describe('onWindowBecameVisible', () => {
  it('clears unread and mentions for active entity', () => {
    const state = makeState({ unreadCount: 5, mentionsCount: 2 })
    const ts = new Date('2025-01-15T12:00:00Z')
    const result = onWindowBecameVisible(state, true, ts)
    expect(result.unreadCount).toBe(0)
    expect(result.mentionsCount).toBe(0)
    expect(result.lastReadAt).toEqual(ts)
  })

  it('returns same reference for non-active entity', () => {
    const state = makeState({ unreadCount: 5 })
    const result = onWindowBecameVisible(state, false)
    expect(result).toBe(state)
  })

  it('returns same reference when already read', () => {
    const state = makeState({ unreadCount: 0, mentionsCount: 0 })
    const result = onWindowBecameVisible(state, true)
    expect(result).toBe(state)
  })

  it('preserves marker and lastSeenMessageId', () => {
    const state = makeState({
      unreadCount: 3,
      firstNewMessageId: 'marker-1',
      lastSeenMessageId: 'seen-1',
    })
    const result = onWindowBecameVisible(state, true, new Date())
    expect(result.firstNewMessageId).toBe('marker-1')
    expect(result.lastSeenMessageId).toBe('seen-1')
  })
})

// ---------------------------------------------------------------------------
// onMessageSeen
// ---------------------------------------------------------------------------

describe('onMessageSeen', () => {
  const messages = [
    { id: 'msg-1' },
    { id: 'msg-2' },
    { id: 'msg-3' },
    { id: 'msg-4' },
    { id: 'msg-5' },
  ]

  it('sets lastSeenMessageId when none exists', () => {
    const state = makeState()
    const result = onMessageSeen(state, 'msg-3', messages)
    expect(result.lastSeenMessageId).toBe('msg-3')
  })

  it('advances forward', () => {
    const state = makeState({ lastSeenMessageId: 'msg-2' })
    const result = onMessageSeen(state, 'msg-4', messages)
    expect(result.lastSeenMessageId).toBe('msg-4')
  })

  it('does not go backwards', () => {
    const state = makeState({ lastSeenMessageId: 'msg-4' })
    const result = onMessageSeen(state, 'msg-2', messages)
    expect(result).toBe(state)
  })

  it('returns same reference for same message', () => {
    const state = makeState({ lastSeenMessageId: 'msg-3' })
    const result = onMessageSeen(state, 'msg-3', messages)
    expect(result).toBe(state)
  })

  it('preserves other fields', () => {
    const state = makeState({
      unreadCount: 3,
      firstNewMessageId: 'marker-1',
      lastSeenMessageId: 'msg-1',
    })
    const result = onMessageSeen(state, 'msg-3', messages)
    expect(result.unreadCount).toBe(3)
    expect(result.firstNewMessageId).toBe('marker-1')
  })
})

// ---------------------------------------------------------------------------
// shouldNotifyConversation
// ---------------------------------------------------------------------------

describe('shouldNotifyConversation', () => {
  it('returns true for incoming message when user cannot see it', () => {
    const msg = makeMsg()
    expect(shouldNotifyConversation(msg, INACTIVE_VISIBLE)).toBe(true)
    expect(shouldNotifyConversation(msg, INACTIVE_HIDDEN)).toBe(true)
    expect(shouldNotifyConversation(msg, ACTIVE_HIDDEN)).toBe(true)
  })

  it('returns false when user sees it (active + visible)', () => {
    expect(shouldNotifyConversation(makeMsg(), ACTIVE_VISIBLE)).toBe(false)
  })

  it('returns false for outgoing messages', () => {
    expect(shouldNotifyConversation(makeMsg({ isOutgoing: true }), INACTIVE_HIDDEN)).toBe(false)
  })

  it('returns false for delayed messages', () => {
    expect(shouldNotifyConversation(makeMsg({ isDelayed: true }), INACTIVE_HIDDEN)).toBe(false)
  })

  it('returns false for stale messages (>5 minutes old)', () => {
    const staleTimestamp = new Date(Date.now() - 6 * 60 * 1000)
    expect(shouldNotifyConversation(makeMsg({ timestamp: staleTimestamp }), INACTIVE_HIDDEN)).toBe(false)
  })

  it('returns true for fresh messages (<5 minutes old)', () => {
    const freshTimestamp = new Date(Date.now() - 60 * 1000)
    expect(shouldNotifyConversation(makeMsg({ timestamp: freshTimestamp }), INACTIVE_HIDDEN)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// shouldNotifyRoom
// ---------------------------------------------------------------------------

describe('shouldNotifyRoom', () => {
  it('notifies for mention even when notifyAll is false', () => {
    const msg = makeMsg({ isMention: true })
    const result = shouldNotifyRoom(msg, INACTIVE_HIDDEN, false)
    expect(result.shouldNotify).toBe(true)
    expect(result.isMention).toBe(true)
  })

  it('notifies for non-mention when notifyAll is true', () => {
    const msg = makeMsg()
    const result = shouldNotifyRoom(msg, INACTIVE_HIDDEN, true)
    expect(result.shouldNotify).toBe(true)
    expect(result.isMention).toBe(false)
  })

  it('does not notify for non-mention when notifyAll is false', () => {
    const msg = makeMsg()
    const result = shouldNotifyRoom(msg, INACTIVE_HIDDEN, false)
    expect(result.shouldNotify).toBe(false)
  })

  it('does not notify when user sees it', () => {
    const msg = makeMsg({ isMention: true })
    const result = shouldNotifyRoom(msg, ACTIVE_VISIBLE, true)
    expect(result.shouldNotify).toBe(false)
  })

  it('does not notify for outgoing', () => {
    const result = shouldNotifyRoom(makeMsg({ isOutgoing: true }), INACTIVE_HIDDEN, true)
    expect(result.shouldNotify).toBe(false)
  })

  it('does not notify for delayed', () => {
    const result = shouldNotifyRoom(makeMsg({ isDelayed: true }), INACTIVE_HIDDEN, true)
    expect(result.shouldNotify).toBe(false)
  })

  it('does not notify for stale messages', () => {
    const staleTimestamp = new Date(Date.now() - 6 * 60 * 1000)
    const result = shouldNotifyRoom(makeMsg({ timestamp: staleTimestamp, isMention: true }), INACTIVE_HIDDEN, true)
    expect(result.shouldNotify).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeBadgeCount
// ---------------------------------------------------------------------------

describe('computeBadgeCount', () => {
  it('sums all sources', () => {
    expect(computeBadgeCount({
      conversationsUnreadCount: 3,
      roomsWithUnreadCount: 2,
      eventsPendingCount: 1,
    })).toBe(6)
  })

  it('returns 0 when all sources are 0', () => {
    expect(computeBadgeCount({
      conversationsUnreadCount: 0,
      roomsWithUnreadCount: 0,
      eventsPendingCount: 0,
    })).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// createInitialNotificationState
// ---------------------------------------------------------------------------

describe('createInitialNotificationState', () => {
  it('returns clean initial state', () => {
    const state = createInitialNotificationState()
    expect(state.unreadCount).toBe(0)
    expect(state.mentionsCount).toBe(0)
    expect(state.lastReadAt).toBeUndefined()
    expect(state.lastSeenMessageId).toBeUndefined()
    expect(state.firstNewMessageId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Integration: full lifecycle sequences
// ---------------------------------------------------------------------------

describe('lifecycle sequences', () => {
  it('conversation with unread → open → see → switch away', () => {
    const messages = [
      makeMsg({ id: 'm1', timestamp: new Date('2025-01-15T09:00:00Z') }),
      makeMsg({ id: 'm2', timestamp: new Date('2025-01-15T09:30:00Z') }),
      makeMsg({ id: 'm3', timestamp: new Date('2025-01-15T10:00:00Z') }),
    ]

    // Start: user has seen m1, messages m2 and m3 arrived while away
    let state = makeState({ lastSeenMessageId: 'm1', unreadCount: 2 })

    // User opens conversation
    state = onActivate(state, messages)
    expect(state.firstNewMessageId).toBe('m2')
    expect(state.unreadCount).toBe(0)

    // User scrolls and sees m2 and m3 via viewport
    state = onMessageSeen(state, 'm2', messages)
    state = onMessageSeen(state, 'm3', messages)
    expect(state.lastSeenMessageId).toBe('m3')

    // User switches away
    state = onDeactivate(state)
    expect(state.firstNewMessageId).toBeUndefined()
    expect(state.lastSeenMessageId).toBe('m3')
  })

  it('message arrives while window hidden → window refocuses', () => {
    let state = makeState({ lastSeenMessageId: 'm1' })
    const msg = makeMsg({ id: 'm2', timestamp: new Date('2025-01-15T10:00:00Z') })

    // Message arrives while active but window hidden
    state = onMessageReceived(state, msg, ACTIVE_HIDDEN)
    expect(state.unreadCount).toBe(1)
    expect(state.firstNewMessageId).toBe('m2')

    // Window becomes visible
    state = onWindowBecameVisible(state, true, msg.timestamp)
    expect(state.unreadCount).toBe(0)
    expect(state.firstNewMessageId).toBe('m2') // marker preserved for visual
  })

  it('outgoing message clears everything consistently', () => {
    let state = makeState({
      unreadCount: 5,
      mentionsCount: 2,
      firstNewMessageId: 'old-marker',
      lastSeenMessageId: 'seen-1',
    })

    const outgoing = makeMsg({ id: 'out-1', isOutgoing: true })
    state = onMessageReceived(state, outgoing, ACTIVE_VISIBLE)
    expect(state.unreadCount).toBe(0)
    expect(state.mentionsCount).toBe(0)
    expect(state.firstNewMessageId).toBeUndefined()
    expect(state.lastSeenMessageId).toBe('seen-1') // preserved
  })

  it('room with mentions and notifyAll', () => {
    let state = makeState()

    // Regular message (no mention)
    state = onMessageReceived(state, makeMsg({ id: 'm1' }), INACTIVE_HIDDEN, {
      incrementUnread: true,
      incrementMentions: false,
    })
    expect(state.unreadCount).toBe(1)
    expect(state.mentionsCount).toBe(0)

    // Mention message
    state = onMessageReceived(state, makeMsg({ id: 'm2', isMention: true }), INACTIVE_HIDDEN, {
      incrementUnread: true,
      incrementMentions: true,
    })
    expect(state.unreadCount).toBe(2)
    expect(state.mentionsCount).toBe(1)

    // Outgoing clears both
    state = onMessageReceived(state, makeMsg({ id: 'm3', isOutgoing: true }), ACTIVE_VISIBLE)
    expect(state.unreadCount).toBe(0)
    expect(state.mentionsCount).toBe(0)
  })
})
